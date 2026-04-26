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
        body: JSON.stringify({
          projectId,
          composeContent: content
        })
      });
      toast.success("Compose services imported successfully");
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
      <div className="card github-deploy-modal" style={{ maxWidth: "680px" }} onClick={(e) => e.stopPropagation()}>
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <div style={{ background: "var(--info-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--info)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>Import Docker Compose</h3>
              <p className="gh-hint">Paste your docker-compose.yml content to register multiple services at once.</p>
            </div>
          </div>
        </div>

        <div className="gh-step-content">
          <div className="gh-field-group">
            <label className="gh-label">Target Project <span className="gh-required">*</span></label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="gh-field-group">
            <label className="gh-label">Compose YAML Content</label>
            <textarea 
              placeholder="version: '3'..." 
              value={content} 
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              style={{ fontFamily: 'var(--font-mono)', fontSize: "0.85rem", background: "var(--bg-sunken)" }}
            />
          </div>
        </div>

        <div className="gh-actions" style={{ marginTop: "var(--space-6)" }}>
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Importing..." : "Import Services"}
          </button>
        </div>
      </div>
    </div>
  );
}
