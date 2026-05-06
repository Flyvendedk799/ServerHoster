import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Rocket,
  Activity,
  Cpu,
  Database as DbIcon,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Server
} from "lucide-react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
function Sparkline({ values, color = "var(--accent)" }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - (v / max) * 100}`).join(" ");
  return _jsxs("svg", {
    viewBox: "0 0 100 100",
    preserveAspectRatio: "none",
    style: { height: "40px", width: "100%", marginTop: "1rem" },
    children: [
      _jsx("polyline", {
        points: pts,
        fill: "none",
        stroke: color,
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }),
      _jsx("path", { d: `M 0 100 L ${pts} L 100 100 Z`, fill: color, fillOpacity: "0.1" })
    ]
  });
}
export function DashboardPage() {
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [services, setServices] = useState([]);
  const [serviceMetrics, setServiceMetrics] = useState({});
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  // Mock Sparkline data for visual flair
  const [cpuHistory] = useState(() => Array.from({ length: 20 }, () => Math.random() * 50 + 10));
  const [memHistory] = useState(() => Array.from({ length: 20 }, () => Math.random() * 30 + 40));
  async function load() {
    try {
      const [m, h, svcs, mts, deps] = await Promise.all([
        api("/metrics/system", { silent: true }),
        api("/health/system", { silent: true }),
        api("/services", { silent: true }),
        api("/metrics/services", { silent: true }),
        api("/deployments", { silent: true })
      ]);
      setMetrics(m);
      setHealth(h);
      setServices(svcs);
      setServiceMetrics(mts);
      setDeployments(deps.slice(0, 6));
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (
        typeof payload === "object" &&
        payload &&
        ["service_status", "deployment_finished", "metrics_sample", "notification"].includes(payload.type)
      ) {
        void load();
      }
    });
    const intv = setInterval(() => void load(), 30000);
    return () => {
      ws.close();
      clearInterval(intv);
    };
  }, []);
  async function quickAction(serviceId, kind) {
    try {
      await api(`/services/${serviceId}/${kind}`, { method: "POST" });
      toast.success(`${kind} successfully sent`);
      await load();
    } catch {
      /* toasted */
    }
  }
  const runningCount = services.filter((s) => s.status === "running").length;
  const scoreColor = health
    ? health.score >= 80
      ? "var(--success)"
      : health.score >= 50
        ? "var(--warning)"
        : "var(--danger)"
    : "var(--text-muted)";
  if (loading) {
    return _jsxs("div", {
      className: "dashboard-page",
      children: [
        _jsx("header", {
          className: "page-header",
          children: _jsx(Skeleton, { style: { height: "3rem", width: "400px" } })
        }),
        _jsxs("div", {
          className: "metric-group",
          style: {
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "1.5rem",
            marginBottom: "3rem"
          },
          children: [
            _jsx(Skeleton, { style: { height: "140px" } }),
            _jsx(Skeleton, { style: { height: "140px" } }),
            _jsx(Skeleton, { style: { height: "140px" } }),
            _jsx(Skeleton, { style: { height: "140px" } })
          ]
        }),
        _jsxs("div", { className: "grid", children: [_jsx(CardSkeleton, {}), _jsx(CardSkeleton, {})] })
      ]
    });
  }
  return _jsxs("div", {
    className: "dashboard-page",
    children: [
      _jsxs("header", {
        className: "page-header",
        children: [
          _jsxs("div", {
            className: "title-group",
            children: [
              _jsx("h2", { children: "Node Overview" }),
              _jsxs("div", {
                className: "row muted small",
                children: [
                  _jsx(Activity, { size: 14, className: "text-accent" }),
                  _jsxs("span", {
                    children: ["Infrastructure Real-time streaming active \u2022 ", metrics?.platform]
                  })
                ]
              })
            ]
          }),
          _jsx("div", {
            className: "row",
            children: _jsxs(Link, {
              to: "/services",
              className: "button primary",
              children: [_jsx(Rocket, { size: 18 }), " Deploy New"]
            })
          })
        ]
      }),
      _jsxs("div", {
        className: "metric-group",
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "1.5rem",
          marginBottom: "4rem"
        },
        children: [
          _jsxs(motion.div, {
            className: "card metric-card",
            whileHover: { y: -5 },
            children: [
              _jsxs("div", {
                className: "row between",
                children: [
                  _jsx("span", { className: "muted font-bold small uppercase", children: "Capacity" }),
                  _jsx(Server, { size: 14, className: "text-muted" })
                ]
              }),
              _jsxs("div", {
                className: "metric-value font-bold",
                style: { fontSize: "2rem", marginTop: "0.5rem" },
                children: [
                  runningCount,
                  " ",
                  _jsxs("span", {
                    className: "muted",
                    style: { fontWeight: 400, fontSize: "1rem" },
                    children: ["/ ", services.length]
                  })
                ]
              }),
              _jsx("p", {
                className: "muted tiny uppercase font-bold",
                style: { marginTop: "0.5rem" },
                children: "Active Processes"
              }),
              _jsx(Sparkline, { values: cpuHistory, color: "var(--accent)" })
            ]
          }),
          _jsxs(motion.div, {
            className: "card metric-card",
            whileHover: { y: -5 },
            children: [
              _jsxs("div", {
                className: "row between",
                children: [
                  _jsx("span", { className: "muted font-bold small uppercase", children: "Health Score" }),
                  _jsx(Activity, { size: 14, className: "text-muted" })
                ]
              }),
              _jsxs("div", {
                className: "metric-value font-bold",
                style: { fontSize: "2rem", marginTop: "0.5rem", color: scoreColor },
                children: [
                  health?.score ?? 100,
                  _jsx("span", {
                    className: "muted",
                    style: { fontWeight: 400, fontSize: "1rem" },
                    children: "%"
                  })
                ]
              }),
              _jsx("p", {
                className: "muted tiny uppercase font-bold",
                style: { marginTop: "0.5rem" },
                children: health?.warnings.length ? `${health.warnings.length} Active Alerts` : "Node Optimal"
              }),
              _jsx(Sparkline, {
                values: Array.from({ length: 20 }, () => Math.random() * 10 + 90),
                color: scoreColor
              })
            ]
          }),
          _jsxs(motion.div, {
            className: "card metric-card",
            whileHover: { y: -5 },
            children: [
              _jsxs("div", {
                className: "row between",
                children: [
                  _jsx("span", { className: "muted font-bold small uppercase", children: "Memory" }),
                  _jsx(Cpu, { size: 14, className: "text-muted" })
                ]
              }),
              _jsxs("div", {
                className: "metric-value font-bold",
                style: { fontSize: "2rem", marginTop: "0.5rem" },
                children: [
                  health?.memoryUsedPercent ?? 0,
                  _jsx("span", {
                    className: "muted",
                    style: { fontWeight: 400, fontSize: "1rem" },
                    children: "%"
                  })
                ]
              }),
              _jsxs("p", {
                className: "muted tiny uppercase font-bold",
                style: { marginTop: "0.5rem" },
                children: [metrics ? fmtBytes(metrics.totalMemory - metrics.freeMemory) : "—", " In Use"]
              }),
              _jsx(Sparkline, { values: memHistory, color: "var(--warning)" })
            ]
          }),
          _jsxs(motion.div, {
            className: "card metric-card",
            whileHover: { y: -5 },
            children: [
              _jsxs("div", {
                className: "row between",
                children: [
                  _jsx("span", { className: "muted font-bold small uppercase", children: "Storage" }),
                  _jsx(DbIcon, { size: 14, className: "text-muted" })
                ]
              }),
              _jsxs("div", {
                className: "metric-value font-bold",
                style: { fontSize: "2rem", marginTop: "0.5rem" },
                children: [
                  health?.disk?.usedPercent ?? 0,
                  _jsx("span", {
                    className: "muted",
                    style: { fontWeight: 400, fontSize: "1rem" },
                    children: "%"
                  })
                ]
              }),
              _jsx("p", {
                className: "muted tiny uppercase font-bold",
                style: { marginTop: "0.5rem" },
                children: health?.disk ? `${fmtBytes(health.disk.freeBytes)} Free` : "N/A"
              }),
              _jsx(Sparkline, {
                values: Array.from({ length: 20 }, () => Math.random() * 5 + 15),
                color: "var(--info)"
              })
            ]
          })
        ]
      }),
      _jsxs("div", {
        className: "grid",
        children: [
          _jsxs("section", {
            className: "card glass-card",
            children: [
              _jsxs("div", {
                className: "section-title",
                children: [
                  _jsx("h3", { children: "Recent Activity" }),
                  _jsxs(Link, {
                    to: "/deployments",
                    className: "link small row",
                    children: ["View Pipeline ", _jsx(ArrowUpRight, { size: 14 })]
                  })
                ]
              }),
              deployments.length === 0
                ? _jsxs("div", {
                    className: "muted italic text-center",
                    style: { padding: "4rem" },
                    children: [
                      _jsx(Clock, { size: 40, style: { opacity: 0.2, marginBottom: "1rem" } }),
                      _jsx("p", { children: "No recent synchronization detected" })
                    ]
                  })
                : _jsx("div", {
                    className: "list",
                    children: deployments.map((d) => {
                      const svc = services.find((s) => s.id === d.service_id);
                      return _jsxs(
                        "div",
                        {
                          className: "list-item row between",
                          children: [
                            _jsxs("div", {
                              className: "row",
                              children: [
                                _jsx(StatusBadge, { status: d.status, dotOnly: true }),
                                _jsxs("div", {
                                  children: [
                                    _jsx("div", {
                                      className: "font-bold small",
                                      children: svc?.name ?? "Service"
                                    }),
                                    _jsxs("div", {
                                      className: "tiny muted",
                                      children: [
                                        new Date(d.created_at).toLocaleTimeString(),
                                        " \u2022 ",
                                        d.status
                                      ]
                                    })
                                  ]
                                })
                              ]
                            }),
                            _jsx("div", {
                              className: "row",
                              children: _jsx("code", {
                                className: "muted small",
                                style: {
                                  background: "var(--bg-sunken)",
                                  padding: "0.2rem 0.4rem",
                                  borderRadius: "4px"
                                },
                                children: d.commit_hash.slice(0, 7)
                              })
                            })
                          ]
                        },
                        d.id
                      );
                    })
                  })
            ]
          }),
          _jsxs("section", {
            className: "card glass-card",
            children: [
              _jsxs("div", {
                className: "section-title",
                children: [
                  _jsx("h3", { children: "Service Health" }),
                  _jsxs(Link, {
                    to: "/services",
                    className: "link small row",
                    children: ["Manage Services ", _jsx(ArrowUpRight, { size: 14 })]
                  })
                ]
              }),
              services.length === 0
                ? _jsxs("div", {
                    className: "muted italic text-center",
                    style: { padding: "4rem" },
                    children: [
                      _jsx(Server, { size: 40, style: { opacity: 0.2, marginBottom: "1rem" } }),
                      _jsx("p", { children: "Zero services found. Launch your first app." })
                    ]
                  })
                : _jsx("div", {
                    className: "list",
                    children: services.map((service) => {
                      const m = serviceMetrics[service.id];
                      return _jsxs(
                        "div",
                        {
                          className: "list-item row between",
                          children: [
                            _jsxs("div", {
                              className: "row",
                              children: [
                                _jsx(StatusBadge, { status: service.status, dotOnly: true }),
                                _jsxs("div", {
                                  children: [
                                    _jsx("span", { className: "font-bold small", children: service.name }),
                                    service.domain &&
                                      _jsx("div", { className: "tiny muted", children: service.domain })
                                  ]
                                })
                              ]
                            }),
                            _jsxs("div", {
                              className: "row",
                              children: [
                                m
                                  ? _jsxs("div", {
                                      className: "row tiny font-bold muted",
                                      children: [
                                        _jsxs("div", {
                                          className: "row",
                                          title: "CPU Usage",
                                          children: [_jsx(Cpu, { size: 12 }), m.cpu.toFixed(0), "%"]
                                        }),
                                        _jsxs("div", {
                                          className: "row",
                                          title: "Memory",
                                          children: [_jsx(DbIcon, { size: 12 }), Math.round(m.memoryMb), "MB"]
                                        })
                                      ]
                                    })
                                  : _jsx("span", { className: "muted tiny", children: "\u2014" }),
                                _jsx("button", {
                                  className: "ghost xsmall",
                                  onClick: () => quickAction(service.id, "restart"),
                                  children: "\u21BB"
                                })
                              ]
                            })
                          ]
                        },
                        service.id
                      );
                    })
                  })
            ]
          })
        ]
      }),
      (health?.warnings.length ?? 0) > 0 &&
        _jsxs(motion.section, {
          initial: { opacity: 0, scale: 0.98 },
          animate: { opacity: 1, scale: 1 },
          className: "card",
          style: {
            marginTop: "3rem",
            border: "1.5px solid var(--warning)",
            background: "rgba(245,158,11,0.05)"
          },
          children: [
            _jsxs("header", {
              className: "section-title",
              children: [
                _jsxs("div", {
                  className: "row",
                  children: [
                    _jsx(AlertTriangle, { className: "text-warning", size: 24 }),
                    _jsx("h3", { children: "Action Required: Maintenance Alerts" })
                  ]
                }),
                _jsx(StatusBadge, { status: "warning" })
              ]
            }),
            _jsx("div", {
              className: "alert-grid",
              style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" },
              children: health?.warnings.map((w, i) =>
                _jsxs(
                  "div",
                  {
                    className: "alert-item row",
                    style: {
                      padding: "1.25rem",
                      background: "var(--bg-sunken)",
                      borderRadius: "var(--radius-md)",
                      borderLeft: "4px solid var(--warning)"
                    },
                    children: [
                      _jsx("div", {
                        className: "row",
                        style: { flex: 1 },
                        children: _jsx("span", {
                          className: "small font-bold",
                          style: { color: "var(--text-primary)" },
                          children: w
                        })
                      }),
                      _jsxs("button", {
                        className: "ghost tiny uppercase font-bold",
                        onClick: () => toast.info("View logs for resolution steps."),
                        children: ["Resolve ", _jsx(ExternalLink, { size: 12 })]
                      })
                    ]
                  },
                  i
                )
              )
            })
          ]
        }),
      health?.score === 100 &&
        services.length > 0 &&
        _jsxs("div", {
          className: "row center muted",
          style: { marginTop: "4rem", opacity: 0.5, justifyContent: "center" },
          children: [
            _jsx(CheckCircle2, { size: 16, className: "text-success" }),
            _jsx("span", {
              className: "tiny font-bold uppercase",
              children: "All systems operational \u2022 Cluster in synchronization"
            })
          ]
        }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
          __html: `
        .dashboard-page .list { display: flex; flex-direction: column; gap: 0.5rem; }
        .dashboard-page .list-item { 
          padding: 1rem 0.5rem; 
          border-bottom: 1px solid var(--border-subtle);
          transition: var(--transition-fast);
        }
        .dashboard-page .list-item:hover { background: rgba(255,255,255,0.02); }
        .dashboard-page .list-item:last-child { border-bottom: none; }
        .dashboard-page .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .dashboard-page .font-bold { font-weight: 700; }
        .dashboard-page .tiny { font-size: 0.75rem; }
        .dashboard-page .xsmall { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
        .dashboard-page .glass-card { background: var(--bg-glass); border-color: var(--border-subtle); }
      `
        }
      })
    ]
  });
}
