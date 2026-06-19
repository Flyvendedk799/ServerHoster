import { useEffect, useRef, useState } from "react";
import { Database, Link2, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
};

type DatabaseSetupMode = "skip" | "create" | "link";
type DatabaseProfile = "postgres" | "mysql" | "mongo" | "redis" | "supabase";
type DatabaseRow = {
  id: string;
  project_id: string;
  name: string;
  engine: "postgres" | "mysql" | "redis" | "mongo";
};
type DatabaseSetupResult = {
  status: "skipped" | "review" | "ready" | "blocked" | "failed" | "no-database-detected";
  message: string;
};

export function CreateServiceModal({ projects, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    type: "process" as "process" | "docker" | "static",
    command: "",
    workingDir: "",
    image: "",
    port: "",
    enableQuickTunnel: false,
    databaseMode: "skip" as DatabaseSetupMode,
    databaseProfile: "postgres" as DatabaseProfile,
    databaseId: ""
  });
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const imageRequired = form.type === "docker";
  const commandRequired = form.type !== "docker";
  const imageMissing = imageRequired && !form.image.trim();
  const commandMissing = commandRequired && !form.command.trim();
  const databaseMissing = form.databaseMode === "link" && !form.databaseId;
  const canSubmit = !!form.name.trim() && !imageMissing && !commandMissing && !databaseMissing;

  useModalA11y(ref, { onClose, onSubmit: handleSubmit });

  useEffect(() => {
    void api<DatabaseRow[]>("/databases", { silent: true })
      .then(setDatabases)
      .catch(() => undefined);
  }, []);

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Service name is required");
      return;
    }
    if (imageMissing) {
      toast.error("Image reference is required");
      return;
    }
    if (commandMissing) {
      toast.error("Start command is required");
      return;
    }
    if (databaseMissing) {
      toast.error("Choose an existing database to link");
      return;
    }
    setLoading(true);
    try {
      const result = await api<{ database_setup?: DatabaseSetupResult }>("/services", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          type: form.type,
          command: form.command || undefined,
          workingDir: form.workingDir || undefined,
          dockerImage: form.image || undefined,
          port: form.port ? Number(form.port) : undefined,
          quickTunnelEnabled: form.enableQuickTunnel ? 1 : 0,
          databaseSetup:
            form.databaseMode === "skip"
              ? { mode: "skip" }
              : form.databaseMode === "create"
                ? { mode: "create", profile: form.databaseProfile, restart: false }
                : { mode: "link", databaseId: form.databaseId, restart: false }
        })
      });
      if (result.database_setup?.status === "failed" || result.database_setup?.status === "blocked") {
        toast.error(`Service created, database setup needs attention: ${result.database_setup.message}`);
      } else if (result.database_setup?.status === "ready") {
        toast.success(`Service "${form.name}" created with database linked`);
      } else {
        toast.success(`Service "${form.name}" created`);
      }
      onCreated();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-service-title"
        style={{ maxWidth: "540px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="create-service-title">Create New Service</h3>
          <p className="hint">Manually configure or deploy a custom runtime.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project</label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">Auto: create or reuse app project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>
                Service Name <span className="required">*</span>
              </label>
              <input
                placeholder="e.g. my-api"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group" style={{ maxWidth: "120px" }}>
              <label>
                Port <span className="optional">(opt)</span>
              </label>
              <input
                placeholder="8080"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Deployment Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as any })}>
              <option value="process">Binary / Script Process</option>
              <option value="docker">Docker Image</option>
              <option value="static">Static Web Folder</option>
            </select>
          </div>

          {form.type === "docker" ? (
            <div className="form-group">
              <label>
                Image Reference <span className="required">*</span>
              </label>
              <input
                placeholder="e.g. nginx:latest"
                value={form.image}
                aria-invalid={imageMissing || undefined}
                onChange={(e) => setForm({ ...form, image: e.target.value })}
              />
              {imageMissing && <span className="field-hint error">Image reference is required.</span>}
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>
                  Start Command <span className="required">*</span>
                </label>
                <input
                  placeholder={form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js"}
                  value={form.command}
                  aria-invalid={commandMissing || undefined}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
                {commandMissing && <span className="field-hint error">Start command is required.</span>}
              </div>
              <div className="form-group">
                <label>
                  Working Dir <span className="optional">(opt)</span>
                </label>
                <input
                  placeholder="/var/www/app"
                  value={form.workingDir}
                  onChange={(e) => setForm({ ...form, workingDir: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="form-group">
            <label>Database setup</label>
            <div className="database-setup-grid">
              <button
                type="button"
                className={form.databaseMode === "skip" ? "active" : ""}
                onClick={() => setForm({ ...form, databaseMode: "skip" })}
              >
                <Database size={15} />
                <span>
                  <strong>No database</strong>
                  <small>Use only service env and DATA_DIR</small>
                </span>
              </button>
              <button
                type="button"
                className={form.databaseMode === "create" ? "active" : ""}
                onClick={() => setForm({ ...form, databaseMode: "create" })}
              >
                <Sparkles size={15} />
                <span>
                  <strong>Create local</strong>
                  <small>Provision and inject connection env</small>
                </span>
              </button>
              <button
                type="button"
                className={form.databaseMode === "link" ? "active" : ""}
                onClick={() => setForm({ ...form, databaseMode: "link" })}
                disabled={databases.length === 0}
              >
                <Link2 size={15} />
                <span>
                  <strong>Link existing</strong>
                  <small>{databases.length ? "Use a managed DB" : "Create a DB first"}</small>
                </span>
              </button>
            </div>
          </div>

          {form.databaseMode === "create" && (
            <div className="form-group">
              <label>Database type</label>
              <select
                value={form.databaseProfile}
                onChange={(e) => setForm({ ...form, databaseProfile: e.target.value as DatabaseProfile })}
              >
                <option value="postgres">Postgres</option>
                <option value="mysql">MySQL</option>
                <option value="mongo">MongoDB</option>
                <option value="redis">Redis</option>
                <option value="supabase">Local Supabase</option>
              </select>
            </div>
          )}

          {form.databaseMode === "link" && (
            <div className="form-group">
              <label>Existing database</label>
              <select
                value={form.databaseId}
                aria-invalid={databaseMissing || undefined}
                onChange={(e) => setForm({ ...form, databaseId: e.target.value })}
              >
                <option value="">Choose a database</option>
                {databases
                  .filter((db) => !form.projectId || db.project_id === form.projectId)
                  .map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({db.engine})
                    </option>
                  ))}
              </select>
              {databaseMissing && <span className="field-hint error">Choose a database to link.</span>}
            </div>
          )}

          <label className="toggle-group">
            <input
              type="checkbox"
              checked={form.enableQuickTunnel}
              onChange={(e) => setForm({ ...form, enableQuickTunnel: e.target.checked })}
            />
            <div className="toggle-info">
              <span className="toggle-title">Enable public tunnel</span>
              <span className="toggle-desc">Generate an external Cloudflare URL instantly</span>
            </div>
          </label>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading || !canSubmit}>
            {loading ? "Creating..." : "Launch Service"}
          </button>
        </footer>
        <style
          dangerouslySetInnerHTML={{
            __html: `
          .database-setup-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem; }
          .database-setup-grid button { justify-content: flex-start; align-items: flex-start; gap: 0.5rem; padding: 0.65rem; text-align: left; background: var(--bg-sunken); }
          .database-setup-grid button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text-primary); }
          .database-setup-grid span { display: grid; gap: 0.15rem; min-width: 0; }
          .database-setup-grid small { color: var(--text-muted); font-size: 0.68rem; line-height: 1.2; }
          @media (max-width: 640px) { .database-setup-grid { grid-template-columns: 1fr; } }
        `
          }}
        />
      </div>
    </div>
  );
}
