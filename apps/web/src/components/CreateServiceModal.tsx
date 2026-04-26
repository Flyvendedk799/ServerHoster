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
    port: ""
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
          port: form.port ? Number(form.port) : undefined
        })
      });
      toast.success(`Service "${form.name}" created`);
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
      <div className="card github-deploy-modal" style={{ maxWidth: "540px" }} onClick={(e) => e.stopPropagation()}>
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <div style={{ background: "var(--accent-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--accent)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/></svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>Create New Service</h3>
              <p className="gh-hint">Manually configure a process, docker container, or static site.</p>
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
              <label className="gh-label">Service Name <span className="gh-required">*</span></label>
              <input 
                placeholder="e.g. my-api" 
                value={form.name} 
                onChange={(e) => setForm({ ...form, name: e.target.value })} 
              />
            </div>
            <div className="gh-field-group" style={{ flex: 1 }}>
              <label className="gh-label">Port <span className="gh-optional">(optional)</span></label>
              <input 
                placeholder="8080" 
                value={form.port} 
                onChange={(e) => setForm({ ...form, port: e.target.value })} 
              />
            </div>
          </div>

          <div className="gh-field-group">
            <label className="gh-label">Service Type</label>
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
            <div className="gh-field-group">
              <label className="gh-label">Docker Image <span className="gh-required">*</span></label>
              <input 
                placeholder="e.g. nginx:latest or my-user/my-repo:tags" 
                value={form.image} 
                onChange={(e) => setForm({ ...form, image: e.target.value })} 
              />
              <p className="gh-hint">Supports public images or private ones if logged in via CLI</p>
            </div>
          ) : (
            <>
              <div className="gh-field-group">
                <label className="gh-label">Start Command <span className="gh-required">*</span></label>
                <input 
                  placeholder={form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js"} 
                  value={form.command} 
                  onChange={(e) => setForm({ ...form, command: e.target.value })} 
                />
              </div>
              <div className="gh-field-group">
                <label className="gh-label">Working Directory <span className="gh-optional">(optional)</span></label>
                <input 
                  placeholder="/absolute/path/to/app" 
                  value={form.workingDir} 
                  onChange={(e) => setForm({ ...form, workingDir: e.target.value })} 
                />
              </div>
            </>
          )}
        </div>

        <div className="gh-actions" style={{ marginTop: "var(--space-6)" }}>
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Creating..." : "Create Service"}
          </button>
        </div>
      </div>
    </div>
  );
}
