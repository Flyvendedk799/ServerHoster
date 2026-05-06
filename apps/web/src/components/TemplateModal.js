import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Braces, Check, Globe2, Zap } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
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
export function TemplateModal({ projects, onClose, onCreated }) {
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
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "560px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsxs("div", {
              className: "row",
              children: [
                _jsx(Zap, { size: 24, className: "text-accent" }),
                _jsx("h3", { children: "Application Templates" })
              ]
            }),
            _jsx("p", {
              className: "hint",
              children: "Select a production-ready boilerplate to jumpstart development."
            })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "form-group",
              style: { marginBottom: "1rem" },
              children: [
                _jsx("label", { children: "Target Project" }),
                _jsx("select", {
                  value: projectId,
                  onChange: (e) => setProjectId(e.target.value),
                  children: projects.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))
                })
              ]
            }),
            _jsx("div", {
              style: { display: "grid", gap: "1rem" },
              children: TEMPLATES.map((t) => {
                const Icon = t.icon;
                return _jsxs(
                  "div",
                  {
                    onClick: () => setSelected(t.id),
                    className: `template-item card ${selected === t.id ? "active" : ""}`,
                    children: [
                      _jsx("div", { className: "icon", children: _jsx(Icon, { size: 22 }) }),
                      _jsxs("div", {
                        className: "details",
                        children: [
                          _jsx("div", { className: "name", children: t.name }),
                          _jsx("div", { className: "desc", children: t.description })
                        ]
                      }),
                      selected === t.id &&
                        _jsx("div", { className: "check", children: _jsx(Check, { size: 18 }) })
                    ]
                  },
                  t.id
                );
              })
            })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", { className: "ghost", onClick: onClose, children: "Discard" }),
            _jsx("button", {
              className: "primary",
              onClick: handleSubmit,
              disabled: loading,
              children: loading ? "Spinning up..." : "Generate Workspace"
            })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
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
          }
        })
      ]
    })
  });
}
