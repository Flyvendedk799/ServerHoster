import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { StatusBadge } from "../components/StatusBadge";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";
import { PromoteEmbeddedDbModal, type EmbeddedDb } from "../components/PromoteEmbeddedDbModal";
import { TransferDatabaseModal } from "../components/TransferDatabaseModal";
import { SqlFileInput } from "../components/SqlFileInput";
import {
  AlertTriangle,
  Cloud,
  Copy,
  Database,
  Download,
  FileClock,
  HardDrive,
  Link2,
  Loader2,
  PackageOpen,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Shield,
  Sparkles,
  Square,
  Table,
  Trash2
} from "lucide-react";

type DatabaseRow = {
  id: string;
  project_id: string;
  name: string;
  engine: "postgres" | "mysql" | "redis" | "mongo";
  port: number;
  connection_string: string;
  container_status?: { state: string; health?: string | null; startedAt?: string | null };
  stats?: { size_bytes: number | null; last_backup_at: string | null };
};

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function backupAgeDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms / (1000 * 60 * 60 * 24);
}

type Project = { id: string; name: string };
type Service = { id: string; name: string; project_id?: string; linked_database_id?: string };
type Backup = { id: string; filename: string; size_bytes: number; created_at: string };
type OrphanService = {
  service_id: string;
  service_name: string;
  project_id: string | null;
  status: string;
  reason: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function groupRowsByProject(
  rows: DatabaseRow[],
  projects: Project[]
): Array<{ projectId: string | null; projectName: string; items: DatabaseRow[] }> {
  const byId = new Map<string | null, DatabaseRow[]>();
  for (const row of rows) {
    const key = row.project_id ?? null;
    const list = byId.get(key) ?? [];
    list.push(row);
    byId.set(key, list);
  }
  return Array.from(byId.entries())
    .map(([projectId, items]) => ({
      projectId,
      projectName: projects.find((p) => p.id === projectId)?.name ?? "Unassigned",
      items
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export function DatabasesPage() {
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [embedded, setEmbedded] = useState<EmbeddedDb[]>([]);
  const [orphans, setOrphans] = useState<OrphanService[]>([]);
  const [promoteTarget, setPromoteTarget] = useState<EmbeddedDb | null>(null);
  const [transferTarget, setTransferTarget] = useState<DatabaseRow | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedDbId, setSelectedDbId] = useState<string>("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [dbLogs, setDbLogs] = useState("");
  const [seedSql, setSeedSql] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [didLoadOnce, setDidLoadOnce] = useState(false);
  const [consoleTab, setConsoleTab] = useState<"overview" | "data" | "backups" | "sql" | "logs" | "linking">(
    "overview"
  );
  const [tables, setTables] = useState<
    Array<{ schema: string; name: string; row_estimate: number; size_bytes: number }>
  >([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [activeTable, setActiveTable] = useState<{ schema: string; name: string } | null>(null);
  const [tablePreview, setTablePreview] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
    truncatedTo: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function load(): Promise<void> {
    setRefreshing(true);
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
    // Embedded scan is best-effort: a docker-exec timeout shouldn't break the page.
    try {
      const [emb, orph] = await Promise.all([
        api<EmbeddedDb[]>("/databases/embedded"),
        api<OrphanService[]>("/databases/orphan-services")
      ]);
      setEmbedded(emb);
      setOrphans(orph);
    } catch {
      /* ignore */
    }
    setRefreshing(false);
    setDidLoadOnce(true);
  }

  /** Provision Postgres for a service that has no DB at all. Reuses the promote endpoint in managed mode. */
  async function provisionForService(orphan: OrphanService): Promise<void> {
    const ok = await confirmDialog({
      title: `Provision Postgres for ${orphan.service_name}?`,
      message: "Spins up a managed Postgres, links it, injects DATABASE_URL, and restarts the service.",
      confirmLabel: "Provision"
    });
    if (!ok) return;
    try {
      await api(`/databases/embedded/${orphan.service_id}/promote`, {
        method: "POST",
        body: JSON.stringify({ mode: "managed", restart: true })
      });
      toast.success(`Provisioned database for ${orphan.service_name}`);
      await load();
    } catch {
      /* toasted */
    }
  }

  async function downloadBackup(databaseId: string, backup: Backup): Promise<void> {
    try {
      const baseUrl = import.meta.env.VITE_SURVHUB_API_URL ?? "http://localhost:8787";
      const token = localStorage.getItem("survhub_token") ?? "";
      const res = await fetch(`${baseUrl}/databases/${databaseId}/backups/${backup.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backup.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function fmtEmbeddedSize(bytes: number): string {
    return fmtSize(bytes);
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
      setTables([]);
      setActiveTable(null);
      setTablePreview(null);
      return;
    }
    void api<Backup[]>(`/databases/${selectedDbId}/backups`)
      .then(setBackups)
      .catch(() => undefined);
    void api<{ logs: string }>(`/databases/${selectedDbId}/logs?tail=160`)
      .then((res) => setDbLogs(res.logs))
      .catch(() => undefined);
  }, [selectedDbId]);

  useEffect(() => {
    if (!selectedDb || consoleTab !== "data") return;
    if (selectedDb.engine !== "postgres" && selectedDb.engine !== "mysql") return;
    setTablesLoading(true);
    void api<typeof tables>(`/databases/${selectedDb.id}/tables`)
      .then((rows) => {
        setTables(rows);
        if (!activeTable && rows[0]) setActiveTable({ schema: rows[0].schema, name: rows[0].name });
      })
      .catch(() => setTables([]))
      .finally(() => setTablesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDbId, consoleTab]);

  useEffect(() => {
    if (!selectedDb || consoleTab !== "data" || !activeTable) return;
    setPreviewLoading(true);
    void api<typeof tablePreview>(
      `/databases/${selectedDb.id}/tables/${activeTable.schema}/${activeTable.name}/preview?limit=100`
    )
      .then((res) => setTablePreview(res))
      .catch(() => setTablePreview(null))
      .finally(() => setPreviewLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDbId, consoleTab, activeTable?.schema, activeTable?.name]);

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
      toast.error("Clipboard failed");
    }
  }

  async function runBackup(id: string): Promise<void> {
    try {
      const res = await api<{ size: number }>(`/databases/${id}/backup`, { method: "POST" });
      toast.success(`Backup created (${fmtSize(res.size)})`);
      const bks = await api<Backup[]>(`/databases/${id}/backups`);
      setBackups(bks);
    } catch {
      /* toasted */
    }
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
    } catch {
      /* toasted */
    }
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
    } catch {
      /* toasted */
    }
  }

  async function linkService(serviceId: string, databaseId: string | null): Promise<void> {
    try {
      await api("/databases/link", { method: "POST", body: JSON.stringify({ serviceId, databaseId }) });
      toast.success(databaseId ? "Linked" : "Unlinked");
      await load();
    } catch {
      /* toasted */
    }
  }

  const selectedDb = rows.find((r) => r.id === selectedDbId);
  const runningCount = rows.filter((row) => row.container_status?.state === "running").length;
  const linkedServices = selectedDb
    ? services.filter((service) => service.linked_database_id === selectedDb.id)
    : [];

  return (
    <div className="databases-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Databases</h2>
          <p className="muted">Managed persistence for your app stacks, with safe runtime controls.</p>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <button
            className="ghost"
            onClick={() => void load()}
            disabled={refreshing}
            data-tooltip="Re-scan databases and embedded persistence"
          >
            {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            <span>Refresh</span>
          </button>
          <button className="primary" onClick={() => setShowModal(true)}>
            <Database size={18} /> Provision DB
          </button>
        </div>
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
        <div className="database-summary-item">
          <HardDrive size={18} />
          <strong>{embedded.length}</strong>
          <span>Embedded (unmanaged)</span>
        </div>
      </section>

      {(embedded.length > 0 || orphans.length > 0) && (
        <section className="embedded-section">
          <header className="embedded-header">
            <div className="row">
              <HardDrive size={16} />
              <h3>Service persistence</h3>
              <span className="chip xsmall warn-chip">{embedded.length + orphans.length} unmanaged</span>
            </div>
            <p className="muted tiny">
              Services that don't yet have a managed database. Embedded SQLite files are listed when detected;
              services with no <code>DATABASE_URL</code> at all are listed below them. One click provisions a
              managed Postgres and links it.
            </p>
          </header>
          <div className="grid embedded-grid">
            {embedded.map((emb) => (
              <div key={`emb-${emb.service_id}`} className="card embedded-card">
                <div className="row between">
                  <div>
                    <h4>{emb.service_name}</h4>
                    <div className="muted tiny font-mono">{emb.file_path}</div>
                  </div>
                  <span className={`chip xsmall ${emb.persistent ? "" : "warn-chip"}`}>
                    {emb.persistent ? "Volume-backed" : "Ephemeral"}
                  </span>
                </div>
                <div className="embedded-meta">
                  <span>SQLite</span>
                  <span>{fmtEmbeddedSize(emb.size_bytes)}</span>
                  <span className="muted">{emb.container_name}</span>
                </div>
                {!emb.persistent && (
                  <div className="embedded-warning">
                    <AlertTriangle size={13} />
                    <span>No volume mount — data lost on container recreate.</span>
                  </div>
                )}
                <div className="row" style={{ marginTop: "0.75rem" }}>
                  <button className="primary xsmall" onClick={() => setPromoteTarget(emb)}>
                    <Sparkles size={13} /> Promote to managed
                  </button>
                </div>
              </div>
            ))}
            {orphans
              .filter((o) => !embedded.some((e) => e.service_id === o.service_id))
              .map((orph) => (
                <div key={`orph-${orph.service_id}`} className="card embedded-card">
                  <div className="row between">
                    <div>
                      <h4>{orph.service_name}</h4>
                      <div className="muted tiny">No DATABASE_URL configured</div>
                    </div>
                    <span className="chip xsmall warn-chip">No DB</span>
                  </div>
                  <div className="embedded-meta">
                    <span>Service status: {orph.status}</span>
                  </div>
                  <div className="row" style={{ marginTop: "0.75rem", gap: "0.5rem" }}>
                    <button className="primary xsmall" onClick={() => void provisionForService(orph)}>
                      <PackageOpen size={13} /> Provision Postgres
                    </button>
                    <button
                      className="ghost xsmall"
                      onClick={() =>
                        setPromoteTarget({
                          service_id: orph.service_id,
                          service_name: orph.service_name,
                          project_id: orph.project_id,
                          container_name: `survhub-${orph.service_id}`,
                          engine: "sqlite",
                          file_path: "(no embedded file detected)",
                          size_bytes: 0,
                          persistent: false,
                          missing_env: ["DATABASE_URL"]
                        })
                      }
                    >
                      Configure…
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {!didLoadOnce ? (
        <div className="grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card skeleton-card">
              <div className="skeleton-bar" style={{ width: "40%" }} />
              <div className="skeleton-bar" style={{ width: "75%" }} />
              <div className="skeleton-bar" style={{ width: "60%" }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="grid">
          <div className="card text-center" style={{ gridColumn: "1 / -1", padding: "4rem" }}>
            <div className="muted" style={{ marginBottom: "1rem" }}>
              No database instances provisioned.
            </div>
            <button className="primary" onClick={() => setShowModal(true)}>
              Create your first database
            </button>
          </div>
        </div>
      ) : (
        groupRowsByProject(rows, projects).map(({ projectId, projectName, items }) => (
          <section key={projectId ?? "unassigned"} className="db-project-group">
            <header className="db-project-group-header">
              <h4>{projectName}</h4>
              <span className="muted tiny">
                {items.length} database{items.length === 1 ? "" : "s"}
              </span>
            </header>
            <div className="grid">
              {items.map((row) => {
                const state = row.container_status?.state ?? "stopped";
                return (
                  <div
                    key={row.id}
                    className={`card service-card ${selectedDbId === row.id ? "active-border" : ""}`}
                    onClick={() => setSelectedDbId(row.id)}
                    style={
                      selectedDbId === row.id
                        ? { border: "1px solid var(--accent)", boxShadow: "var(--shadow-lg)" }
                        : {}
                    }
                  >
                    <div className="env-tag">{row.engine}</div>
                    <div className="service-header">
                      <div className="service-title-group">
                        <h3>{row.name}</h3>
                        <div className="service-meta muted tiny">Project: {projectName}</div>
                      </div>
                      <div className="row">
                        <StatusBadge status={state} dotOnly />
                        <span className="chip xsmall">Port {row.port}</span>
                        {row.container_status?.health && (
                          <span className="chip xsmall">{row.container_status.health}</span>
                        )}
                      </div>
                    </div>

                    <div className="service-body">
                      <div
                        className="connection-string font-mono tiny text-truncate"
                        onClick={() => void copyConnection(row)}
                        data-tooltip="Copy connection string"
                      >
                        {row.connection_string}
                      </div>
                      <div className="db-stat-row">
                        <span className="db-stat-chip" data-tooltip="On-disk size reported by the engine">
                          <HardDrive size={11} />{" "}
                          {row.stats?.size_bytes != null ? fmtSize(row.stats.size_bytes) : "—"}
                        </span>
                        {(() => {
                          const days = backupAgeDays(row.stats?.last_backup_at);
                          const stale = days == null || days > 7;
                          return (
                            <span
                              className={`db-stat-chip ${stale ? "warn" : ""}`}
                              data-tooltip="Most recent backup snapshot"
                            >
                              <FileClock size={11} /> backup {fmtRelative(row.stats?.last_backup_at ?? null)}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="database-linked-services">
                        {services.filter((s) => s.linked_database_id === row.id).length === 0 ? (
                          <span className="muted tiny">No services linked yet</span>
                        ) : (
                          services
                            .filter((s) => s.linked_database_id === row.id)
                            .map((service) => (
                              <span key={service.id} className="stack-service-pill">
                                <Link2 size={11} /> {service.name}
                              </span>
                            ))
                        )}
                      </div>
                    </div>

                    <div className="service-footer">
                      <button
                        className="ghost xsmall"
                        onClick={(e) => {
                          e.stopPropagation();
                          void dbAction(row.id, "start");
                        }}
                        data-tooltip="Start database"
                      >
                        <Play size={14} />
                      </button>
                      <button
                        className="ghost xsmall"
                        onClick={(e) => {
                          e.stopPropagation();
                          void dbAction(row.id, "stop");
                        }}
                        data-tooltip="Stop database"
                      >
                        <Square size={14} />
                      </button>
                      <button
                        className="ghost xsmall"
                        onClick={(e) => {
                          e.stopPropagation();
                          void dbAction(row.id, "restart");
                        }}
                        data-tooltip="Restart database"
                      >
                        <RotateCw size={14} />
                      </button>
                      <button
                        className="ghost xsmall"
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyConnection(row);
                        }}
                        data-tooltip="Copy URL"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        className="ghost logout xsmall"
                        style={{ marginLeft: "auto" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteDb(row);
                        }}
                        data-tooltip="Delete database"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {selectedDb && (
        <section className="card management-panel" style={{ marginTop: "3rem" }}>
          <header className="section-title">
            <div className="row">
              <Database size={18} />
              <h3>Database Console: {selectedDb.name}</h3>
              <StatusBadge status={selectedDb.container_status?.state ?? "stopped"} />
            </div>
            <div className="row">
              <button onClick={() => void dbAction(selectedDb.id, "start")}>
                <Play size={16} /> Start
              </button>
              <button onClick={() => void dbAction(selectedDb.id, "restart")}>
                <RotateCw size={16} /> Restart
              </button>
              <button onClick={() => void runBackup(selectedDb.id)}>
                <FileClock size={16} /> Manual Backup
              </button>
              <button onClick={() => setTransferTarget(selectedDb)}>
                <Cloud size={16} /> Transfer to hosted
              </button>
            </div>
          </header>

          <div className="db-console-tabs" role="tablist">
            {(
              [
                { id: "overview", label: "Overview" },
                ...(selectedDb.engine === "postgres" || selectedDb.engine === "mysql"
                  ? [{ id: "data", label: "Data" } as const]
                  : []),
                { id: "backups", label: `Backups${backups.length ? ` (${backups.length})` : ""}` },
                ...(selectedDb.engine === "postgres" || selectedDb.engine === "mysql"
                  ? [{ id: "sql", label: "SQL" } as const]
                  : []),
                {
                  id: "linking",
                  label: `Linking${linkedServices.length ? ` (${linkedServices.length})` : ""}`
                },
                { id: "logs", label: "Logs" }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={consoleTab === tab.id}
                className={`db-console-tab ${consoleTab === tab.id ? "active" : ""}`}
                onClick={() => setConsoleTab(tab.id as typeof consoleTab)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {consoleTab === "overview" && (
            <div className="database-console-strip">
              <div>
                <span>Connection</span>
                <button className="connection-copy" onClick={() => void copyConnection(selectedDb)}>
                  {selectedDb.connection_string}
                </button>
              </div>
              <div>
                <span>Linked services</span>
                <strong>{linkedServices.length || "None"}</strong>
              </div>
              <div>
                <span>Container</span>
                <strong>
                  {selectedDb.container_status?.health ?? selectedDb.container_status?.state ?? "unknown"}
                </strong>
              </div>
            </div>
          )}

          {consoleTab === "data" && (selectedDb.engine === "postgres" || selectedDb.engine === "mysql") && (
            <div className="db-data-browser">
              <aside className="db-table-list">
                <div className="row between" style={{ marginBottom: "0.5rem" }}>
                  <strong className="tiny uppercase muted">Tables</strong>
                  {tablesLoading && <Loader2 size={12} className="animate-spin" />}
                </div>
                {tables.length === 0 && !tablesLoading ? (
                  <p className="muted small italic">No user tables yet.</p>
                ) : (
                  <ul>
                    {tables.map((t) => {
                      const isActive = activeTable?.schema === t.schema && activeTable?.name === t.name;
                      return (
                        <li key={`${t.schema}.${t.name}`}>
                          <button
                            type="button"
                            className={`db-table-item ${isActive ? "active" : ""}`}
                            onClick={() => setActiveTable({ schema: t.schema, name: t.name })}
                          >
                            <Table size={12} />
                            <span className="db-table-name">
                              {t.schema !== "public" && t.schema !== selectedDb.name ? `${t.schema}.` : ""}
                              {t.name}
                            </span>
                            <span className="muted tiny">~{t.row_estimate.toLocaleString()}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </aside>

              <div className="db-table-preview">
                {!activeTable ? (
                  <p className="muted small">Pick a table to preview its first 100 rows.</p>
                ) : previewLoading ? (
                  <p className="muted small">
                    <Loader2 size={12} className="animate-spin" /> Loading…
                  </p>
                ) : !tablePreview || tablePreview.rows.length === 0 ? (
                  <p className="muted small italic">Empty table or no readable rows.</p>
                ) : (
                  <>
                    <div className="row between" style={{ marginBottom: "0.5rem" }}>
                      <strong className="tiny uppercase muted">
                        {activeTable.schema}.{activeTable.name}
                      </strong>
                      <span className="muted tiny">
                        {tablePreview.rows.length} of ≤{tablePreview.truncatedTo} rows
                      </span>
                    </div>
                    <div className="db-preview-scroll">
                      <table className="db-preview-table">
                        <thead>
                          <tr>
                            {tablePreview.columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tablePreview.rows.map((row, i) => (
                            <tr key={i}>
                              {tablePreview.columns.map((c) => (
                                <td key={c} title={String(row[c] ?? "")}>
                                  {formatCell(row[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {consoleTab === "backups" && (
            <div className="sub-section">
              <h4 className="metric-label">Recent Backups</h4>
              <div className="list">
                {backups.length === 0 ? (
                  <p className="muted small italic">
                    No snapshots found. Click <em>Manual Backup</em> above to create one.
                  </p>
                ) : (
                  backups.map((b) => (
                    <div key={b.id} className="list-item row between small">
                      <div>
                        <div className="font-semibold">{b.filename}</div>
                        <div className="tiny muted">
                          {fmtSize(b.size_bytes)} • {new Date(b.created_at).toLocaleString()}
                        </div>
                      </div>
                      <div className="row" style={{ gap: "0.25rem" }}>
                        <button
                          className="ghost tiny"
                          onClick={() => void downloadBackup(selectedDb.id, b)}
                          data-tooltip="Download dump"
                        >
                          <Download size={12} /> Download
                        </button>
                        <button className="ghost tiny" onClick={() => void runRestore(selectedDb.id, b.id)}>
                          Restore
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {consoleTab === "linking" && (
            <div className="sub-section">
              <h4 className="metric-label">Service Linking</h4>
              <p className="muted tiny" style={{ marginTop: "-0.4rem", marginBottom: "0.75rem" }}>
                Linking auto-injects <code>DATABASE_URL</code> on the next service start.
              </p>
              <div className="list">
                {services.length === 0 ? (
                  <p className="muted small italic">No services to link yet.</p>
                ) : (
                  services.map((s) => (
                    <div key={s.id} className="list-item row between small">
                      <span>{s.name}</span>
                      <button
                        className={`ghost tiny ${s.linked_database_id === selectedDb.id ? "logout" : ""}`}
                        onClick={() =>
                          void linkService(
                            s.id,
                            s.linked_database_id === selectedDb.id ? null : selectedDb.id
                          )
                        }
                      >
                        {s.linked_database_id === selectedDb.id ? "Unlink" : "Link"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {consoleTab === "sql" && (selectedDb.engine === "postgres" || selectedDb.engine === "mysql") && (
            <div className="seed-section">
              <h4 className="metric-label">Seed SQL</h4>
              <SqlFileInput
                onLoaded={(sql, filename) => {
                  setSeedSql(sql);
                  toast.success(`Loaded ${filename}`);
                }}
              />
              <textarea
                placeholder="-- Execute SQL against this database"
                value={seedSql}
                onChange={(e) => setSeedSql(e.target.value)}
                rows={8}
              />
              <button
                className="primary"
                disabled={!seedSql.trim()}
                onClick={() => void runSeed(selectedDb.id)}
                style={{ marginTop: "0.75rem" }}
              >
                Execute SQL
              </button>
            </div>
          )}

          {consoleTab === "logs" && (
            <div className="logs-section">
              <h4 className="metric-label">
                <ScrollText size={14} /> Container Logs
              </h4>
              <div className="logs-viewer" style={{ height: "260px" }}>
                {dbLogs || <span className="muted small">No logs yet.</span>}
              </div>
            </div>
          )}
        </section>
      )}

      {showModal && (
        <CreateDatabaseModal
          projects={projects}
          onClose={() => setShowModal(false)}
          onCreated={() => void load()}
        />
      )}
      {promoteTarget && (
        <PromoteEmbeddedDbModal
          embedded={promoteTarget}
          onClose={() => setPromoteTarget(null)}
          onPromoted={() => void load()}
        />
      )}
      {transferTarget && (
        <TransferDatabaseModal
          databaseId={transferTarget.id}
          databaseName={transferTarget.name}
          engine={transferTarget.engine}
          onClose={() => setTransferTarget(null)}
        />
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
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
        .databases-page .embedded-section {
          margin-bottom: 2rem;
          padding: 1rem 1.25rem;
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--warn, #d97706) 6%, var(--bg-card));
        }
        .databases-page .embedded-section h3 { margin: 0; font-size: 0.95rem; }
        .databases-page .embedded-section .embedded-header { margin-bottom: 1rem; }
        .databases-page .embedded-grid {
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        }
        .databases-page .embedded-card { padding: 1rem; }
        .databases-page .embedded-card h4 { margin: 0; font-size: 0.92rem; }
        .databases-page .embedded-meta {
          display: flex;
          gap: 0.75rem;
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 0.6rem;
          flex-wrap: wrap;
        }
        .databases-page .embedded-warning {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          margin-top: 0.6rem;
          font-size: 0.72rem;
          color: var(--warn, #d97706);
        }
        .databases-page .warn-chip {
          background: color-mix(in srgb, var(--warn, #d97706) 18%, transparent);
          color: var(--warn, #d97706);
          border-color: color-mix(in srgb, var(--warn, #d97706) 40%, transparent);
        }
        .databases-page .db-project-group { margin-bottom: 1.5rem; }
        .databases-page .db-project-group-header {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          margin: 0.25rem 0 0.75rem;
          padding-bottom: 0.4rem;
          border-bottom: 1px solid var(--border-subtle);
        }
        .databases-page .db-project-group-header h4 {
          margin: 0;
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .databases-page .skeleton-card {
          padding: 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .databases-page .skeleton-bar {
          height: 12px;
          border-radius: 6px;
          background: linear-gradient(90deg, var(--bg-sunken) 0%, var(--border-subtle) 50%, var(--bg-sunken) 100%);
          background-size: 200% 100%;
          animation: skeleton-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .databases-page .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .databases-page .db-console-tabs {
          display: flex;
          gap: 0.25rem;
          border-bottom: 1px solid var(--border-subtle);
          margin: 1rem 0 1.25rem;
          flex-wrap: wrap;
        }
        .databases-page .db-console-tab {
          background: transparent;
          border: none;
          padding: 0.5rem 0.85rem;
          color: var(--text-muted);
          font-size: 0.8rem;
          font-weight: 600;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          margin-bottom: -1px;
        }
        .databases-page .db-console-tab.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent);
        }
        .databases-page .db-console-tab:hover { color: var(--text-primary); }
        .databases-page .db-data-browser {
          display: grid;
          grid-template-columns: minmax(220px, 280px) 1fr;
          gap: 1rem;
          min-height: 320px;
        }
        .databases-page .db-table-list {
          border-right: 1px solid var(--border-subtle);
          padding-right: 0.75rem;
          max-height: 480px;
          overflow-y: auto;
        }
        .databases-page .db-table-list ul { list-style: none; padding: 0; margin: 0; }
        .databases-page .db-table-list li { margin-bottom: 0.15rem; }
        .databases-page .db-table-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          width: 100%;
          padding: 0.4rem 0.6rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-sm);
          color: var(--text-primary);
          font-size: 0.78rem;
          cursor: pointer;
          text-align: left;
        }
        .databases-page .db-table-item:hover { background: var(--bg-sunken); }
        .databases-page .db-table-item.active {
          background: var(--bg-card);
          border-color: var(--accent);
        }
        .databases-page .db-table-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .databases-page .db-preview-scroll {
          overflow: auto;
          max-height: 460px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
        }
        .databases-page .db-preview-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.74rem;
          font-family: var(--font-mono);
        }
        .databases-page .db-preview-table th,
        .databases-page .db-preview-table td {
          padding: 0.4rem 0.6rem;
          border-bottom: 1px solid var(--border-subtle);
          text-align: left;
          white-space: nowrap;
          max-width: 240px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .databases-page .db-preview-table th {
          position: sticky;
          top: 0;
          background: var(--bg-sunken);
          font-weight: 700;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
        }
        .databases-page .db-preview-table tr:hover td { background: var(--bg-sunken); }
        @media (max-width: 760px) {
          .databases-page .db-data-browser { grid-template-columns: 1fr; }
          .databases-page .db-table-list { border-right: none; border-bottom: 1px solid var(--border-subtle); padding-right: 0; padding-bottom: 0.75rem; max-height: 200px; }
        }
        .databases-page .db-stat-row {
          display: flex;
          gap: 0.4rem;
          margin: 0.4rem 0;
          flex-wrap: wrap;
        }
        .databases-page .db-stat-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.18rem 0.5rem;
          border: 1px solid var(--border-subtle);
          border-radius: 999px;
          background: var(--bg-sunken);
          color: var(--text-muted);
          font-size: 0.7rem;
        }
        .databases-page .db-stat-chip.warn {
          color: var(--warn, #d97706);
          border-color: color-mix(in srgb, var(--warn, #d97706) 40%, transparent);
          background: color-mix(in srgb, var(--warn, #d97706) 12%, transparent);
        }
      `
        }}
      />
    </div>
  );
}
