import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { AlertTriangle, Database, Link2, Sparkles } from "lucide-react";
import { SqlFileInput } from "./SqlFileInput";
export function PromoteEmbeddedDbModal({ embedded, onClose, onPromoted }) {
  const [mode, setMode] = useState("managed");
  const [databaseName, setDatabaseName] = useState(embedded.service_name.replace(/[^a-zA-Z0-9_]/g, "_"));
  const [externalUrl, setExternalUrl] = useState("");
  const [importSql, setImportSql] = useState("");
  const [restart, setRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const hasRealSqlite = embedded.size_bytes > 0 && embedded.file_path !== "(no embedded file detected)";
  const [importEmbeddedSqlite, setImportEmbeddedSqlite] = useState(hasRealSqlite);
  const [importOutput, setImportOutput] = useState(null);
  async function submit() {
    if (mode === "external" && !externalUrl.trim()) {
      toast.error("Paste a DATABASE_URL to connect.");
      return;
    }
    setBusy(true);
    setImportOutput(null);
    try {
      const res = await api(`/databases/embedded/${embedded.service_id}/promote`, {
        method: "POST",
        body: JSON.stringify({
          mode,
          databaseName: mode === "managed" ? databaseName || undefined : undefined,
          externalUrl: mode === "external" ? externalUrl.trim() : undefined,
          importSql: mode === "managed" && importSql.trim() ? importSql : undefined,
          importEmbeddedSqlite: mode === "managed" && importEmbeddedSqlite && hasRealSqlite,
          restart
        })
      });
      if (res.importError) {
        setImportOutput({ log: res.importLog, error: res.importError });
        toast.error(`Provisioned, but import failed: ${res.importError}`);
        // Don't close — let the user see the failure and retry/seed manually.
        onPromoted();
        return;
      }
      toast.success(
        mode === "managed"
          ? `Provisioned managed Postgres for ${embedded.service_name}${importEmbeddedSqlite && hasRealSqlite ? " (data imported)" : ""}`
          : `Pointed ${embedded.service_name} at the supplied DATABASE_URL`
      );
      onPromoted();
      onClose();
    } catch {
      /* toasted by api helper */
    } finally {
      setBusy(false);
    }
  }
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "620px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsxs("div", {
              className: "row",
              children: [_jsx(Sparkles, { size: 20 }), _jsx("h3", { children: "Promote embedded database" })]
            }),
            _jsxs("p", {
              className: "hint",
              children: [
                _jsx("code", { children: embedded.file_path }),
                " inside ",
                _jsx("code", { children: embedded.container_name }),
                " is",
                " ",
                embedded.persistent ? "on a mounted volume" : "ephemeral container storage",
                ". Replace it with a managed database so signups survive redeploys."
              ]
            })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            _jsxs("div", {
              className: "promote-mode-row",
              children: [
                _jsxs("button", {
                  type: "button",
                  className: `promote-mode-btn ${mode === "managed" ? "active" : ""}`,
                  onClick: () => setMode("managed"),
                  children: [_jsx(Database, { size: 16 }), " Provision managed Postgres"]
                }),
                _jsxs("button", {
                  type: "button",
                  className: `promote-mode-btn ${mode === "external" ? "active" : ""}`,
                  onClick: () => setMode("external"),
                  children: [_jsx(Link2, { size: 16 }), " Use existing DATABASE_URL"]
                })
              ]
            }),
            mode === "managed"
              ? _jsxs(_Fragment, {
                  children: [
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", { children: "Database name" }),
                        _jsx("input", {
                          value: databaseName,
                          onChange: (e) => setDatabaseName(e.target.value),
                          placeholder: "appdb"
                        }),
                        _jsx("p", {
                          className: "hint tiny",
                          children:
                            "Postgres role and database will use this name. Only letters, numbers, and underscores."
                        })
                      ]
                    }),
                    hasRealSqlite &&
                      _jsxs("label", {
                        className: "row",
                        style: { gap: "0.5rem", marginBottom: "0.5rem" },
                        children: [
                          _jsx("input", {
                            type: "checkbox",
                            checked: importEmbeddedSqlite,
                            onChange: (e) => setImportEmbeddedSqlite(e.target.checked)
                          }),
                          _jsxs("span", {
                            children: [
                              "Copy ",
                              _jsx("code", { children: embedded.file_path }),
                              " into the new Postgres via",
                              " ",
                              _jsx("a", {
                                href: "https://github.com/dimitri/pgloader",
                                target: "_blank",
                                rel: "noreferrer",
                                children: "pgloader"
                              })
                            ]
                          })
                        ]
                      }),
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", { children: "Optional: extra SQL to apply" }),
                        _jsx(SqlFileInput, {
                          onLoaded: (sql, filename) => {
                            setImportSql(sql);
                            toast.success(`Loaded ${filename}`);
                          }
                        }),
                        _jsx("textarea", {
                          rows: 4,
                          placeholder: "-- runs after the SQLite import (or instead of it)",
                          value: importSql,
                          onChange: (e) => setImportSql(e.target.value)
                        }),
                        _jsx("p", {
                          className: "hint tiny",
                          children: "Runs against the new Postgres after it accepts connections."
                        })
                      ]
                    }),
                    importOutput &&
                      _jsxs("div", {
                        className: "form-group",
                        children: [
                          _jsx("label", { children: importOutput.error ? "Import failed" : "Import output" }),
                          importOutput.error &&
                            _jsx("p", {
                              className: "hint tiny",
                              style: { color: "var(--warn, #d97706)" },
                              children: importOutput.error
                            }),
                          importOutput.log &&
                            _jsx("pre", {
                              className: "logs-viewer",
                              style: { height: "180px", whiteSpace: "pre-wrap" },
                              children: importOutput.log
                            })
                        ]
                      })
                  ]
                })
              : _jsxs("div", {
                  className: "form-group",
                  children: [
                    _jsx("label", { children: "DATABASE_URL" }),
                    _jsx("input", {
                      placeholder: "postgres://user:pass@host:5432/dbname",
                      value: externalUrl,
                      onChange: (e) => setExternalUrl(e.target.value)
                    }),
                    _jsx("p", {
                      className: "hint tiny",
                      children: "Stored as an encrypted secret on the service."
                    })
                  ]
                }),
            _jsxs("label", {
              className: "row",
              style: { gap: "0.5rem", marginTop: "0.5rem" },
              children: [
                _jsx("input", {
                  type: "checkbox",
                  checked: restart,
                  onChange: (e) => setRestart(e.target.checked)
                }),
                _jsxs("span", {
                  children: ["Restart ", embedded.service_name, " so it picks up the new connection"]
                })
              ]
            }),
            !embedded.persistent &&
              _jsxs("div", {
                className: "promote-warning",
                children: [
                  _jsx(AlertTriangle, { size: 16 }),
                  _jsx("span", {
                    children:
                      "The current SQLite file is not persistent. Any users created locally will be lost on the next container recreate unless you promote."
                  })
                ]
              })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", { className: "ghost", onClick: onClose, disabled: busy, children: "Cancel" }),
            _jsx("button", {
              className: "primary",
              onClick: () => void submit(),
              disabled: busy,
              children: busy ? "Working..." : mode === "managed" ? "Provision & link" : "Link DATABASE_URL"
            })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
            __html: `
          .promote-mode-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.5rem;
            margin-bottom: 1rem;
          }
          .promote-mode-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.6rem 0.8rem;
            border: 1px solid var(--border-subtle);
            background: var(--bg-sunken);
            color: var(--text-primary);
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 0.8rem;
          }
          .promote-mode-btn.active {
            border-color: var(--accent);
            background: var(--bg-card);
            box-shadow: var(--shadow-sm);
          }
          .promote-warning {
            display: flex;
            gap: 0.5rem;
            align-items: flex-start;
            padding: 0.7rem 0.8rem;
            margin-top: 0.75rem;
            border: 1px solid color-mix(in srgb, var(--warn, #d97706) 50%, transparent);
            border-radius: var(--radius-md);
            background: color-mix(in srgb, var(--warn, #d97706) 12%, transparent);
            font-size: 0.78rem;
          }
        `
          }
        })
      ]
    })
  });
}
