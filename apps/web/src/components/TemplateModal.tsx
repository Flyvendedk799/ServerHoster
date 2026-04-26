import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  onClose: () => void;
  onCreated: () => void;
};

const TEMPLATES = [
  { id: "node-api", name: "Node.js API", description: "Express/Fastify starter with basic structure.", icon: "🟢" },
  { id: "python-api", name: "Python API", description: "FastAPI starter with requirements.txt ready.", icon: "🐍" },
  { id: "static-site", name: "Static Site", description: "Vite + HTML starter for modern frontend.", icon: "🌐" }
];

export function TemplateModal({ onClose, onCreated }: Props) {
  const [selected, setSelected] = useState(TEMPLATES[0].id);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    try {
      await api("/projects/from-template", {
        method: "POST",
        body: JSON.stringify({
          template: selected,
          name: `${selected}-service`
        })
      });
      toast.success(`Project created from ${selected} template`);
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
            <div style={{ background: "var(--warning-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--warning)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>Quick Project Templates</h3>
              <p className="gh-hint">Select a starter template to bootstrap your application.</p>
            </div>
          </div>
        </div>

        <div className="gh-step-content">
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            {TEMPLATES.map((t) => (
              <div 
                key={t.id} 
                onClick={() => setSelected(t.id)}
                className={`card ${selected === t.id ? 'elevated' : ''}`}
                style={{ 
                  cursor: "pointer", 
                  padding: "var(--space-4)", 
                  display: "flex", 
                  gap: "1rem", 
                  alignItems: "center",
                  borderColor: selected === t.id ? 'var(--accent)' : 'var(--border-subtle)',
                  background: selected === t.id ? 'var(--bg-surface-alt)' : 'var(--bg-glass)'
                }}
              >
                <div style={{ fontSize: "1.5rem" }}>{t.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{t.name}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>{t.description}</div>
                </div>
                {selected === t.id && (
                  <div style={{ color: "var(--accent)" }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="gh-actions" style={{ marginTop: "var(--space-6)" }}>
          <button className="ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Generating..." : "Generate Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
