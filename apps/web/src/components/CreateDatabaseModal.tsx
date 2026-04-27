import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

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

export function CreateDatabaseModal({ projects, onClose, onCreated, initialProjectId, initialName }: Props) {
  const [form, setForm] = useState({
    projectId: initialProjectId || projects[0]?.id || "",
    name: initialName || "",
    engine: "postgres" as "postgres" | "mysql" | "redis" | "mongo",
    port: "5432",
    username: "",
    password: "",
    databaseName: ""
  });
  const [loading, setLoading] = useState(false);

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
    } catch { /* toasted */ } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "560px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
           <div className="row">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              <h3>Provision Persistence</h3>
           </div>
           <p className="hint">Deploy a new managed database instance to your project.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project</label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
                  setForm({ ...form, engine: eng, port: String(ENGINE_DEFAULT_PORT[eng]) });
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
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Database Name <span className="optional">(Schema)</span></label>
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
              <input 
                type="password"
                placeholder="••••••••" 
                value={form.password} 
                onChange={(e) => setForm({ ...form, password: e.target.value })} 
              />
            </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Provisioning..." : "Launch Instance"}
          </button>
        </footer>
      </div>
    </div>
  );
}
