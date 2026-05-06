import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
const ENGINE_DEFAULT_PORT = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017
};
export function CreateDatabaseModal({ projects, onClose, onCreated, initialProjectId, initialName }) {
  const [form, setForm] = useState({
    projectId: initialProjectId || projects[0]?.id || "",
    name: initialName || "",
    engine: "postgres",
    port: "5432",
    username: "",
    password: "",
    databaseName: ""
  });
  const [loading, setLoading] = useState(false);
  async function handleSubmit() {
    if (!form.name) {
      toast.error("Database name is required");
      return;
    }
    setLoading(true);
    try {
      await api("/databases", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          engine: form.engine,
          port: Number(form.port),
          username: form.username || undefined,
          password: form.password || undefined,
          databaseName: form.databaseName || undefined
        })
      });
      toast.success(`Database "${form.name}" created`);
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
                _jsxs("svg", {
                  width: "24",
                  height: "24",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  children: [
                    _jsx("path", { d: "M12 2v20M2 12h20" }),
                    _jsx("ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }),
                    _jsx("path", { d: "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" })
                  ]
                }),
                _jsx("h3", { children: "Provision Persistence" })
              ]
            }),
            _jsx("p", {
              className: "hint",
              children: "Deploy a new managed database instance to your project."
            })
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
                  value: form.projectId,
                  onChange: (e) => setForm({ ...form, projectId: e.target.value }),
                  children: projects.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))
                })
              ]
            }),
            _jsxs("div", {
              className: "form-row",
              children: [
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Database Name" }),
                    _jsx("input", {
                      placeholder: "e.g. users-db",
                      value: form.name,
                      onChange: (e) => setForm({ ...form, name: e.target.value })
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Engine" }),
                    _jsxs("select", {
                      value: form.engine,
                      onChange: (e) => {
                        const eng = e.target.value;
                        setForm({ ...form, engine: eng, port: String(ENGINE_DEFAULT_PORT[eng]) });
                      },
                      children: [
                        _jsx("option", { value: "postgres", children: "PostgreSQL" }),
                        _jsx("option", { value: "mysql", children: "MySQL" }),
                        _jsx("option", { value: "redis", children: "Redis" }),
                        _jsx("option", { value: "mongo", children: "MongoDB" })
                      ]
                    })
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "form-row",
              children: [
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Port" }),
                    _jsx("input", {
                      value: form.port,
                      onChange: (e) => setForm({ ...form, port: e.target.value })
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsxs("label", {
                      children: [
                        "Database Name ",
                        _jsx("span", { className: "optional", children: "(Schema)" })
                      ]
                    }),
                    _jsx("input", {
                      placeholder: "Defaults to engine type",
                      value: form.databaseName,
                      onChange: (e) => setForm({ ...form, databaseName: e.target.value })
                    })
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "form-row",
              children: [
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Root User" }),
                    _jsx("input", {
                      placeholder: "admin",
                      value: form.username,
                      onChange: (e) => setForm({ ...form, username: e.target.value })
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Root Pass" }),
                    _jsx("input", {
                      type: "password",
                      placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
                      value: form.password,
                      onChange: (e) => setForm({ ...form, password: e.target.value })
                    })
                  ]
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
              children: loading ? "Provisioning..." : "Launch Instance"
            })
          ]
        })
      ]
    })
  });
}
