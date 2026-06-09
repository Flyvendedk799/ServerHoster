import { useRef, useState } from "react";
import { FolderKanban } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";

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
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, { onClose, onSubmit: handleSubmit });

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
      <div
        className="modal-content"
        style={{ maxWidth: "500px" }}
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-modal-title"
      >
        <header className="modal-header">
          <div className="row">
            <FolderKanban size={20} className="text-accent" />
            <h3 id="project-modal-title">{project ? "Modify Project" : "New Environment"}</h3>
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
