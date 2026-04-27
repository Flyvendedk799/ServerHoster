import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { StatusBadge } from "../components/StatusBadge";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";
import { Copy, Database, FileClock, Link2, Play, RotateCw, ScrollText, Shield, Square, Trash2 } from "lucide-react";

type DatabaseRow = {
  id: string;
  project_id: string;
  name: string;
  engine: "postgres" | "mysql" | "redis" | "mongo";
  port: number;
  connection_string: string;
  container_status?: { state: string; health?: string | null; startedAt?: string | null };
};

type Project = { id: string; name: string };
type Service = { id: string; name: string; project_id?: string; linked_database_id?: string };
type Backup = { id: string; filename: string; size_bytes: number; created_at: string };

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function DatabasesPage() {
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [selectedDbId, setSelectedDbId] = useState<string>("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [dbLogs, setDbLogs] = useState("");
  const [seedSql, setSeedSql] = useState("");

  async function load(): Promise<void> {
    try {
      const [dbs, projs, svcs] = await Promise.all([
        api<DatabaseRow[]>("/databases"),
        api<Project[]>("/projects"),
        api<Service[]>("/services")
      ]);
      setRows(dbs);
      setProjects(projs);
      setServices(svcs);
    } catch { /* toasted */ }
  }

  useEffect(() => {
    void load();
    const intv = setInterval(() => void load(), 15000);
    return () => clearInterval(intv);
  }, []);

  useEffect(() => {
    if (!selectedDbId) {
      setBackups([]);
      setDbLogs("");
      return;
    }
    void api<Backup[]>(`/databases/${selectedDbId}/backups`).then(setBackups).catch(() => undefined);
    void api<{ logs: string }>(`/databases/${selectedDbId}/logs?tail=160`).then((res) => setDbLogs(res.logs)).catch(() => undefined);
  }, [selectedDbId]);

  async function dbAction(id: string, action: "start" | "stop" | "restart"): Promise<void> {
    try {
      await api(`/databases/${id}/${action}`, { method: "POST" });
      toast.success(`${action} sent`);
      await load();
    } catch { /* toasted */ }
  }

  async function deleteDb(db: DatabaseRow): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete database "${db.name}"?`,
      message: "This removes the container and all backups tracked by SURVHub.",
      danger: true,
      confirmLabel: "Delete"
    });
    if (!ok) return;
    try {
      await api(`/databases/${db.id}`, { method: "DELETE" });
      toast.success(`Deleted ${db.name}`);
      if (selectedDbId === db.id) setSelectedDbId("");
      await load();
    } catch { /* toasted */ }
  }

  async function copyConnection(db: DatabaseRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(db.connection_string);
      toast.success("Connection string copied");
    } catch { toast.error("Clipboard failed"); }
  }

  async function runBackup(id: string): Promise<void> {
    try {
      const res = await api<{ size: number }>(`/databases/${id}/backup`, { method: "POST" });
      toast.success(`Backup created (${fmtSize(res.size)})`);
      const bks = await api<Backup[]>(`/databases/${id}/backups`);
      setBackups(bks);
    } catch { /* toasted */ }
  }

  async function runRestore(dbId: string, backupId: string): Promise<void> {
    const ok = await confirmDialog({
      title: "Restore from backup?",
      message: "This will overwrite current data.",
      danger: true,
      confirmLabel: "Restore"
    });
    if (!ok) return;
    try {
      await api(`/databases/${dbId}/restore`, { method: "POST", body: JSON.stringify({ backupId }) });
      toast.success("Restore completed");
    } catch { /* toasted */ }
  }

  async function runSeed(dbId: string): Promise<void> {
    if (!seedSql.trim()) return;
    const ok = await confirmDialog({
      title: "Execute SQL seed?",
      message: "This runs the current SQL against the selected database.",
      danger: true,
      confirmLabel: "Execute"
    });
    if (!ok) return;
    try {
      const res = await api<{ output?: string }>(`/databases/${dbId}/seed`, {
        method: "POST",
        body: JSON.stringify({ sql: seedSql })
      });
      setDbLogs(res.output ?? "Seed completed successfully.");
      toast.success("SQL executed");
    } catch { /* toasted */ }
  }

  async function linkService(serviceId: string, databaseId: string | null): Promise<void> {
    try {
      await api("/databases/link", { method: "POST", body: JSON.stringify({ serviceId, databaseId }) });
      toast.success(databaseId ? "Linked" : "Unlinked");
      await load();
    } catch { /* toasted */ }
  }

  const selectedDb = rows.find((r) => r.id === selectedDbId);
  const runningCount = rows.filter((row) => row.container_status?.state === "running").length;
  const linkedServices = selectedDb ? services.filter((service) => service.linked_database_id === selectedDb.id) : [];

  return (
    <div className="databases-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Databases</h2>
          <p className="muted">Managed persistence for your app stacks, with safe runtime controls.</p>
        </div>
        <button className="primary" onClick={() => setShowModal(true)}><Database size={18} /> Provision DB</button>
      </header>

      <section className="database-summary">
        <div className="database-summary-item">
          <Database size={18} />
          <strong>{rows.length}</strong>
          <span>Total databases</span>
        </div>
        <div className="database-summary-item">
          <Shield size={18} />
          <strong>{runningCount}</strong>
          <span>Running now</span>
        </div>
        <div className="database-summary-item">
          <Link2 size={18} />
          <strong>{services.filter((service) => service.linked_database_id).length}</strong>
          <span>Service links</span>
        </div>
      </section>

      <div className="grid">
        {rows.length === 0 ? (
          <div className="card text-center" style={{ gridColumn: "1 / -1", padding: "4rem" }}>
            <div className="muted" style={{ marginBottom: "1rem" }}>No database instances provisioned.</div>
            <button className="primary" onClick={() => setShowModal(true)}>Create your first database</button>
          </div>
        ) : (
          rows.map((row) => {
            const state = row.container_status?.state ?? "stopped";
            const proj = projects.find(p => p.id === row.project_id);
            return (
              <div
                key={row.id}
                className={`card service-card ${selectedDbId === row.id ? 'active-border' : ''}`}
                onClick={() => setSelectedDbId(row.id)}
                style={selectedDbId === row.id ? { border: "1px solid var(--accent)", boxShadow: "var(--shadow-lg)" } : {}}
              >
                <div className="env-tag">{row.engine}</div>
                <div className="service-header">
                  <div className="service-title-group">
                    <h3>{row.name}</h3>
                    <div className="service-meta muted tiny">Project: {proj?.name ?? 'Default'}</div>
                  </div>
                  <div className="row">
                    <StatusBadge status={state} dotOnly />
                    <span className="chip xsmall">Port {row.port}</span>
                    {row.container_status?.health && <span className="chip xsmall">{row.container_status.health}</span>}
                  </div>
                </div>

                <div className="service-body">
                   <div className="connection-string font-mono tiny text-truncate" onClick={() => void copyConnection(row)} data-tooltip="Copy connection string">
                    {row.connection_string}
                   </div>
                   <div className="database-linked-services">
                    {services.filter(s => s.linked_database_id === row.id).length === 0 ? (
                      <span className="muted tiny">No services linked yet</span>
                    ) : (
                      services.filter(s => s.linked_database_id === row.id).map((service) => (
                        <span key={service.id} className="stack-service-pill"><Link2 size={11} /> {service.name}</span>
                      ))
                    )}
                   </div>
                </div>

                <div className="service-footer">
                  <button className="ghost xsmall" onClick={(e) => { e.stopPropagation(); void dbAction(row.id, "start"); }} data-tooltip="Start database"><Play size={14} /></button>
                  <button className="ghost xsmall" onClick={(e) => { e.stopPropagation(); void dbAction(row.id, "stop"); }} data-tooltip="Stop database"><Square size={14} /></button>
                  <button className="ghost xsmall" onClick={(e) => { e.stopPropagation(); void dbAction(row.id, "restart"); }} data-tooltip="Restart database"><RotateCw size={14} /></button>
                  <button className="ghost xsmall" onClick={(e) => { e.stopPropagation(); void copyConnection(row); }} data-tooltip="Copy URL"><Copy size={14} /></button>
                  <button className="ghost logout xsmall" style={{ marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); void deleteDb(row); }} data-tooltip="Delete database"><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {selectedDb && (
        <section className="card management-panel" style={{ marginTop: "3rem" }}>
          <header className="section-title">
            <div className="row">
              <Database size={18} />
              <h3>Database Console: {selectedDb.name}</h3>
              <StatusBadge status={selectedDb.container_status?.state ?? "stopped"} />
            </div>
            <div className="row">
              <button onClick={() => void dbAction(selectedDb.id, "start")}><Play size={16} /> Start</button>
              <button onClick={() => void dbAction(selectedDb.id, "restart")}><RotateCw size={16} /> Restart</button>
              <button onClick={() => void runBackup(selectedDb.id)}><FileClock size={16} /> Manual Backup</button>
            </div>
          </header>

          <div className="database-console-strip">
            <div>
              <span>Connection</span>
              <button className="connection-copy" onClick={() => void copyConnection(selectedDb)}>{selectedDb.connection_string}</button>
            </div>
            <div>
              <span>Linked services</span>
              <strong>{linkedServices.length || "None"}</strong>
            </div>
            <div>
              <span>Container</span>
              <strong>{selectedDb.container_status?.health ?? selectedDb.container_status?.state ?? "unknown"}</strong>
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
             <div className="sub-section">
                <h4 className="metric-label">Recent Backups</h4>
                <div className="list">
                  {backups.length === 0 ? <p className="muted small italic">No snapshots found.</p> : backups.map(b => (
                    <div key={b.id} className="list-item row between small">
                      <div>
                        <div className="font-semibold">{b.filename.slice(0, 15)}...</div>
                        <div className="tiny muted">{fmtSize(b.size_bytes)} • {new Date(b.created_at).toLocaleDateString()}</div>
                      </div>
                      <button className="ghost tiny" onClick={() => void runRestore(selectedDb.id, b.id)}>Restore</button>
                    </div>
                  ))}
                </div>
             </div>

             <div className="sub-section">
                <h4 className="metric-label">Service Linking</h4>
                <div className="list">
                  {services.map(s => (
                    <div key={s.id} className="list-item row between small">
                      <span>{s.name}</span>
                      <button 
                        className={`ghost tiny ${s.linked_database_id === selectedDb.id ? 'logout' : ''}`}
                        onClick={() => void linkService(s.id, s.linked_database_id === selectedDb.id ? null : selectedDb.id)}
                      >
                        {s.linked_database_id === selectedDb.id ? 'Unlink' : 'Link'}
                      </button>
                    </div>
                  ))}
                </div>
             </div>
          </div>

          {(selectedDb.engine === "postgres" || selectedDb.engine === "mysql") && (
            <div className="seed-section" style={{ marginTop: "2rem", paddingTop: "2rem", borderTop: "1px solid var(--border-subtle)" }}>
              <h4 className="metric-label">Seed SQL</h4>
              <textarea
                placeholder="-- Execute SQL command"
                value={seedSql}
                onChange={(e) => setSeedSql(e.target.value)}
                rows={4}
              />
              <button disabled={!seedSql.trim()} onClick={() => void runSeed(selectedDb.id)} style={{ marginTop: "1rem" }}>Execute SQL</button>
            </div>
          )}

          {dbLogs && (
            <div className="logs-section" style={{ marginTop: "2rem", paddingTop: "2rem", borderTop: "1px solid var(--border-subtle)" }}>
              <h4 className="metric-label"><ScrollText size={14} /> Container Logs</h4>
              <div className="logs-viewer" style={{ height: "150px" }}>{dbLogs}</div>
            </div>
          )}
        </section>
      )}

      {showModal && <CreateDatabaseModal projects={projects} onClose={() => setShowModal(false)} onCreated={() => void load()} />}

      <style dangerouslySetInnerHTML={{ __html: `
        .databases-page .database-summary {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .databases-page .database-summary-item {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 0.25rem 0.75rem;
          align-items: center;
          padding: 1rem;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-card);
        }
        .databases-page .database-summary-item svg {
          grid-row: span 2;
          color: var(--accent);
        }
        .databases-page .database-summary-item strong {
          color: var(--text-primary);
          font-size: 1.4rem;
          line-height: 1;
        }
        .databases-page .database-summary-item span {
          color: var(--text-muted);
          font-size: 0.75rem;
        }
        .databases-page .active-border { border-color: var(--accent) !important; }
        .databases-page .connection-string { 
          background: var(--bg-sunken); 
          padding: 0.5rem; 
          border-radius: var(--radius-sm); 
          cursor: copy;
          opacity: 0.7;
        }
        .databases-page .connection-string:hover { opacity: 1; color: var(--accent-light); }
        .databases-page .database-linked-services {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
          min-height: 1.65rem;
        }
        .databases-page .database-console-strip {
          display: grid;
          grid-template-columns: minmax(0, 2fr) repeat(2, minmax(140px, 1fr));
          gap: 1rem;
          margin: 1rem 0 2rem;
        }
        .databases-page .database-console-strip > div {
          padding: 1rem;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-sunken);
          min-width: 0;
        }
        .databases-page .database-console-strip span {
          display: block;
          color: var(--text-muted);
          font-size: 0.72rem;
          font-weight: 800;
          text-transform: uppercase;
          margin-bottom: 0.4rem;
        }
        .databases-page .connection-copy {
          max-width: 100%;
          padding: 0;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-size: 0.75rem;
          overflow: hidden;
          text-overflow: ellipsis;
          display: block;
        }
        .databases-page .list { display: flex; flex-direction: column; gap: 0.25rem; }
        .databases-page .list-item { padding: 0.5rem; border-bottom: 1px solid var(--border-subtle); }
        .databases-page .tiny { font-size: 0.7rem; }
        .databases-page .xsmall { padding: 0.2rem 0.5rem; font-size: 0.72rem; }
        @media (max-width: 760px) {
          .databases-page .database-console-strip { grid-template-columns: 1fr; }
        }
      `}} />
    </div>
  );
}
