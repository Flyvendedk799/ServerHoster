import { useRef, useState } from "react";
import { Database, Eye, EyeOff, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";
import { InfoHint } from "./ui/InfoHint";

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
            <label className="label-with-hint">
              Target Project
              <InfoHint side="right">
                <p>
                  Just groups this database under a project in the dashboard. It doesn't limit
                  anything — you can still connect any app to it later, whatever project it's in.
                </p>
              </InfoHint>
            </label>
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
              <label className="label-with-hint">
                Instance Name
                <InfoHint side="right">
                  <p>
                    A friendly name for this database in ServerHoster — the label you'll see in the
                    dashboard, not the technical database name inside it. Something like{" "}
                    <code>users-db</code> works well.
                  </p>
                </InfoHint>
              </label>
              <input
                placeholder="e.g. users-db"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="label-with-hint">
                Engine
                <InfoHint title="Which database engine?" side="left">
                  <p>The kind of database to run. Not sure? PostgreSQL is the safe choice for most apps.</p>
                  <p>
                    <strong>PostgreSQL</strong> — the popular general-purpose default (works with
                    Prisma, Drizzle, <code>pg</code>). Comes with the data browser and SQL tools.
                  </p>
                  <p>
                    <strong>MySQL</strong> — another popular general-purpose option; pick it if your app
                    specifically expects MySQL.
                  </p>
                  <p>
                    <strong>Redis</strong> — a fast in-memory store for things like caching and
                    sessions. It has no tables.
                  </p>
                  <p>
                    <strong>MongoDB</strong> — a document database; pick it if your app uses MongoDB.
                  </p>
                  <p>Changing the type fills in its usual port for you.</p>
                </InfoHint>
              </label>
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
              <label className="label-with-hint">
                Port
                <InfoHint side="right">
                  <p>
                    The port number this database listens on. ServerHoster fills in the normal one for
                    each type — only change it if another service is already using that number.
                  </p>
                </InfoHint>
              </label>
              <input
                value={form.port}
                onChange={(e) => {
                  portTouched.current = true;
                  setForm({ ...form, port: e.target.value });
                }}
              />
            </div>
            <div className="form-group">
              <label className="label-with-hint">
                Initial Database <span className="optional">(Schema)</span>
                <InfoHint side="left">
                  <p>
                    The name of the first database created inside this instance — it appears at the end
                    of the connection address. Leave it blank to use a sensible default. Redis doesn't
                    use this.
                  </p>
                </InfoHint>
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
              <label className="label-with-hint">
                Root User
                <InfoHint side="right">
                  <p>
                    The main admin username for the database, saved into the connection address.
                    Defaults to <code>admin</code>. (Redis only uses a password.)
                  </p>
                </InfoHint>
              </label>
              <input
                placeholder="admin"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="label-with-hint">
                Root Pass
                <InfoHint side="left">
                  <p>
                    Leave this empty and ServerHoster will create a strong password for you, or click
                    the refresh icon to generate one. It's stored encrypted.
                  </p>
                </InfoHint>
              </label>
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
