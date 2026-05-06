import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
export function ComposeModal({ projects, onClose, onImported }) {
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
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "700px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsx("h3", { children: "Import Docker Compose" }),
            _jsx("p", { className: "hint", children: "Deploy a multi-service stack using standard YAML." })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Target Project" }),
                _jsx("select", {
                  value: projectId,
                  onChange: (e) => setProjectId(e.target.value),
                  children: projects.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Compose YAML Content" }),
                _jsx("textarea", {
                  placeholder: "version: '3'...",
                  value: content,
                  onChange: (e) => setContent(e.target.value),
                  rows: 12,
                  style: {
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.85rem",
                    background: "var(--bg-sunken)"
                  }
                })
              ]
            })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", { className: "ghost", onClick: onClose, disabled: loading, children: "Cancel" }),
            _jsx("button", {
              className: "primary",
              onClick: handleSubmit,
              disabled: loading,
              children: loading ? "Parsing & Importing..." : "Launch Stack"
            })
          ]
        })
      ]
    })
  });
}
