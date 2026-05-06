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
      <div className="modal-content" style={{ maxWidth: "500px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="row">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <h3>{project ? "Modify Project" : "New Environment"}</h3>
          </div>
          <p className="hint">Group related services and databases into a single workspace.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>
              Workspace Name <span className="required">*</span>
            </label>
            <input
              placeholder="e.g. My Website"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Purpose / Description</label>
            <textarea
              placeholder="Primary production stack for client X..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
            />
          </div>

          <div className="form-group">
            <label>
              Meta: Repository URL <span className="optional">(opt)</span>
            </label>
            <input
              placeholder="https://github.com/user/project"
              value={form.gitUrl}
              onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
            />
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : project ? "Update Project" : "Create Project"}
          </button>
        </footer>
      </div>
    </div>
  );
}
