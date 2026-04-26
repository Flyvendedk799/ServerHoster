import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
};

const ENGINE_DEFAULT_PORT = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017
};

export function CreateDatabaseModal({ projects, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    projectId: projects[0]?.id || "",
    name: "",
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
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card premium-modal" style={{ maxWidth: "540px" }} onClick={(e) => e.stopPropagation()}>
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <div style={{ background: "var(--accent-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--accent)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>Provision Database</h3>
              <p className="gh-hint">Spin up a new managed database instance.</p>
            </div>
          </div>
        </div>

        <div className="gh-step-content">
          <div className="gh-field-group">
            <label className="gh-label">Target Project <span className="gh-required">*</span></label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="gh-field-row">
            <div className="gh-field-group" style={{ flex: 2 }}>
              <label className="gh-label">Database Name <span className="gh-required">*</span></label>
              <input 
                placeholder="e.g. main-db" 
                value={form.name} 
                onChange={(e) => setForm({ ...form, name: e.target.value })} 
              />
            </div>
            <div className="gh-field-group" style={{ flex: 1 }}>
              <label className="gh-label">Engine</label>
              <select 
                value={form.engine} 
                onChange={(e) => {
                  const eng = e.target.value as any;
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

          <div className="gh-field-row">
            <div className="gh-field-group" style={{ flex: 1 }}>
              <label className="gh-label">Port</label>
              <input 
                placeholder="5432" 
                value={form.port} 
                onChange={(e) => setForm({ ...form, port: e.target.value })} 
              />
            </div>
            <div className="gh-field-group" style={{ flex: 2 }}>
              <label className="gh-label">DB Name <span className="gh-optional">(optional)</span></label>
              <input 
                placeholder="defaults to 'postgres'" 
                value={form.databaseName} 
                onChange={(e) => setForm({ ...form, databaseName: e.target.value })} 
              />
            </div>
          </div>

          <div className="gh-field-row">
            <div className="gh-field-group" style={{ flex: 1 }}>
              <label className="gh-label">User <span className="gh-optional">(optional)</span></label>
              <input 
                placeholder="postgres" 
                value={form.username} 
                onChange={(e) => setForm({ ...form, username: e.target.value })} 
              />
            </div>
            <div className="gh-field-group" style={{ flex: 1 }}>
              <label className="gh-label">Pass <span className="gh-optional">(optional)</span></label>
              <input 
                type="password"
                placeholder="••••••••" 
                value={form.password} 
                onChange={(e) => setForm({ ...form, password: e.target.value })} 
              />
            </div>
          </div>
        </div>

        <div className="gh-actions">
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Provisioning..." : "Provision Instance"}
          </button>
        </div>
      </div>
    </div>
  );
}
