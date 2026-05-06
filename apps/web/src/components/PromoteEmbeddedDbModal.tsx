import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { AlertTriangle, Database, Link2, Sparkles } from "lucide-react";
import { SqlFileInput } from "./SqlFileInput";

export type EmbeddedDb = {
  service_id: string;
  service_name: string;
  project_id: string | null;
  container_name: string;
  engine: "sqlite";
  file_path: string;
  size_bytes: number;
  persistent: boolean;
  missing_env: string[];
};

type Mode = "managed" | "external";

type Props = {
  embedded: EmbeddedDb;
  onClose: () => void;
  onPromoted: () => void;
};

export function PromoteEmbeddedDbModal({ embedded, onClose, onPromoted }: Props) {
  const [mode, setMode] = useState<Mode>("managed");
  const [databaseName, setDatabaseName] = useState(embedded.service_name.replace(/[^a-zA-Z0-9_]/g, "_"));
  const [externalUrl, setExternalUrl] = useState("");
  const [importSql, setImportSql] = useState("");
  const [restart, setRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const hasRealSqlite = embedded.size_bytes > 0 && embedded.file_path !== "(no embedded file detected)";
  const [importEmbeddedSqlite, setImportEmbeddedSqlite] = useState(hasRealSqlite);
  const [importOutput, setImportOutput] = useState<{ log?: string; error?: string | null } | null>(null);

  async function submit(): Promise<void> {
    if (mode === "external" && !externalUrl.trim()) {
      toast.error("Paste a DATABASE_URL to connect.");
      return;
    }
    setBusy(true);
    setImportOutput(null);
    try {
      const res = await api<{ importLog?: string; importError?: string | null }>(
        `/databases/embedded/${embedded.service_id}/promote`,
        {
          method: "POST",
          body: JSON.stringify({
            mode,
            databaseName: mode === "managed" ? databaseName || undefined : undefined,
            externalUrl: mode === "external" ? externalUrl.trim() : undefined,
            importSql: mode === "managed" && importSql.trim() ? importSql : undefined,
            importEmbeddedSqlite: mode === "managed" && importEmbeddedSqlite && hasRealSqlite,
            restart
          })
        }
      );
      if (res.importError) {
        setImportOutput({ log: res.importLog, error: res.importError });
        toast.error(`Provisioned, but import failed: ${res.importError}`);
        // Don't close — let the user see the failure and retry/seed manually.
        onPromoted();
        return;
      }
      toast.success(
        mode === "managed"
          ? `Provisioned managed Postgres for ${embedded.service_name}${importEmbeddedSqlite && hasRealSqlite ? " (data imported)" : ""}`
          : `Pointed ${embedded.service_name} at the supplied DATABASE_URL`
      );
      onPromoted();
      onClose();
    } catch {
      /* toasted by api helper */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "620px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="row">
            <Sparkles size={20} />
            <h3>Promote embedded database</h3>
          </div>
          <p className="hint">
            <code>{embedded.file_path}</code> inside <code>{embedded.container_name}</code> is{" "}
            {embedded.persistent ? "on a mounted volume" : "ephemeral container storage"}. Replace it with a
            managed database so signups survive redeploys.
          </p>
        </header>

        <div className="modal-body">
          <div className="promote-mode-row">
            <button
              type="button"
              className={`promote-mode-btn ${mode === "managed" ? "active" : ""}`}
              onClick={() => setMode("managed")}
            >
              <Database size={16} /> Provision managed Postgres
            </button>
            <button
              type="button"
              className={`promote-mode-btn ${mode === "external" ? "active" : ""}`}
              onClick={() => setMode("external")}
            >
              <Link2 size={16} /> Use existing DATABASE_URL
            </button>
          </div>

          {mode === "managed" ? (
            <>
              <div className="form-group">
                <label>Database name</label>
                <input
                  value={databaseName}
                  onChange={(e) => setDatabaseName(e.target.value)}
                  placeholder="appdb"
                />
                <p className="hint tiny">
                  Postgres role and database will use this name. Only letters, numbers, and underscores.
                </p>
              </div>
              {hasRealSqlite && (
                <label className="row" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={importEmbeddedSqlite}
                    onChange={(e) => setImportEmbeddedSqlite(e.target.checked)}
                  />
                  <span>
                    Copy <code>{embedded.file_path}</code> into the new Postgres via{" "}
                    <a href="https://github.com/dimitri/pgloader" target="_blank" rel="noreferrer">
                      pgloader
                    </a>
                  </span>
                </label>
              )}
              <div className="form-group">
                <label>Optional: extra SQL to apply</label>
                <SqlFileInput
                  onLoaded={(sql, filename) => {
                    setImportSql(sql);
                    toast.success(`Loaded ${filename}`);
                  }}
                />
                <textarea
                  rows={4}
                  placeholder="-- runs after the SQLite import (or instead of it)"
                  value={importSql}
                  onChange={(e) => setImportSql(e.target.value)}
                />
                <p className="hint tiny">Runs against the new Postgres after it accepts connections.</p>
              </div>
              {importOutput && (
                <div className="form-group">
                  <label>{importOutput.error ? "Import failed" : "Import output"}</label>
                  {importOutput.error && (
                    <p className="hint tiny" style={{ color: "var(--warn, #d97706)" }}>
                      {importOutput.error}
                    </p>
                  )}
                  {importOutput.log && (
                    <pre className="logs-viewer" style={{ height: "180px", whiteSpace: "pre-wrap" }}>
                      {importOutput.log}
                    </pre>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="form-group">
              <label>DATABASE_URL</label>
              <input
                placeholder="postgres://user:pass@host:5432/dbname"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
              />
              <p className="hint tiny">Stored as an encrypted secret on the service.</p>
            </div>
          )}

          <label className="row" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
            <span>Restart {embedded.service_name} so it picks up the new connection</span>
          </label>

          {!embedded.persistent && (
            <div className="promote-warning">
              <AlertTriangle size={16} />
              <span>
                The current SQLite file is not persistent. Any users created locally will be lost on the next
                container recreate unless you promote.
              </span>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Working..." : mode === "managed" ? "Provision & link" : "Link DATABASE_URL"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .promote-mode-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.5rem;
            margin-bottom: 1rem;
          }
          .promote-mode-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.6rem 0.8rem;
            border: 1px solid var(--border-subtle);
            background: var(--bg-sunken);
            color: var(--text-primary);
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 0.8rem;
          }
          .promote-mode-btn.active {
            border-color: var(--accent);
            background: var(--bg-card);
            box-shadow: var(--shadow-sm);
          }
          .promote-warning {
            display: flex;
            gap: 0.5rem;
            align-items: flex-start;
            padding: 0.7rem 0.8rem;
            margin-top: 0.75rem;
            border: 1px solid color-mix(in srgb, var(--warn, #d97706) 50%, transparent);
            border-radius: var(--radius-md);
            background: color-mix(in srgb, var(--warn, #d97706) 12%, transparent);
            font-size: 0.78rem;
          }
        `
          }}
        />
      </div>
    </div>
  );
}
