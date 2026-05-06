import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { StatusBadge } from "../components/StatusBadge";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";
import { PromoteEmbeddedDbModal } from "../components/PromoteEmbeddedDbModal";
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
function fmtRelative(iso) {
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
function backupAgeDays(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms / (1000 * 60 * 60 * 24);
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function formatCell(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
function groupRowsByProject(rows, projects) {
  const byId = new Map();
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
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [services, setServices] = useState([]);
  const [embedded, setEmbedded] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [promoteTarget, setPromoteTarget] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedDbId, setSelectedDbId] = useState("");
  const [backups, setBackups] = useState([]);
  const [dbLogs, setDbLogs] = useState("");
  const [seedSql, setSeedSql] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [didLoadOnce, setDidLoadOnce] = useState(false);
  const [consoleTab, setConsoleTab] = useState("overview");
  const [tables, setTables] = useState([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [activeTable, setActiveTable] = useState(null);
  const [tablePreview, setTablePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  async function load() {
    setRefreshing(true);
    try {
      const [dbs, projs, svcs] = await Promise.all([api("/databases"), api("/projects"), api("/services")]);
      setRows(dbs);
      setProjects(projs);
      setServices(svcs);
    } catch {
      /* toasted */
    }
    // Embedded scan is best-effort: a docker-exec timeout shouldn't break the page.
    try {
      const [emb, orph] = await Promise.all([api("/databases/embedded"), api("/databases/orphan-services")]);
      setEmbedded(emb);
      setOrphans(orph);
    } catch {
      /* ignore */
    }
    setRefreshing(false);
    setDidLoadOnce(true);
  }
  /** Provision Postgres for a service that has no DB at all. Reuses the promote endpoint in managed mode. */
  async function provisionForService(orphan) {
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
  async function downloadBackup(databaseId, backup) {
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
  function fmtEmbeddedSize(bytes) {
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
    void api(`/databases/${selectedDbId}/backups`)
      .then(setBackups)
      .catch(() => undefined);
    void api(`/databases/${selectedDbId}/logs?tail=160`)
      .then((res) => setDbLogs(res.logs))
      .catch(() => undefined);
  }, [selectedDbId]);
  useEffect(() => {
    if (!selectedDb || consoleTab !== "data") return;
    if (selectedDb.engine !== "postgres" && selectedDb.engine !== "mysql") return;
    setTablesLoading(true);
    void api(`/databases/${selectedDb.id}/tables`)
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
    void api(`/databases/${selectedDb.id}/tables/${activeTable.schema}/${activeTable.name}/preview?limit=100`)
      .then((res) => setTablePreview(res))
      .catch(() => setTablePreview(null))
      .finally(() => setPreviewLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDbId, consoleTab, activeTable?.schema, activeTable?.name]);
  async function dbAction(id, action) {
    try {
      await api(`/databases/${id}/${action}`, { method: "POST" });
      toast.success(`${action} sent`);
      await load();
    } catch {
      /* toasted */
    }
  }
  async function deleteDb(db) {
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
  async function copyConnection(db) {
    try {
      await navigator.clipboard.writeText(db.connection_string);
      toast.success("Connection string copied");
    } catch {
      toast.error("Clipboard failed");
    }
  }
  async function runBackup(id) {
    try {
      const res = await api(`/databases/${id}/backup`, { method: "POST" });
      toast.success(`Backup created (${fmtSize(res.size)})`);
      const bks = await api(`/databases/${id}/backups`);
      setBackups(bks);
    } catch {
      /* toasted */
    }
  }
  async function runRestore(dbId, backupId) {
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
  async function runSeed(dbId) {
    if (!seedSql.trim()) return;
    const ok = await confirmDialog({
      title: "Execute SQL seed?",
      message: "This runs the current SQL against the selected database.",
      danger: true,
      confirmLabel: "Execute"
    });
    if (!ok) return;
    try {
      const res = await api(`/databases/${dbId}/seed`, {
        method: "POST",
        body: JSON.stringify({ sql: seedSql })
      });
      setDbLogs(res.output ?? "Seed completed successfully.");
      toast.success("SQL executed");
    } catch {
      /* toasted */
    }
  }
  async function linkService(serviceId, databaseId) {
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
  return _jsxs("div", {
    className: "databases-page",
    children: [
      _jsxs("header", {
        className: "page-header",
        children: [
          _jsxs("div", {
            className: "title-group",
            children: [
              _jsx("h2", { children: "Databases" }),
              _jsx("p", {
                className: "muted",
                children: "Managed persistence for your app stacks, with safe runtime controls."
              })
            ]
          }),
          _jsxs("div", {
            className: "row",
            style: { gap: "0.5rem" },
            children: [
              _jsxs("button", {
                className: "ghost",
                onClick: () => void load(),
                disabled: refreshing,
                "data-tooltip": "Re-scan databases and embedded persistence",
                children: [
                  refreshing
                    ? _jsx(Loader2, { size: 16, className: "animate-spin" })
                    : _jsx(RefreshCw, { size: 16 }),
                  _jsx("span", { children: "Refresh" })
                ]
              }),
              _jsxs("button", {
                className: "primary",
                onClick: () => setShowModal(true),
                children: [_jsx(Database, { size: 18 }), " Provision DB"]
              })
            ]
          })
        ]
      }),
      _jsxs("section", {
        className: "database-summary",
        children: [
          _jsxs("div", {
            className: "database-summary-item",
            children: [
              _jsx(Database, { size: 18 }),
              _jsx("strong", { children: rows.length }),
              _jsx("span", { children: "Total databases" })
            ]
          }),
          _jsxs("div", {
            className: "database-summary-item",
            children: [
              _jsx(Shield, { size: 18 }),
              _jsx("strong", { children: runningCount }),
              _jsx("span", { children: "Running now" })
            ]
          }),
          _jsxs("div", {
            className: "database-summary-item",
            children: [
              _jsx(Link2, { size: 18 }),
              _jsx("strong", { children: services.filter((service) => service.linked_database_id).length }),
              _jsx("span", { children: "Service links" })
            ]
          }),
          _jsxs("div", {
            className: "database-summary-item",
            children: [
              _jsx(HardDrive, { size: 18 }),
              _jsx("strong", { children: embedded.length }),
              _jsx("span", { children: "Embedded (unmanaged)" })
            ]
          })
        ]
      }),
      (embedded.length > 0 || orphans.length > 0) &&
        _jsxs("section", {
          className: "embedded-section",
          children: [
            _jsxs("header", {
              className: "embedded-header",
              children: [
                _jsxs("div", {
                  className: "row",
                  children: [
                    _jsx(HardDrive, { size: 16 }),
                    _jsx("h3", { children: "Service persistence" }),
                    _jsxs("span", {
                      className: "chip xsmall warn-chip",
                      children: [embedded.length + orphans.length, " unmanaged"]
                    })
                  ]
                }),
                _jsxs("p", {
                  className: "muted tiny",
                  children: [
                    "Services that don't yet have a managed database. Embedded SQLite files are listed when detected; services with no ",
                    _jsx("code", { children: "DATABASE_URL" }),
                    " at all are listed below them. One click provisions a managed Postgres and links it."
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "grid embedded-grid",
              children: [
                embedded.map((emb) =>
                  _jsxs(
                    "div",
                    {
                      className: "card embedded-card",
                      children: [
                        _jsxs("div", {
                          className: "row between",
                          children: [
                            _jsxs("div", {
                              children: [
                                _jsx("h4", { children: emb.service_name }),
                                _jsx("div", { className: "muted tiny font-mono", children: emb.file_path })
                              ]
                            }),
                            _jsx("span", {
                              className: `chip xsmall ${emb.persistent ? "" : "warn-chip"}`,
                              children: emb.persistent ? "Volume-backed" : "Ephemeral"
                            })
                          ]
                        }),
                        _jsxs("div", {
                          className: "embedded-meta",
                          children: [
                            _jsx("span", { children: "SQLite" }),
                            _jsx("span", { children: fmtEmbeddedSize(emb.size_bytes) }),
                            _jsx("span", { className: "muted", children: emb.container_name })
                          ]
                        }),
                        !emb.persistent &&
                          _jsxs("div", {
                            className: "embedded-warning",
                            children: [
                              _jsx(AlertTriangle, { size: 13 }),
                              _jsx("span", {
                                children: "No volume mount \u2014 data lost on container recreate."
                              })
                            ]
                          }),
                        _jsx("div", {
                          className: "row",
                          style: { marginTop: "0.75rem" },
                          children: _jsxs("button", {
                            className: "primary xsmall",
                            onClick: () => setPromoteTarget(emb),
                            children: [_jsx(Sparkles, { size: 13 }), " Promote to managed"]
                          })
                        })
                      ]
                    },
                    `emb-${emb.service_id}`
                  )
                ),
                orphans
                  .filter((o) => !embedded.some((e) => e.service_id === o.service_id))
                  .map((orph) =>
                    _jsxs(
                      "div",
                      {
                        className: "card embedded-card",
                        children: [
                          _jsxs("div", {
                            className: "row between",
                            children: [
                              _jsxs("div", {
                                children: [
                                  _jsx("h4", { children: orph.service_name }),
                                  _jsx("div", {
                                    className: "muted tiny",
                                    children: "No DATABASE_URL configured"
                                  })
                                ]
                              }),
                              _jsx("span", { className: "chip xsmall warn-chip", children: "No DB" })
                            ]
                          }),
                          _jsx("div", {
                            className: "embedded-meta",
                            children: _jsxs("span", { children: ["Service status: ", orph.status] })
                          }),
                          _jsxs("div", {
                            className: "row",
                            style: { marginTop: "0.75rem", gap: "0.5rem" },
                            children: [
                              _jsxs("button", {
                                className: "primary xsmall",
                                onClick: () => void provisionForService(orph),
                                children: [_jsx(PackageOpen, { size: 13 }), " Provision Postgres"]
                              }),
                              _jsx("button", {
                                className: "ghost xsmall",
                                onClick: () =>
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
                                  }),
                                children: "Configure\u2026"
                              })
                            ]
                          })
                        ]
                      },
                      `orph-${orph.service_id}`
                    )
                  )
              ]
            })
          ]
        }),
      !didLoadOnce
        ? _jsx("div", {
            className: "grid",
            children: [0, 1, 2].map((i) =>
              _jsxs(
                "div",
                {
                  className: "card skeleton-card",
                  children: [
                    _jsx("div", { className: "skeleton-bar", style: { width: "40%" } }),
                    _jsx("div", { className: "skeleton-bar", style: { width: "75%" } }),
                    _jsx("div", { className: "skeleton-bar", style: { width: "60%" } })
                  ]
                },
                i
              )
            )
          })
        : rows.length === 0
          ? _jsx("div", {
              className: "grid",
              children: _jsxs("div", {
                className: "card text-center",
                style: { gridColumn: "1 / -1", padding: "4rem" },
                children: [
                  _jsx("div", {
                    className: "muted",
                    style: { marginBottom: "1rem" },
                    children: "No database instances provisioned."
                  }),
                  _jsx("button", {
                    className: "primary",
                    onClick: () => setShowModal(true),
                    children: "Create your first database"
                  })
                ]
              })
            })
          : groupRowsByProject(rows, projects).map(({ projectId, projectName, items }) =>
              _jsxs(
                "section",
                {
                  className: "db-project-group",
                  children: [
                    _jsxs("header", {
                      className: "db-project-group-header",
                      children: [
                        _jsx("h4", { children: projectName }),
                        _jsxs("span", {
                          className: "muted tiny",
                          children: [items.length, " database", items.length === 1 ? "" : "s"]
                        })
                      ]
                    }),
                    _jsx("div", {
                      className: "grid",
                      children: items.map((row) => {
                        const state = row.container_status?.state ?? "stopped";
                        return _jsxs(
                          "div",
                          {
                            className: `card service-card ${selectedDbId === row.id ? "active-border" : ""}`,
                            onClick: () => setSelectedDbId(row.id),
                            style:
                              selectedDbId === row.id
                                ? { border: "1px solid var(--accent)", boxShadow: "var(--shadow-lg)" }
                                : {},
                            children: [
                              _jsx("div", { className: "env-tag", children: row.engine }),
                              _jsxs("div", {
                                className: "service-header",
                                children: [
                                  _jsxs("div", {
                                    className: "service-title-group",
                                    children: [
                                      _jsx("h3", { children: row.name }),
                                      _jsxs("div", {
                                        className: "service-meta muted tiny",
                                        children: ["Project: ", projectName]
                                      })
                                    ]
                                  }),
                                  _jsxs("div", {
                                    className: "row",
                                    children: [
                                      _jsx(StatusBadge, { status: state, dotOnly: true }),
                                      _jsxs("span", {
                                        className: "chip xsmall",
                                        children: ["Port ", row.port]
                                      }),
                                      row.container_status?.health &&
                                        _jsx("span", {
                                          className: "chip xsmall",
                                          children: row.container_status.health
                                        })
                                    ]
                                  })
                                ]
                              }),
                              _jsxs("div", {
                                className: "service-body",
                                children: [
                                  _jsx("div", {
                                    className: "connection-string font-mono tiny text-truncate",
                                    onClick: () => void copyConnection(row),
                                    "data-tooltip": "Copy connection string",
                                    children: row.connection_string
                                  }),
                                  _jsxs("div", {
                                    className: "db-stat-row",
                                    children: [
                                      _jsxs("span", {
                                        className: "db-stat-chip",
                                        "data-tooltip": "On-disk size reported by the engine",
                                        children: [
                                          _jsx(HardDrive, { size: 11 }),
                                          " ",
                                          row.stats?.size_bytes != null ? fmtSize(row.stats.size_bytes) : "—"
                                        ]
                                      }),
                                      (() => {
                                        const days = backupAgeDays(row.stats?.last_backup_at);
                                        const stale = days == null || days > 7;
                                        return _jsxs("span", {
                                          className: `db-stat-chip ${stale ? "warn" : ""}`,
                                          "data-tooltip": "Most recent backup snapshot",
                                          children: [
                                            _jsx(FileClock, { size: 11 }),
                                            " backup ",
                                            fmtRelative(row.stats?.last_backup_at ?? null)
                                          ]
                                        });
                                      })()
                                    ]
                                  }),
                                  _jsx("div", {
                                    className: "database-linked-services",
                                    children:
                                      services.filter((s) => s.linked_database_id === row.id).length === 0
                                        ? _jsx("span", {
                                            className: "muted tiny",
                                            children: "No services linked yet"
                                          })
                                        : services
                                            .filter((s) => s.linked_database_id === row.id)
                                            .map((service) =>
                                              _jsxs(
                                                "span",
                                                {
                                                  className: "stack-service-pill",
                                                  children: [_jsx(Link2, { size: 11 }), " ", service.name]
                                                },
                                                service.id
                                              )
                                            )
                                  })
                                ]
                              }),
                              _jsxs("div", {
                                className: "service-footer",
                                children: [
                                  _jsx("button", {
                                    className: "ghost xsmall",
                                    onClick: (e) => {
                                      e.stopPropagation();
                                      void dbAction(row.id, "start");
                                    },
                                    "data-tooltip": "Start database",
                                    children: _jsx(Play, { size: 14 })
                                  }),
                                  _jsx("button", {
                                    className: "ghost xsmall",
                                    onClick: (e) => {
                                      e.stopPropagation();
                                      void dbAction(row.id, "stop");
                                    },
                                    "data-tooltip": "Stop database",
                                    children: _jsx(Square, { size: 14 })
                                  }),
                                  _jsx("button", {
                                    className: "ghost xsmall",
                                    onClick: (e) => {
                                      e.stopPropagation();
                                      void dbAction(row.id, "restart");
                                    },
                                    "data-tooltip": "Restart database",
                                    children: _jsx(RotateCw, { size: 14 })
                                  }),
                                  _jsx("button", {
                                    className: "ghost xsmall",
                                    onClick: (e) => {
                                      e.stopPropagation();
                                      void copyConnection(row);
                                    },
                                    "data-tooltip": "Copy URL",
                                    children: _jsx(Copy, { size: 14 })
                                  }),
                                  _jsx("button", {
                                    className: "ghost logout xsmall",
                                    style: { marginLeft: "auto" },
                                    onClick: (e) => {
                                      e.stopPropagation();
                                      void deleteDb(row);
                                    },
                                    "data-tooltip": "Delete database",
                                    children: _jsx(Trash2, { size: 14 })
                                  })
                                ]
                              })
                            ]
                          },
                          row.id
                        );
                      })
                    })
                  ]
                },
                projectId ?? "unassigned"
              )
            ),
      selectedDb &&
        _jsxs("section", {
          className: "card management-panel",
          style: { marginTop: "3rem" },
          children: [
            _jsxs("header", {
              className: "section-title",
              children: [
                _jsxs("div", {
                  className: "row",
                  children: [
                    _jsx(Database, { size: 18 }),
                    _jsxs("h3", { children: ["Database Console: ", selectedDb.name] }),
                    _jsx(StatusBadge, { status: selectedDb.container_status?.state ?? "stopped" })
                  ]
                }),
                _jsxs("div", {
                  className: "row",
                  children: [
                    _jsxs("button", {
                      onClick: () => void dbAction(selectedDb.id, "start"),
                      children: [_jsx(Play, { size: 16 }), " Start"]
                    }),
                    _jsxs("button", {
                      onClick: () => void dbAction(selectedDb.id, "restart"),
                      children: [_jsx(RotateCw, { size: 16 }), " Restart"]
                    }),
                    _jsxs("button", {
                      onClick: () => void runBackup(selectedDb.id),
                      children: [_jsx(FileClock, { size: 16 }), " Manual Backup"]
                    }),
                    _jsxs("button", {
                      onClick: () => setTransferTarget(selectedDb),
                      children: [_jsx(Cloud, { size: 16 }), " Transfer to hosted"]
                    })
                  ]
                })
              ]
            }),
            _jsx("div", {
              className: "db-console-tabs",
              role: "tablist",
              children: [
                { id: "overview", label: "Overview" },
                ...(selectedDb.engine === "postgres" || selectedDb.engine === "mysql"
                  ? [{ id: "data", label: "Data" }]
                  : []),
                { id: "backups", label: `Backups${backups.length ? ` (${backups.length})` : ""}` },
                ...(selectedDb.engine === "postgres" || selectedDb.engine === "mysql"
                  ? [{ id: "sql", label: "SQL" }]
                  : []),
                {
                  id: "linking",
                  label: `Linking${linkedServices.length ? ` (${linkedServices.length})` : ""}`
                },
                { id: "logs", label: "Logs" }
              ].map((tab) =>
                _jsx(
                  "button",
                  {
                    role: "tab",
                    "aria-selected": consoleTab === tab.id,
                    className: `db-console-tab ${consoleTab === tab.id ? "active" : ""}`,
                    onClick: () => setConsoleTab(tab.id),
                    children: tab.label
                  },
                  tab.id
                )
              )
            }),
            consoleTab === "overview" &&
              _jsxs("div", {
                className: "database-console-strip",
                children: [
                  _jsxs("div", {
                    children: [
                      _jsx("span", { children: "Connection" }),
                      _jsx("button", {
                        className: "connection-copy",
                        onClick: () => void copyConnection(selectedDb),
                        children: selectedDb.connection_string
                      })
                    ]
                  }),
                  _jsxs("div", {
                    children: [
                      _jsx("span", { children: "Linked services" }),
                      _jsx("strong", { children: linkedServices.length || "None" })
                    ]
                  }),
                  _jsxs("div", {
                    children: [
                      _jsx("span", { children: "Container" }),
                      _jsx("strong", {
                        children:
                          selectedDb.container_status?.health ??
                          selectedDb.container_status?.state ??
                          "unknown"
                      })
                    ]
                  })
                ]
              }),
            consoleTab === "data" &&
              (selectedDb.engine === "postgres" || selectedDb.engine === "mysql") &&
              _jsxs("div", {
                className: "db-data-browser",
                children: [
                  _jsxs("aside", {
                    className: "db-table-list",
                    children: [
                      _jsxs("div", {
                        className: "row between",
                        style: { marginBottom: "0.5rem" },
                        children: [
                          _jsx("strong", { className: "tiny uppercase muted", children: "Tables" }),
                          tablesLoading && _jsx(Loader2, { size: 12, className: "animate-spin" })
                        ]
                      }),
                      tables.length === 0 && !tablesLoading
                        ? _jsx("p", { className: "muted small italic", children: "No user tables yet." })
                        : _jsx("ul", {
                            children: tables.map((t) => {
                              const isActive =
                                activeTable?.schema === t.schema && activeTable?.name === t.name;
                              return _jsx(
                                "li",
                                {
                                  children: _jsxs("button", {
                                    type: "button",
                                    className: `db-table-item ${isActive ? "active" : ""}`,
                                    onClick: () => setActiveTable({ schema: t.schema, name: t.name }),
                                    children: [
                                      _jsx(Table, { size: 12 }),
                                      _jsxs("span", {
                                        className: "db-table-name",
                                        children: [
                                          t.schema !== "public" && t.schema !== selectedDb.name
                                            ? `${t.schema}.`
                                            : "",
                                          t.name
                                        ]
                                      }),
                                      _jsxs("span", {
                                        className: "muted tiny",
                                        children: ["~", t.row_estimate.toLocaleString()]
                                      })
                                    ]
                                  })
                                },
                                `${t.schema}.${t.name}`
                              );
                            })
                          })
                    ]
                  }),
                  _jsx("div", {
                    className: "db-table-preview",
                    children: !activeTable
                      ? _jsx("p", {
                          className: "muted small",
                          children: "Pick a table to preview its first 100 rows."
                        })
                      : previewLoading
                        ? _jsxs("p", {
                            className: "muted small",
                            children: [
                              _jsx(Loader2, { size: 12, className: "animate-spin" }),
                              " Loading\u2026"
                            ]
                          })
                        : !tablePreview || tablePreview.rows.length === 0
                          ? _jsx("p", {
                              className: "muted small italic",
                              children: "Empty table or no readable rows."
                            })
                          : _jsxs(_Fragment, {
                              children: [
                                _jsxs("div", {
                                  className: "row between",
                                  style: { marginBottom: "0.5rem" },
                                  children: [
                                    _jsxs("strong", {
                                      className: "tiny uppercase muted",
                                      children: [activeTable.schema, ".", activeTable.name]
                                    }),
                                    _jsxs("span", {
                                      className: "muted tiny",
                                      children: [
                                        tablePreview.rows.length,
                                        " of \u2264",
                                        tablePreview.truncatedTo,
                                        " rows"
                                      ]
                                    })
                                  ]
                                }),
                                _jsx("div", {
                                  className: "db-preview-scroll",
                                  children: _jsxs("table", {
                                    className: "db-preview-table",
                                    children: [
                                      _jsx("thead", {
                                        children: _jsx("tr", {
                                          children: tablePreview.columns.map((c) =>
                                            _jsx("th", { children: c }, c)
                                          )
                                        })
                                      }),
                                      _jsx("tbody", {
                                        children: tablePreview.rows.map((row, i) =>
                                          _jsx(
                                            "tr",
                                            {
                                              children: tablePreview.columns.map((c) =>
                                                _jsx(
                                                  "td",
                                                  {
                                                    title: String(row[c] ?? ""),
                                                    children: formatCell(row[c])
                                                  },
                                                  c
                                                )
                                              )
                                            },
                                            i
                                          )
                                        )
                                      })
                                    ]
                                  })
                                })
                              ]
                            })
                  })
                ]
              }),
            consoleTab === "backups" &&
              _jsxs("div", {
                className: "sub-section",
                children: [
                  _jsx("h4", { className: "metric-label", children: "Recent Backups" }),
                  _jsx("div", {
                    className: "list",
                    children:
                      backups.length === 0
                        ? _jsxs("p", {
                            className: "muted small italic",
                            children: [
                              "No snapshots found. Click ",
                              _jsx("em", { children: "Manual Backup" }),
                              " above to create one."
                            ]
                          })
                        : backups.map((b) =>
                            _jsxs(
                              "div",
                              {
                                className: "list-item row between small",
                                children: [
                                  _jsxs("div", {
                                    children: [
                                      _jsx("div", { className: "font-semibold", children: b.filename }),
                                      _jsxs("div", {
                                        className: "tiny muted",
                                        children: [
                                          fmtSize(b.size_bytes),
                                          " \u2022 ",
                                          new Date(b.created_at).toLocaleString()
                                        ]
                                      })
                                    ]
                                  }),
                                  _jsxs("div", {
                                    className: "row",
                                    style: { gap: "0.25rem" },
                                    children: [
                                      _jsxs("button", {
                                        className: "ghost tiny",
                                        onClick: () => void downloadBackup(selectedDb.id, b),
                                        "data-tooltip": "Download dump",
                                        children: [_jsx(Download, { size: 12 }), " Download"]
                                      }),
                                      _jsx("button", {
                                        className: "ghost tiny",
                                        onClick: () => void runRestore(selectedDb.id, b.id),
                                        children: "Restore"
                                      })
                                    ]
                                  })
                                ]
                              },
                              b.id
                            )
                          )
                  })
                ]
              }),
            consoleTab === "linking" &&
              _jsxs("div", {
                className: "sub-section",
                children: [
                  _jsx("h4", { className: "metric-label", children: "Service Linking" }),
                  _jsxs("p", {
                    className: "muted tiny",
                    style: { marginTop: "-0.4rem", marginBottom: "0.75rem" },
                    children: [
                      "Linking auto-injects ",
                      _jsx("code", { children: "DATABASE_URL" }),
                      " on the next service start."
                    ]
                  }),
                  _jsx("div", {
                    className: "list",
                    children:
                      services.length === 0
                        ? _jsx("p", { className: "muted small italic", children: "No services to link yet." })
                        : services.map((s) =>
                            _jsxs(
                              "div",
                              {
                                className: "list-item row between small",
                                children: [
                                  _jsx("span", { children: s.name }),
                                  _jsx("button", {
                                    className: `ghost tiny ${s.linked_database_id === selectedDb.id ? "logout" : ""}`,
                                    onClick: () =>
                                      void linkService(
                                        s.id,
                                        s.linked_database_id === selectedDb.id ? null : selectedDb.id
                                      ),
                                    children: s.linked_database_id === selectedDb.id ? "Unlink" : "Link"
                                  })
                                ]
                              },
                              s.id
                            )
                          )
                  })
                ]
              }),
            consoleTab === "sql" &&
              (selectedDb.engine === "postgres" || selectedDb.engine === "mysql") &&
              _jsxs("div", {
                className: "seed-section",
                children: [
                  _jsx("h4", { className: "metric-label", children: "Seed SQL" }),
                  _jsx(SqlFileInput, {
                    onLoaded: (sql, filename) => {
                      setSeedSql(sql);
                      toast.success(`Loaded ${filename}`);
                    }
                  }),
                  _jsx("textarea", {
                    placeholder: "-- Execute SQL against this database",
                    value: seedSql,
                    onChange: (e) => setSeedSql(e.target.value),
                    rows: 8
                  }),
                  _jsx("button", {
                    className: "primary",
                    disabled: !seedSql.trim(),
                    onClick: () => void runSeed(selectedDb.id),
                    style: { marginTop: "0.75rem" },
                    children: "Execute SQL"
                  })
                ]
              }),
            consoleTab === "logs" &&
              _jsxs("div", {
                className: "logs-section",
                children: [
                  _jsxs("h4", {
                    className: "metric-label",
                    children: [_jsx(ScrollText, { size: 14 }), " Container Logs"]
                  }),
                  _jsx("div", {
                    className: "logs-viewer",
                    style: { height: "260px" },
                    children: dbLogs || _jsx("span", { className: "muted small", children: "No logs yet." })
                  })
                ]
              })
          ]
        }),
      showModal &&
        _jsx(CreateDatabaseModal, {
          projects: projects,
          onClose: () => setShowModal(false),
          onCreated: () => void load()
        }),
      promoteTarget &&
        _jsx(PromoteEmbeddedDbModal, {
          embedded: promoteTarget,
          onClose: () => setPromoteTarget(null),
          onPromoted: () => void load()
        }),
      transferTarget &&
        _jsx(TransferDatabaseModal, {
          databaseId: transferTarget.id,
          databaseName: transferTarget.name,
          engine: transferTarget.engine,
          onClose: () => setTransferTarget(null)
        }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
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
        }
      })
    ]
  });
}
