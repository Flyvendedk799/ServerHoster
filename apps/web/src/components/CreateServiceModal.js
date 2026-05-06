import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
export function CreateServiceModal({ projects, onClose, onCreated }) {
  const [form, setForm] = useState({
    projectId: projects[0]?.id || "",
    name: "",
    type: "process",
    command: "",
    workingDir: "",
    image: "",
    port: "",
    enableQuickTunnel: false
  });
  const [loading, setLoading] = useState(false);
  async function handleSubmit() {
    if (!form.name) {
      toast.error("Service name is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          type: form.type,
          command: form.command || undefined,
          workingDir: form.workingDir || undefined,
          image: form.image || undefined,
          port: form.port ? Number(form.port) : undefined,
          quickTunnelEnabled: form.enableQuickTunnel ? 1 : 0
        })
      });
      toast.success(`Service "${form.name}" created`);
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
      style: { maxWidth: "540px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsx("h3", { children: "Create New Service" }),
            _jsx("p", { className: "hint", children: "Manually configure or deploy a custom runtime." })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsxs("label", {
                  children: ["Target Project ", _jsx("span", { className: "required", children: "*" })]
                }),
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
                    _jsxs("label", {
                      children: ["Service Name ", _jsx("span", { className: "required", children: "*" })]
                    }),
                    _jsx("input", {
                      placeholder: "e.g. my-api",
                      value: form.name,
                      onChange: (e) => setForm({ ...form, name: e.target.value })
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  style: { maxWidth: "120px" },
                  children: [
                    _jsxs("label", {
                      children: ["Port ", _jsx("span", { className: "optional", children: "(opt)" })]
                    }),
                    _jsx("input", {
                      placeholder: "8080",
                      value: form.port,
                      onChange: (e) => setForm({ ...form, port: e.target.value })
                    })
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Deployment Type" }),
                _jsxs("select", {
                  value: form.type,
                  onChange: (e) => setForm({ ...form, type: e.target.value }),
                  children: [
                    _jsx("option", { value: "process", children: "Binary / Script Process" }),
                    _jsx("option", { value: "docker", children: "Docker Image" }),
                    _jsx("option", { value: "static", children: "Static Web Folder" })
                  ]
                })
              ]
            }),
            form.type === "docker"
              ? _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsxs("label", {
                      children: ["Image Reference ", _jsx("span", { className: "required", children: "*" })]
                    }),
                    _jsx("input", {
                      placeholder: "e.g. nginx:latest",
                      value: form.image,
                      onChange: (e) => setForm({ ...form, image: e.target.value })
                    })
                  ]
                })
              : _jsxs(_Fragment, {
                  children: [
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsxs("label", {
                          children: ["Start Command ", _jsx("span", { className: "required", children: "*" })]
                        }),
                        _jsx("input", {
                          placeholder: form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js",
                          value: form.command,
                          onChange: (e) => setForm({ ...form, command: e.target.value })
                        })
                      ]
                    }),
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsxs("label", {
                          children: [
                            "Working Dir ",
                            _jsx("span", { className: "optional", children: "(opt)" })
                          ]
                        }),
                        _jsx("input", {
                          placeholder: "/var/www/app",
                          value: form.workingDir,
                          onChange: (e) => setForm({ ...form, workingDir: e.target.value })
                        })
                      ]
                    })
                  ]
                }),
            _jsxs("label", {
              className: "toggle-group",
              children: [
                _jsx("input", {
                  type: "checkbox",
                  checked: form.enableQuickTunnel,
                  onChange: (e) => setForm({ ...form, enableQuickTunnel: e.target.checked })
                }),
                _jsxs("div", {
                  className: "toggle-info",
                  children: [
                    _jsx("span", { className: "toggle-title", children: "Enable public tunnel" }),
                    _jsx("span", {
                      className: "toggle-desc",
                      children: "Generate an external Cloudflare URL instantly"
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
              children: loading ? "Creating..." : "Launch Service"
            })
          ]
        })
      ]
    })
  });
}
