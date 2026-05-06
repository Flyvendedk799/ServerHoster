import { useState } from "react";
import { Braces, Check, Globe2, Zap } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
};

const TEMPLATES = [
  {
    id: "node-api",
    name: "Node.js API",
    description: "Express/Fastify starter with modular architecture.",
    icon: Braces
  },
  {
    id: "python-api",
    name: "Python API",
    description: "FastAPI starter with automated environment setup.",
    icon: Zap
  },
  {
    id: "static-site",
    name: "Static Web App",
    description: "Modern React/Vue/Vite frontend template.",
    icon: Globe2
  }
];

export function TemplateModal({ projects, onClose, onCreated }: Props) {
  const [selected, setSelected] = useState(TEMPLATES[0].id);
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    try {
      await api("/projects/from-template", {
        method: "POST",
        body: JSON.stringify({
          template: selected,
          projectId,
          name: `${selected.split("-")[0]}-app`
        })
      });
      toast.success(`Generated ${selected} scaffolding`);
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
      <div className="modal-content" style={{ maxWidth: "560px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="row">
            <Zap size={24} className="text-accent" />
            <h3>Application Templates</h3>
          </div>
          <p className="hint">Select a production-ready boilerplate to jumpstart development.</p>
        </header>

        <div className="modal-body">
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label>Target Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: "1rem" }}>
            {TEMPLATES.map((t) => {
              const Icon = t.icon;
              return (
                <div
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`template-item card ${selected === t.id ? "active" : ""}`}
                >
                  <div className="icon">
                    <Icon size={22} />
                  </div>
                  <div className="details">
                    <div className="name">{t.name}</div>
                    <div className="desc">{t.description}</div>
                  </div>
                  {selected === t.id && (
                    <div className="check">
                      <Check size={18} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose}>
            Discard
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Spinning up..." : "Generate Workspace"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .template-item { 
            cursor: pointer; padding: 1.25rem; display: flex; gap: 1rem; align-items: center; 
            background: var(--bg-sunken); border-color: var(--border-subtle); 
          }
          .template-item:hover { border-color: var(--accent); }
          .template-item.active { border-color: var(--accent); background: var(--accent-gradient); color: white; }
          .template-item .icon {
            width: 2.5rem;
            height: 2.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: var(--radius-md);
            background: var(--bg-elevated);
            color: var(--accent-light);
          }
          .template-item .name { font-weight: 700; margin-bottom: 0.2rem; }
          .template-item .desc { font-size: 0.8rem; opacity: 0.8; }
          .template-item.active .icon { background: rgba(255,255,255,0.16); color: white; }
          .template-item.active .desc { color: white; }
          .template-item .check { margin-left: auto; display: flex; align-items: center; }
        `
          }}
        />
      </div>
    </div>
  );
}
