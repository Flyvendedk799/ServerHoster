import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
function parseDependsOn(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
export function ServiceSettingsModal({ service, onClose, onUpdated }) {
  const [form, setForm] = useState({
    name: service.name,
    domain: service.domain || "",
    port: String(service.port || ""),
    command: service.command || "",
    workingDir: service.working_dir || "",
    type: service.type,
    environment: service.environment ?? "production",
    dependsOn: parseDependsOn(service.depends_on ?? null),
    linkedDatabaseId: service.linked_database_id ?? ""
  });
  const [loading, setLoading] = useState(false);
  const [databases, setDatabases] = useState([]);
  const [otherServices, setOtherServices] = useState([]);
  useEffect(() => {
    void Promise.all([api("/services", { silent: true }), api("/databases", { silent: true })])
      .then(([svcs, dbs]) => {
        setOtherServices(svcs.filter((s) => s.id !== service.id && s.project_id === service.project_id));
        setDatabases(dbs);
      })
      .catch(() => undefined);
  }, [service.id, service.project_id]);
  async function save() {
    setLoading(true);
    try {
      await api(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          command: form.command,
          workingDir: form.workingDir,
          port: form.port ? Number(form.port) : undefined,
          domain: form.domain || undefined,
          environment: form.environment,
          dependsOn: form.dependsOn,
          linkedDatabaseId: form.linkedDatabaseId || null
        })
      });
      toast.success("Settings updated");
      onUpdated();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }
  function toggleDep(id) {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((x) => x !== id)
        : [...prev.dependsOn, id]
    }));
  }
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "600px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsx("h3", { children: "Service Settings" }),
            _jsxs("p", {
              className: "hint",
              children: [
                "Configuring ",
                _jsx("span", { style: { color: "var(--accent-light)" }, children: service.name })
              ]
            })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "form-row",
              children: [
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Service Name" }),
                    _jsx("input", {
                      value: form.name,
                      onChange: (e) => setForm({ ...form, name: e.target.value })
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Runtime Type" }),
                    _jsxs("select", {
                      value: form.type,
                      onChange: (e) => setForm({ ...form, type: e.target.value }),
                      children: [
                        _jsx("option", { value: "process", children: "Binary Process" }),
                        _jsx("option", { value: "docker", children: "Docker Image" }),
                        _jsx("option", { value: "static", children: "Static Web" })
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
                    _jsx("label", { children: "Environment" }),
                    _jsxs("select", {
                      value: form.environment,
                      onChange: (e) => setForm({ ...form, environment: e.target.value }),
                      children: [
                        _jsx("option", { value: "production", children: "Production" }),
                        _jsx("option", { value: "staging", children: "Staging" }),
                        _jsx("option", { value: "development", children: "Development" })
                      ]
                    })
                  ]
                }),
                _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "Internal Port" }),
                    _jsx("input", {
                      value: form.port,
                      onChange: (e) => setForm({ ...form, port: e.target.value }),
                      placeholder: "3000"
                    })
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Custom Domain" }),
                _jsx("input", {
                  value: form.domain,
                  onChange: (e) => setForm({ ...form, domain: e.target.value }),
                  placeholder: "app.myserver.com"
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Start Command" }),
                _jsx("input", {
                  value: form.command,
                  onChange: (e) => setForm({ ...form, command: e.target.value }),
                  placeholder: "npm run start"
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Database Link" }),
                _jsxs("select", {
                  value: form.linkedDatabaseId,
                  onChange: (e) => setForm({ ...form, linkedDatabaseId: e.target.value }),
                  children: [
                    _jsx("option", { value: "", children: "\u2014 No active link \u2014" }),
                    databases.map((db) =>
                      _jsxs("option", { value: db.id, children: [db.name, " (", db.engine, ")"] }, db.id)
                    )
                  ]
                })
              ]
            }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Dependencies (Start Priority)" }),
                _jsxs("div", {
                  className: "row wrap",
                  style: { gap: "0.5rem", marginTop: "0.25rem" },
                  children: [
                    otherServices.length === 0 &&
                      _jsx("span", { className: "muted tiny", children: "No other project services found." }),
                    otherServices.map((s) =>
                      _jsx(
                        "button",
                        {
                          className: `ghost xsmall ${form.dependsOn.includes(s.id) ? "active-chip" : ""}`,
                          onClick: () => toggleDep(s.id),
                          style: {
                            borderRadius: "var(--radius-full)",
                            padding: "0.3rem 0.8rem",
                            border: "1px solid var(--border-default)"
                          },
                          children: s.name
                        },
                        s.id
                      )
                    )
                  ]
                })
              ]
            })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", { className: "ghost", onClick: onClose, disabled: loading, children: "Discard" }),
            _jsx("button", {
              className: "primary",
              onClick: save,
              disabled: loading,
              children: loading ? "Saving..." : "Save Settings"
            })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
            __html: `
          .active-chip { background: var(--accent-gradient) !important; color: white !important; border-color: transparent !important; }
        `
          }
        })
      ]
    })
  });
}
