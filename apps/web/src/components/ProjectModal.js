import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
export function ProjectModal({ project, onClose, onSaved }) {
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
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "500px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsxs("div", {
              className: "row",
              children: [
                _jsx("svg", {
                  width: "24",
                  height: "24",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  children: _jsx("path", {
                    d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                  })
                }),
                _jsx("h3", { children: project ? "Modify Project" : "New Environment" })
              ]
            }),
            _jsx("p", {
              className: "hint",
              children: "Group related services and databases into a single workspace."
            })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsxs("label", {
                  children: ["Workspace Name ", _jsx("span", { className: "required", children: "*" })]
                }),
                _jsx("input", {
                  placeholder: "e.g. My Website",
                  value: form.name,
                  onChange: (e) => setForm({ ...form, name: e.target.value })
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Purpose / Description" }),
                _jsx("textarea", {
                  placeholder: "Primary production stack for client X...",
                  value: form.description,
                  onChange: (e) => setForm({ ...form, description: e.target.value }),
                  rows: 3
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsxs("label", {
                  children: [
                    "Meta: Repository URL ",
                    _jsx("span", { className: "optional", children: "(opt)" })
                  ]
                }),
                _jsx("input", {
                  placeholder: "https://github.com/user/project",
                  value: form.gitUrl,
                  onChange: (e) => setForm({ ...form, gitUrl: e.target.value })
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
              children: loading ? "Saving..." : project ? "Update Project" : "Create Project"
            })
          ]
        })
      ]
    })
  });
}
