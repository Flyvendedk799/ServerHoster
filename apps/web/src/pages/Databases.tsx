import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { StatusBadge } from "../components/StatusBadge";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";

type DatabaseRow = {
  id: string;
  project_id: string;
  name: string;
  engine: "postgres" | "mysql" | "redis" | "mongo";
  port: number;
  connection_string: string;
  username: string | null;
  password: string | null;
  database_name: string | null;
  container_status?: { state: string; startedAt: string | null; health: string | null };
};

type Project = { id: string; name: string };
type Service = { id: string; name: string; linked_database_id?: string };
type Backup = { id: string; filename: string; size_bytes: number; created_at: string };

const ENGINE_DEFAULT_PORT: Record<DatabaseRow["engine"], number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017
};

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
    } catch {
      /* toasted */
    }
  }

  useEffect(() => {
    void load();
    const intv = setInterval(() => void load(), 15000);
    return () => clearInterval(intv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedDbId) {
      setBackups([]);
      setDbLogs("");
      return;
    }
    void api<Backup[]>(`/databases/${selectedDbId}/backups`).then(setBackups).catch(() => undefined);
  }, [selectedDbId]);



  async function dbAction(id: string, action: "start" | "stop" | "restart"): Promise<void> {
    try {
      await api(`/databases/${id}/${action}`, { method: "POST" });
      toast.success(`${action} sent`);
      await load();
    } catch {
      /* toasted */
    }
  }

  async function deleteDb(db: DatabaseRow): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete database "${db.name}"?`,
      message: "This removes the container and all backups tracked by SURVHub.",
      details: ["The Docker volume is NOT deleted; recreate the DB to reuse it.", "Any service linked to this database will be unlinked."],
      danger: true,
      confirmLabel: "Delete"
    });
    if (!ok) return;
    try {
      await api(`/databases/${db.id}`, { method: "DELETE" });
      toast.success(`Deleted ${db.name}`);
      if (selectedDbId === db.id) setSelectedDbId("");
      await load();
    } catch {
      /* toasted */
    }
  }

  async function copyConnection(db: DatabaseRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(db.connection_string);
      toast.success("Connection string copied");
    } catch {
      toast.error("Clipboard write failed");
    }
  }

  async function loadLogs(id: string): Promise<void> {
    try {
      const res = await api<{ logs: string }>(`/databases/${id}/logs?tail=500`);
      setDbLogs(res.logs);
    } catch {
      /* toasted */
    }
  }

  async function runBackup(id: string): Promise<void> {
    try {
      const res = await api<{ id: string; path: string; size: number }>(`/databases/${id}/backup`, { method: "POST" });
      toast.success(`Backup created (${fmtSize(res.size)})`);
      const bks = await api<Backup[]>(`/databases/${id}/backups`);
      setBackups(bks);
    } catch {
      /* toasted */
    }
  }

  async function runRestore(dbId: string, backupId: string): Promise<void> {
    const ok = await confirmDialog({
      title: "Restore from this backup?",
      message: "This overwrites data in the database.",
      danger: true,
      confirmLabel: "Restore"
    });
    if (!ok) return;
    try {
      await api(`/databases/${dbId}/restore`, { method: "POST", body: JSON.stringify({ backupId }) });
      toast.success("Restore completed");
    } catch {
      /* toasted */
    }
  }

  async function runSeed(id: string): Promise<void> {
    if (!seedSql.trim()) {
      toast.error("Seed SQL is empty");
      return;
    }
    try {
      await api(`/databases/${id}/seed`, { method: "POST", body: JSON.stringify({ sql: seedSql }) });
      toast.success("Seed applied");
      setSeedSql("");
    } catch {
      /* toasted */
    }
  }

  async function linkService(serviceId: string, databaseId: string | null): Promise<void> {
    try {
      await api("/databases/link", {
        method: "POST",
        body: JSON.stringify({ serviceId, databaseId })
      });
      toast.success(databaseId ? "Service linked" : "Service unlinked");
      await load();
    } catch {
      /* toasted */
    }
  }

  const selectedDb = rows.find((r) => r.id === selectedDbId);

  function statusDot(state: string | undefined): string {
    if (state === "running") return "#10b981";
    if (state === "exited" || state === "stopped") return "#ef4444";
    return "#64748b";
  }

  return (
    <section>
      <div className="row" style={{ marginBottom: "var(--space-6)", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Databases</h2>
        <button className="primary" onClick={() => setShowModal(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Instance
        </button>
      </div>

      <div className="grid" style={{ marginBottom: "var(--space-8)" }}>
        {rows.map((row) => {
          const state = row.container_status?.state;
          const proj = projects.find(p => p.id === row.project_id);
          return (
            <div
              key={row.id}
              className={`card elevated ${selectedDbId === row.id ? 'active-border' : ''}`}
              style={{
                cursor: "pointer",
                padding: "var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
                borderTop: `4px solid ${state === 'running' ? 'var(--success)' : 'var(--danger)'}`,
                boxShadow: selectedDbId === row.id ? 'var(--shadow-glow)' : 'var(--shadow-sm)'
              }}
              onClick={() => setSelectedDbId(row.id)}
            >
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 style={{ margin: 0 }}>{row.name}</h3>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.1rem" }}>{proj?.name ?? 'Unknown Project'}</div>
                </div>
                <span className="chip" style={{ fontSize: "0.65rem" }}>{row.engine}</span>
              </div>
              <div className="row" style={{ gap: "0.5rem" }}>
                <StatusBadge status={state || "stopped"} />
                <span className="chip" style={{ fontSize: "0.72rem" }}>Port {row.port}</span>
              </div>
              <div style={{ 
                fontSize: "0.72rem", 
                color: "var(--text-muted)", 
                background: "var(--bg-sunken)", 
                padding: "0.5rem", 
                borderRadius: "var(--radius-sm)", 
                fontFamily: "var(--font-mono)",
                wordBreak: "break-all",
                marginTop: "0.2rem"
              }}>
                {row.connection_string}
              </div>
              <div className="row" style={{ gap: "0.4rem", marginTop: "auto", paddingTop: "var(--space-2)" }}>
                <button className="ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }} onClick={(e) => { e.stopPropagation(); void dbAction(row.id, "restart"); }}>↻</button>
                <button className="ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }} onClick={(e) => { e.stopPropagation(); void copyConnection(row); }}>Copy</button>
                <button className="ghost btn-danger" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem", marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); void deleteDb(row); }}>Delete</button>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <p style={{ color: "var(--text-dim)", padding: "var(--space-6)", textAlign: "center" }}>No database instances provisioned.</p>}
      </div>

      {selectedDb && (
        <div className="card elevated" style={{ border: "1px solid var(--accent-soft)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-6)" }}>
            <h3 style={{ margin: 0 }}>Management: {selectedDb.name}</h3>
            <div className="row">
               <button onClick={() => void loadLogs(selectedDb.id)}>Tail Logs</button>
               <button className="primary" onClick={() => void runBackup(selectedDb.id)}>Create Backup</button>
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--space-6)" }}>
            <div>
              <div className="metric-label" style={{ marginBottom: "var(--space-3)" }}>Backups ({backups.length})</div>
              {backups.length === 0 && <p style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No backups yet.</p>}
              <div style={{ display: "grid", gap: "var(--space-2)", maxHeight: "300px", overflowY: "auto" }}>
                {backups.map((b) => (
                  <div key={b.id} className="row" style={{ justifyContent: "space-between", padding: "0.5rem", background: "var(--bg-sunken)", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{b.filename.slice(0, 20)}...</span>
                      <span style={{ color: "var(--text-dim)", fontSize: "0.72rem" }}>{new Date(b.created_at).toLocaleString()} • {fmtSize(b.size_bytes)}</span>
                    </div>
                    <button className="ghost" style={{ padding: "0.3rem 0.5rem", fontSize: "0.7rem" }} onClick={() => void runRestore(selectedDb.id, b.id)}>Restore</button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="metric-label" style={{ marginBottom: "var(--space-3)" }}>Linked Services</div>
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {services.map((service) => (
                  <div key={service.id} className="row" style={{ justifyContent: "space-between", padding: "0.5rem", background: "var(--bg-sunken)", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
                    <span style={{ fontWeight: 500 }}>{service.name}</span>
                    <button 
                      className={service.linked_database_id === selectedDb.id ? "ghost btn-danger" : "ghost"} 
                      style={{ padding: "0.3rem 0.5rem", fontSize: "0.7rem" }}
                      onClick={() => void linkService(service.id, service.linked_database_id === selectedDb.id ? null : selectedDb.id)}
                    >
                      {service.linked_database_id === selectedDb.id ? "Unlink" : "Link"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {(selectedDb.engine === "postgres" || selectedDb.engine === "mysql") && (
            <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-6)", borderTop: "1px solid var(--border-subtle)" }}>
              <div className="metric-label" style={{ marginBottom: "var(--space-2)" }}>Seed SQL</div>
              <textarea
                rows={5}
                placeholder="-- Paste SQL to seed the database"
                value={seedSql}
                onChange={(e) => setSeedSql(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: "0.85rem", background: "var(--bg-sunken)" }}
              />
              <button disabled={!seedSql.trim()} style={{ marginTop: "var(--space-2)" }} onClick={() => void runSeed(selectedDb.id)}>Apply Seed SQL</button>
            </div>
          )}

          {dbLogs && (
            <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-6)", borderTop: "1px solid var(--border-subtle)" }}>
              <div className="metric-label" style={{ marginBottom: "var(--space-2)" }}>Container Logs (Tail)</div>
              <pre style={{ margin: 0, maxHeight: "300px", padding: "var(--space-3)" }}>{dbLogs}</pre>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <CreateDatabaseModal
          projects={projects}
          onClose={() => setShowModal(false)}
          onCreated={() => void load()}
        />
      )}
    </section>
  );
}
