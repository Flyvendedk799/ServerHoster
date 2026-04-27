import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
};

export function CreateServiceModal({ projects, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    projectId: projects[0]?.id || "",
    name: "",
    type: "process" as "process" | "docker" | "static",
    command: "",
    workingDir: "",
    image: "",
    port: "",
    enableQuickTunnel: false
  });
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!form.name) {
      toast.error("Service name is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          type: form.type,
          command: form.command || undefined,
          workingDir: form.workingDir || undefined,
          image: form.image || undefined,
          port: form.port ? Number(form.port) : undefined,
          quickTunnelEnabled: form.enableQuickTunnel ? 1 : 0
        })
      });
      toast.success(`Service "${form.name}" created`);
      onCreated();
      onClose();
    } catch { /* toasted */ } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "540px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Create New Service</h3>
          <p className="hint">Manually configure or deploy a custom runtime.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project <span className="required">*</span></label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Service Name <span className="required">*</span></label>
              <input 
                placeholder="e.g. my-api" 
                value={form.name} 
                onChange={(e) => setForm({ ...form, name: e.target.value })} 
              />
            </div>
            <div className="form-group" style={{ maxWidth: "120px" }}>
              <label>Port <span className="optional">(opt)</span></label>
              <input 
                placeholder="8080" 
                value={form.port} 
                onChange={(e) => setForm({ ...form, port: e.target.value })} 
              />
            </div>
          </div>

          <div className="form-group">
            <label>Deployment Type</label>
            <select 
              value={form.type} 
              onChange={(e) => setForm({ ...form, type: e.target.value as any })}
            >
              <option value="process">Binary / Script Process</option>
              <option value="docker">Docker Image</option>
              <option value="static">Static Web Folder</option>
            </select>
          </div>

          {form.type === "docker" ? (
            <div className="form-group">
              <label>Image Reference <span className="required">*</span></label>
              <input 
                placeholder="e.g. nginx:latest" 
                value={form.image} 
                onChange={(e) => setForm({ ...form, image: e.target.value })} 
              />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Start Command <span className="required">*</span></label>
                <input 
                  placeholder={form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js"} 
                  value={form.command} 
                  onChange={(e) => setForm({ ...form, command: e.target.value })} 
                />
              </div>
              <div className="form-group">
                <label>Working Dir <span className="optional">(opt)</span></label>
                <input 
                  placeholder="/var/www/app" 
                  value={form.workingDir} 
                  onChange={(e) => setForm({ ...form, workingDir: e.target.value })} 
                />
              </div>
            </>
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
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Creating..." : "Launch Service"}
          </button>
        </footer>
      </div>
    </div>
  );
}
