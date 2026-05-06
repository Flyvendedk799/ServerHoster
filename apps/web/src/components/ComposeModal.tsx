import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onImported: () => void;
};

export function ComposeModal({ projects, onClose, onImported }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!content.trim()) {
      toast.error("Compose content is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services/import-compose", {
        method: "POST",
        body: JSON.stringify({ projectId, composeContent: content })
      });
      toast.success("Compose stack imported");
      onImported();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "700px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Import Docker Compose</h3>
          <p className="hint">Deploy a multi-service stack using standard YAML.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Compose YAML Content</label>
            <textarea
              placeholder="version: '3'..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", background: "var(--bg-sunken)" }}
            />
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Parsing & Importing..." : "Launch Stack"}
          </button>
        </footer>
      </div>
    </div>
  );
}
