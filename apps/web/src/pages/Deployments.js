import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  GitCommit,
  Clock,
  Terminal as TerminalIcon,
  Rocket,
  History,
  Copy,
  Maximize2,
  CheckCircle2,
  XCircle,
  Loader2
} from "lucide-react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton } from "../components/ui/Skeleton";
function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return "—";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}
export function DeploymentsPage() {
  const [searchParams] = useSearchParams();
  const filterServiceId = searchParams.get("serviceId");
  const [deployments, setDeployments] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ serviceId: "", repoUrl: "" });
  const [expanded, setExpanded] = useState(new Set());
  const [liveLogs, setLiveLogs] = useState({});
  const [phases, setPhases] = useState({});
  const terminalRef = useRef(null);
  async function load() {
    try {
      const [d, s] = await Promise.all([
        api("/deployments", { silent: true }),
        api("/services", { silent: true })
      ]);
      const filteredDeploys = filterServiceId ? d.filter((item) => item.service_id === filterServiceId) : d;
      setDeployments(filteredDeploys);
      setServices(s);
      if (!form.serviceId && s.length > 0) {
        setForm((prev) => ({ ...prev, serviceId: filterServiceId || s[0].id }));
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload;
      if (typed.type === "build_log" && typed.deploymentId) {
        setLiveLogs((prev) => {
          const existing = prev[typed.deploymentId] ?? [];
          return {
            ...prev,
            [typed.deploymentId]: [...existing, { line: typed.line, stream: typed.stream ?? "stdout" }].slice(
              -2000
            )
          };
        });
      } else if (typed.type === "build_progress" && typed.deploymentId) {
        setPhases((prev) => ({ ...prev, [typed.deploymentId]: typed.phase }));
      } else if (typed.type === "deployment_started" || typed.type === "deployment_finished") {
        void load();
      }
    });
    return () => ws.close();
  }, [filterServiceId]);
  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [liveLogs]);
  async function deploy() {
    try {
      await api("/deployments/from-git", { method: "POST", body: JSON.stringify(form) });
      toast.success("Synchronizing pipeline...");
      setForm((prev) => ({ ...prev, repoUrl: "" }));
      await load();
    } catch {
      /* toasted */
    }
  }
  const running = deployments.filter((d) => d.status === "running" || d.status === "pending");
  if (loading) {
    return _jsxs("div", {
      className: "deployments-page",
      children: [
        _jsx("header", {
          className: "page-header",
          children: _jsx(Skeleton, { style: { height: "3rem", width: "400px" } })
        }),
        _jsx(Skeleton, { style: { height: "200px", marginBottom: "3rem" } }),
        _jsxs("div", {
          className: "grid",
          children: [
            _jsx(Skeleton, { style: { height: "300px" } }),
            _jsx(Skeleton, { style: { height: "300px" } })
          ]
        })
      ]
    });
  }
  return _jsxs("div", {
    className: "deployments-page",
    children: [
      _jsxs("header", {
        className: "page-header",
        children: [
          _jsxs("div", {
            className: "title-group",
            children: [
              _jsx("h2", { children: "Deployment Pipeline" }),
              _jsx("p", { className: "muted", children: "End-to-end synchronization for GitOps workflows." })
            ]
          }),
          _jsx("div", {
            className: "row",
            children: _jsxs("button", {
              className: "ghost small",
              onClick: () => load(),
              children: [_jsx(History, { size: 14 }), " Refresh History"]
            })
          })
        ]
      }),
      _jsxs("section", {
        className: "card featured-form",
        style: { marginBottom: "4rem", border: "1px solid var(--border-glow)" },
        children: [
          _jsx("div", {
            className: "section-title",
            children: _jsxs("div", {
              className: "row",
              children: [
                _jsx(Rocket, { className: "text-accent", size: 20 }),
                _jsx("h3", { children: "Manual Trigger" })
              ]
            })
          }),
          _jsxs("div", {
            className: "row wrap",
            style: { gap: "2rem", alignItems: "flex-end" },
            children: [
              _jsxs("div", {
                className: "field-group",
                style: { flex: 1, minWidth: "240px" },
                children: [
                  _jsx("label", { className: "tiny font-bold uppercase muted", children: "Target Service" }),
                  _jsx("select", {
                    value: form.serviceId,
                    onChange: (e) => setForm((p) => ({ ...p, serviceId: e.target.value })),
                    children: services.map((s) => _jsx("option", { value: s.id, children: s.name }, s.id))
                  })
                ]
              }),
              _jsxs("div", {
                className: "field-group",
                style: { flex: 2, minWidth: "320px" },
                children: [
                  _jsx("label", {
                    className: "tiny font-bold uppercase muted",
                    children: "Repository Overlay (URL)"
                  }),
                  _jsxs("div", {
                    className: "row pr-overlap",
                    children: [
                      _jsx(GitBranch, { size: 18, className: "icon-overlay muted" }),
                      _jsx("input", {
                        className: "with-icon",
                        placeholder: "Leave empty for default upstream...",
                        value: form.repoUrl,
                        onChange: (e) => setForm((p) => ({ ...p, repoUrl: e.target.value }))
                      })
                    ]
                  })
                ]
              }),
              _jsxs("button", {
                className: "primary",
                onClick: () => void deploy(),
                style: { height: "48px" },
                children: [_jsx(GitBranch, { size: 18 }), " Initiate Sync"]
              })
            ]
          })
        ]
      }),
      running.length > 0 &&
        _jsxs("section", {
          className: "card active-pipeline",
          style: {
            marginBottom: "4rem",
            border: "1px solid var(--accent)",
            background: "rgba(59,130,246,0.05)"
          },
          children: [
            _jsxs("div", {
              className: "section-title",
              children: [
                _jsxs("div", {
                  className: "row",
                  children: [
                    _jsx(Loader2, { className: "animate-spin text-accent", size: 20 }),
                    _jsx("h3", { children: "Active Build Output" })
                  ]
                }),
                _jsx("div", {
                  className: "row",
                  children: _jsx("span", { className: "badge accent pulsate", children: "STREAMING" })
                })
              ]
            }),
            _jsx(AnimatePresence, {
              children: running.map((d) =>
                _jsxs(
                  motion.div,
                  {
                    className: "build-container",
                    initial: { opacity: 0, scale: 0.98 },
                    animate: { opacity: 1, scale: 1 },
                    exit: { opacity: 0, scale: 0.98 },
                    style: { marginTop: "1rem" },
                    children: [
                      _jsxs("div", {
                        className: "terminal-header row between",
                        children: [
                          _jsxs("div", {
                            className: "row small",
                            children: [
                              _jsx(TerminalIcon, { size: 14, className: "muted" }),
                              _jsx("span", {
                                className: "font-bold",
                                children: services.find((s) => s.id === d.service_id)?.name
                              }),
                              _jsx("span", { className: "muted", children: "\u2022" }),
                              _jsx("span", {
                                className: "text-accent uppercase tiny font-bold",
                                children: phases[d.id] ?? "Initializing"
                              })
                            ]
                          }),
                          _jsx("div", {
                            className: "row",
                            children: _jsx("button", {
                              className: "ghost xsmall",
                              onClick: () => toast.info("Full-screen logs coming soon"),
                              children: _jsx(Maximize2, { size: 12 })
                            })
                          })
                        ]
                      }),
                      _jsxs("div", {
                        className: "logs-viewer terminal",
                        ref: terminalRef,
                        children: [
                          (liveLogs[d.id] ?? []).map((entry, i) =>
                            _jsxs(
                              "div",
                              {
                                className: `log-line ${entry.stream}`,
                                children: [
                                  _jsxs("span", {
                                    className: "log-time tiny",
                                    children: ["[", new Date().toLocaleTimeString(), "]"]
                                  }),
                                  _jsx("span", { className: "log-msg", children: entry.line })
                                ]
                              },
                              i
                            )
                          ),
                          (!liveLogs[d.id] || liveLogs[d.id].length === 0) &&
                            _jsx("div", {
                              className: "muted small",
                              style: { padding: "1rem" },
                              children: "Awaiting container orchestrator..."
                            })
                        ]
                      })
                    ]
                  },
                  d.id
                )
              )
            })
          ]
        }),
      _jsx("div", {
        className: "section-title",
        children: _jsxs("div", {
          className: "row",
          children: [_jsx(History, { size: 18 }), _jsx("h3", { children: "Historical Deployments" })]
        })
      }),
      _jsx("div", {
        className: "grid",
        children: _jsx(AnimatePresence, {
          children:
            deployments.length === 0
              ? _jsxs(
                  motion.div,
                  {
                    className: "card text-center",
                    style: { gridColumn: "1 / -1", padding: "6rem 2rem", opacity: 0.6 },
                    children: [
                      _jsx(History, {
                        size: 60,
                        className: "muted",
                        style: { margin: "0 auto 1.5rem", opacity: 0.2 }
                      }),
                      _jsx("p", {
                        className: "muted italic",
                        children: "No synchronization records in the current context."
                      })
                    ]
                  },
                  "empty"
                )
              : deployments.map((d) =>
                  _jsxs(
                    motion.div,
                    {
                      layout: true,
                      initial: { opacity: 0, y: 20 },
                      animate: { opacity: 1, y: 0 },
                      className: `card deployment-card ${d.status === "failed" ? "border-danger" : ""}`,
                      children: [
                        _jsxs("div", {
                          className: "service-header",
                          children: [
                            _jsxs("div", {
                              className: "service-title-group",
                              children: [
                                _jsx("h3", {
                                  className: "small",
                                  children:
                                    services.find((s) => s.id === d.service_id)?.name ?? "Legacy Resource"
                                }),
                                _jsxs("div", {
                                  className: "row tiny muted",
                                  style: { marginTop: "0.25rem" },
                                  children: [
                                    _jsx(Clock, { size: 10 }),
                                    _jsx("span", { children: new Date(d.created_at).toLocaleString() })
                                  ]
                                })
                              ]
                            }),
                            _jsxs("div", {
                              className: "row",
                              children: [
                                d.status === "success"
                                  ? _jsx(CheckCircle2, { size: 18, className: "text-success" })
                                  : d.status === "failed"
                                    ? _jsx(XCircle, { size: 18, className: "text-danger" })
                                    : _jsx(Loader2, { size: 18, className: "animate-spin text-accent" }),
                                _jsx(StatusBadge, { status: d.status })
                              ]
                            })
                          ]
                        }),
                        _jsxs("div", {
                          className: "service-body",
                          style: {
                            minHeight: "auto",
                            margin: "1.5rem 0",
                            background: "var(--bg-sunken)",
                            padding: "1rem",
                            borderRadius: "var(--radius-md)"
                          },
                          children: [
                            _jsxs("div", {
                              className: "row between tiny",
                              children: [
                                _jsx("span", {
                                  className: "muted font-bold uppercase",
                                  children: "Environment"
                                }),
                                _jsx("span", {
                                  className: "chip xsmall text-accent font-bold",
                                  children: "PRODUCTION"
                                })
                              ]
                            }),
                            _jsxs("div", {
                              className: "row between tiny",
                              style: { marginTop: "0.75rem" },
                              children: [
                                _jsx("span", {
                                  className: "muted font-bold uppercase",
                                  children: "Revision"
                                }),
                                _jsxs("div", {
                                  className: "row",
                                  children: [
                                    _jsx(GitCommit, { size: 12, className: "muted" }),
                                    _jsx("code", {
                                      className: "text-accent font-bold",
                                      children: d.commit_hash.slice(0, 7)
                                    })
                                  ]
                                })
                              ]
                            }),
                            _jsxs("div", {
                              className: "row between tiny",
                              style: { marginTop: "0.75rem" },
                              children: [
                                _jsx("span", {
                                  className: "muted font-bold uppercase",
                                  children: "Duration"
                                }),
                                _jsx("span", {
                                  className: "font-bold",
                                  children: fmtDuration(d.started_at ?? d.created_at, d.finished_at)
                                })
                              ]
                            })
                          ]
                        }),
                        _jsx(AnimatePresence, {
                          children:
                            expanded.has(d.id) &&
                            _jsx(motion.div, {
                              initial: { height: 0, opacity: 0 },
                              animate: { height: "auto", opacity: 1 },
                              exit: { height: 0, opacity: 0 },
                              className: "logs-viewer small-viewer",
                              style: {
                                marginTop: "1rem",
                                height: "320px",
                                overflowY: "auto",
                                overflowX: "hidden"
                              },
                              children: d.build_log
                                ? d.build_log
                                    .split("\n")
                                    .map((line, i) =>
                                      _jsx(
                                        "div",
                                        {
                                          className: "log-line",
                                          children: _jsx("span", {
                                            className: "log-msg tiny",
                                            style: { wordBreak: "break-all" },
                                            children: line
                                          })
                                        },
                                        i
                                      )
                                    )
                                : _jsx("div", {
                                    className: "muted tiny italic p-2",
                                    children: "Binary footprint only (No raw build logs)"
                                  })
                            })
                        }),
                        _jsxs("div", {
                          className: "service-footer",
                          style: { borderTop: "1px solid var(--border-subtle)" },
                          children: [
                            _jsx("button", {
                              className: "ghost xsmall",
                              onClick: () =>
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(d.id)) next.delete(d.id);
                                  else next.add(d.id);
                                  return next;
                                }),
                              children: expanded.has(d.id) ? "Minimize Logs" : "Inspect Logs"
                            }),
                            _jsx("button", {
                              className: "ghost xsmall",
                              onClick: () => {
                                navigator.clipboard.writeText(d.build_log);
                                toast.success("Logs buffered to clipboard");
                              },
                              children: _jsx(Copy, { size: 12 })
                            }),
                            d.status === "failed" &&
                              _jsx("button", {
                                className: "ghost xsmall text-danger",
                                style: { marginLeft: "auto" },
                                children: "Retry Build"
                              })
                          ]
                        })
                      ]
                    },
                    d.id
                  )
                )
        })
      }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
          __html: `
        .deployments-page .active-pipeline { box-shadow: 0 0 40px rgba(59,130,246,0.15); }
        .deployments-page .terminal { height: 400px; }
        .deployments-page .terminal-header { padding: 0.75rem 1rem; background: #111; border-top-left-radius: var(--radius-md); border-top-right-radius: var(--radius-md); border-bottom: 1px solid #333; }
        .deployments-page .log-line.stderr { color: var(--danger); }
        .deployments-page .pulsate { animation: pulse 2s infinite; }
        .deployments-page .animate-spin { animation: spin 2s linear infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .deployments-page .deployment-card.border-danger { border-color: rgba(239, 68, 68, 0.4); }
        .with-icon { padding-left: 2.5rem !important; }
        .pr-overlap { position: relative; width: 100%; }
        .icon-overlay { position: absolute; left: 0.75rem; top: 12px; pointer-events: none; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .tiny { font-size: 0.7rem; }
      `
        }
      })
    ]
  });
}
