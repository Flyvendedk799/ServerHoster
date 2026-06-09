import { useRef, useState } from "react";
import { Database, Eye, EyeOff, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
  initialProjectId?: string;
  initialName?: string;
};

const ENGINE_DEFAULT_PORT = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017
};

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const values = new Uint32Array(20);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

export function CreateDatabaseModal({ projects, onClose, onCreated, initialProjectId, initialName }: Props) {
  const [form, setForm] = useState({
    projectId: initialProjectId || projects[0]?.id || "",
    name: initialName || "",
    engine: "postgres" as "postgres" | "mysql" | "redis" | "mongo",
    port: "5432",
    username: "admin",
    password: "",
    databaseName: ""
  });
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Tracks whether the user typed their own port, so switching engine won't clobber it.
  const portTouched = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  useModalA11y(ref, { onClose, onSubmit: handleSubmit });

  async function handleSubmit() {
    if (!form.name) {
      toast.error("Database name is required");
      return;
    }
    setLoading(true);
    try {
      await api("/databases", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          engine: form.engine,
          port: Number(form.port),
          username: form.username || undefined,
          password: form.password || undefined,
          databaseName: form.databaseName || undefined
        })
      });
      toast.success(`Database "${form.name}" created`);
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
        aria-labelledby="create-database-title"
        style={{ maxWidth: "560px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div className="row">
            <Database size={20} className="text-accent" />
            <h3 id="create-database-title">Provision Persistence</h3>
          </div>
          <p className="hint">Deploy a new managed database instance to your project.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project</label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Database Name</label>
              <input
                placeholder="e.g. users-db"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Engine</label>
              <select
                value={form.engine}
                onChange={(e) => {
                  const eng = e.target.value as keyof typeof ENGINE_DEFAULT_PORT;
                  // Only re-default the port if the user hasn't entered their own.
                  setForm((f) => ({
                    ...f,
                    engine: eng,
                    port: portTouched.current ? f.port : String(ENGINE_DEFAULT_PORT[eng])
                  }));
                }}
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="redis">Redis</option>
                <option value="mongo">MongoDB</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Port</label>
              <input
                value={form.port}
                onChange={(e) => {
                  portTouched.current = true;
                  setForm({ ...form, port: e.target.value });
                }}
              />
            </div>
            <div className="form-group">
              <label>
                Database Name <span className="optional">(Schema)</span>
              </label>
              <input
                placeholder="Defaults to engine type"
                value={form.databaseName}
                onChange={(e) => setForm({ ...form, databaseName: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Root User</label>
              <input
                placeholder="admin"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Root Pass</label>
              <div className="input-wrap">
                <input
                  className="has-action"
                  style={{ paddingRight: "72px" }}
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <button
                  type="button"
                  className="input-action"
                  style={{ right: "38px" }}
                  onClick={() => {
                    setForm((f) => ({ ...f, password: generatePassword() }));
                    setShowPassword(true);
                  }}
                  aria-label="Generate password"
                  title="Generate strong password"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  className="input-action"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Provisioning..." : "Launch Instance"}
          </button>
        </footer>
      </div>
    </div>
  );
}
