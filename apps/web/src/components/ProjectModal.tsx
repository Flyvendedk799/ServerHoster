import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  project?: { id: string; name: string; description: string; gitUrl: string } | null;
  onClose: () => void;
  onSaved: () => void;
};

export function ProjectModal({ project, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    name: project?.name || "",
    description: project?.description || "",
    gitUrl: project?.gitUrl || ""
  });
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!form.name) {
      toast.error("Project name is required");
      return;
    }
    setLoading(true);
    try {
      if (project) {
        await api(`/projects/${project.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: form.name,
            description: form.description || undefined,
            gitUrl: form.gitUrl || undefined
          })
        });
        toast.success(`Project "${form.name}" updated`);
      } else {
        await api("/projects", {
          method: "POST",
          body: JSON.stringify({
            name: form.name,
            description: form.description || undefined,
            gitUrl: form.gitUrl || undefined
          })
        });
        toast.success(`Project "${form.name}" created`);
      }
      onSaved();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card premium-modal" style={{ maxWidth: "500px" }} onClick={(e) => e.stopPropagation()}>
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <div style={{ background: "var(--accent-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--accent)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>{project ? "Edit Project" : "New Project"}</h3>
              <p className="gh-hint">Organize your services into logical groups.</p>
            </div>
          </div>
        </div>

        <div className="gh-step-content">
          <div className="gh-field-group">
            <label className="gh-label">Project Name <span className="gh-required">*</span></label>
            <input 
              placeholder="e.g. Production API" 
              value={form.name} 
              onChange={(e) => setForm({ ...form, name: e.target.value })} 
            />
          </div>

          <div className="gh-field-group">
            <label className="gh-label">Description <span className="gh-optional">(optional)</span></label>
            <textarea 
              placeholder="What is this project for?" 
              value={form.description} 
              onChange={(e) => setForm({ ...form, description: e.target.value })} 
              rows={3}
            />
          </div>

          <div className="gh-field-group">
            <label className="gh-label">Git Repository URL <span className="gh-optional">(optional)</span></label>
            <input 
              placeholder="https://github.com/user/project" 
              value={form.gitUrl} 
              onChange={(e) => setForm({ ...form, gitUrl: e.target.value })} 
            />
          </div>
        </div>

        <div className="gh-actions">
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : project ? "Save Project" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
