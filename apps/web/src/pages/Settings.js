import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import {
  Globe,
  ShieldCheck,
  GitBranch,
  Key,
  Terminal,
  HardDrive,
  Download,
  Shield,
  Cloud,
  Cpu,
  Monitor,
  CheckCircle2,
  AlertCircle,
  Copy,
  LogOut,
  ChevronRight,
  Play
} from "lucide-react";
import { api, clearAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { StatusBadge } from "../components/StatusBadge";
import { motion, AnimatePresence } from "framer-motion";
export function SettingsPage() {
  const [activeTab, setActiveTab] = useState("connectivity");
  const [githubStatus, setGithubStatus] = useState(null);
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [sshInfo, setSshInfo] = useState(null);
  const [tunnel, setTunnel] = useState(null);
  const [cfConfig, setCfConfig] = useState({ accountId: "", tunnelId: "", zoneId: "" });
  const [sslMode, setSslMode] = useState("http-01");
  async function loadAll() {
    try {
      const [gh, ssh, t] = await Promise.all([
        api("/settings/github/status", { silent: true }),
        api("/settings/ssh", { silent: true }),
        api("/cloudflare/status", { silent: true })
      ]);
      setGithubStatus(gh);
      setSshInfo(ssh);
      setTunnel(t);
      if (t)
        setCfConfig({ accountId: t.accountId ?? "", tunnelId: t.tunnelId ?? "", zoneId: t.zoneId ?? "" });
    } catch {
      /* silent */
    }
  }
  useEffect(() => {
    void loadAll();
    const ws = connectLogs((payload) => {
      if (typeof payload === "object" && payload && payload.type === "tunnel_status") loadAll();
    });
    return () => ws.close();
  }, []);
  async function saveGithubPat() {
    try {
      await api("/settings/github/pat", {
        method: "POST",
        body: JSON.stringify({ token: githubTokenInput })
      });
      toast.success("GitHub identity verified and linked");
      setGithubTokenInput("");
      await loadAll();
    } catch {
      /* toasted */
    }
  }
  async function startTunnel() {
    try {
      await api("/cloudflare/start", { method: "POST" });
      toast.success("Cloudflare Tunnel handshake initiated");
      await loadAll();
    } catch {
      /* toasted */
    }
  }
  const tabs = [
    { id: "connectivity", label: "Edge & SSL", icon: Globe, desc: "DNS & Tunneling" },
    { id: "integrations", label: "Dev Tools", icon: GitBranch, desc: "Git & SSH Identity" },
    { id: "data", label: "Persistence", icon: HardDrive, desc: "Backups & Exports" },
    { id: "system", label: "Ops Console", icon: Cpu, desc: "Node Administration" }
  ];
  return _jsxs("div", {
    className: "settings-page",
    children: [
      _jsxs("header", {
        className: "page-header",
        children: [
          _jsxs("div", {
            className: "title-group",
            children: [
              _jsx("h2", { children: "Platform Settings" }),
              _jsx("p", {
                className: "muted",
                children: "Global configuration for edge routing and infrastructure identity."
              })
            ]
          }),
          _jsxs("button", {
            className: "ghost logout",
            onClick: () => {
              clearAuthToken();
              window.location.href = "/login";
            },
            children: [_jsx(LogOut, { size: 18 }), " Sign Out"]
          })
        ]
      }),
      _jsxs("div", {
        className: "settings-layout",
        children: [
          _jsx("aside", {
            className: "settings-nav",
            children: tabs.map((tab) =>
              _jsxs(
                "button",
                {
                  className: activeTab === tab.id ? "active" : "",
                  onClick: () => setActiveTab(tab.id),
                  children: [
                    _jsxs("div", {
                      className: "row",
                      style: { gap: "1rem" },
                      children: [
                        _jsx("div", {
                          className: `tab-icon-box ${activeTab === tab.id ? "active-icon" : ""}`,
                          children: _jsx(tab.icon, { size: 18 })
                        }),
                        _jsxs("div", {
                          className: "column",
                          style: { alignItems: "flex-start", gap: "2px" },
                          children: [
                            _jsx("span", { className: "tab-label font-bold small", children: tab.label }),
                            _jsx("span", { className: "tiny muted", children: tab.desc })
                          ]
                        })
                      ]
                    }),
                    _jsx(ChevronRight, {
                      size: 14,
                      className: "muted ml-auto",
                      style: { opacity: activeTab === tab.id ? 1 : 0 }
                    })
                  ]
                },
                tab.id
              )
            )
          }),
          _jsx("section", {
            className: "settings-content",
            children: _jsx(AnimatePresence, {
              mode: "wait",
              children: _jsxs(
                motion.div,
                {
                  initial: { opacity: 0, x: 10 },
                  animate: { opacity: 1, x: 0 },
                  exit: { opacity: 0, x: -10 },
                  transition: { duration: 0.2 },
                  children: [
                    activeTab === "connectivity" &&
                      _jsxs("div", {
                        className: "form-stack",
                        children: [
                          _jsxs("div", {
                            className: "card glass-card",
                            children: [
                              _jsxs("header", {
                                className: "section-title",
                                children: [
                                  _jsxs("div", {
                                    className: "row",
                                    children: [
                                      _jsx(Cloud, { className: "text-info", size: 20 }),
                                      _jsx("h3", { children: "Cloudflare Zero Trust" })
                                    ]
                                  }),
                                  _jsx(StatusBadge, { status: tunnel?.running ? "running" : "stopped" })
                                ]
                              }),
                              _jsx("p", {
                                className: "muted small",
                                style: { marginBottom: "2rem" },
                                children:
                                  "Connect your local node to the Cloudflare edge without opening ingress ports."
                              }),
                              _jsxs("div", {
                                className: "form-row",
                                children: [
                                  _jsxs("div", {
                                    className: "form-group",
                                    children: [
                                      _jsx("label", {
                                        className: "tiny uppercase font-bold muted",
                                        children: "Account Pointer (ID)"
                                      }),
                                      _jsx("input", {
                                        value: cfConfig.accountId,
                                        onChange: (e) =>
                                          setCfConfig({ ...cfConfig, accountId: e.target.value }),
                                        placeholder: "32-character ID"
                                      })
                                    ]
                                  }),
                                  _jsxs("div", {
                                    className: "form-group",
                                    children: [
                                      _jsx("label", {
                                        className: "tiny uppercase font-bold muted",
                                        children: "Tunnel Identifier"
                                      }),
                                      _jsx("input", {
                                        value: cfConfig.tunnelId,
                                        onChange: (e) =>
                                          setCfConfig({ ...cfConfig, tunnelId: e.target.value }),
                                        placeholder: "UUID"
                                      })
                                    ]
                                  })
                                ]
                              }),
                              _jsxs("footer", {
                                className: "footer-actions",
                                children: [
                                  _jsxs("button", {
                                    className: "primary",
                                    onClick: startTunnel,
                                    disabled: tunnel?.running,
                                    children: [_jsx(Play, { size: 16 }), " Establish Connection"]
                                  }),
                                  _jsx("button", {
                                    className: "ghost text-danger",
                                    onClick: () => api("/cloudflare/stop", { method: "POST" }).then(loadAll),
                                    children: "Terminate Connection"
                                  })
                                ]
                              })
                            ]
                          }),
                          _jsxs("div", {
                            className: "card glass-card",
                            children: [
                              _jsxs("div", {
                                className: "row",
                                children: [
                                  _jsx(ShieldCheck, { className: "text-success", size: 20 }),
                                  _jsx("h3", { children: "Certificate Authority" })
                                ]
                              }),
                              _jsx("p", {
                                className: "muted small",
                                style: { margin: "1rem 0" },
                                children:
                                  "Configure how SURVHub issues SSL/TLS certificates via Let's Encrypt."
                              }),
                              _jsxs("div", {
                                className: "form-group",
                                children: [
                                  _jsx("label", {
                                    className: "tiny uppercase font-bold muted",
                                    children: "Validation Strategy"
                                  }),
                                  _jsxs("select", {
                                    value: sslMode,
                                    onChange: (e) => setSslMode(e.target.value),
                                    children: [
                                      _jsx("option", {
                                        value: "http-01",
                                        children: "HTTP-01 Challenge (Standard)"
                                      }),
                                      _jsx("option", {
                                        value: "dns-01",
                                        children: "DNS-01 Challenge (Wildcard Support)"
                                      })
                                    ]
                                  })
                                ]
                              }),
                              _jsx("button", {
                                className: "button small",
                                style: { marginTop: "1.5rem" },
                                onClick: () =>
                                  api("/settings", {
                                    method: "PUT",
                                    body: JSON.stringify({ key: "ssl_mode", value: sslMode })
                                  }),
                                children: "Save Strategy"
                              })
                            ]
                          })
                        ]
                      }),
                    activeTab === "integrations" &&
                      _jsxs("div", {
                        className: "form-stack",
                        children: [
                          _jsxs("div", {
                            className: "card glass-card",
                            children: [
                              _jsxs("div", {
                                className: "row",
                                children: [
                                  _jsx(GitBranch, { className: "text-primary", size: 20 }),
                                  _jsx("h3", { children: "GitHub CI Integration" })
                                ]
                              }),
                              _jsxs("div", {
                                className: "form-group",
                                style: { marginTop: "1.5rem" },
                                children: [
                                  _jsx("label", {
                                    className: "tiny uppercase font-bold muted",
                                    children: "Personal Access Token"
                                  }),
                                  _jsx("input", {
                                    type: "password",
                                    placeholder: "ghp_****************",
                                    value: githubTokenInput,
                                    onChange: (e) => setGithubTokenInput(e.target.value)
                                  }),
                                  _jsx("div", {
                                    className: "row small",
                                    style: { marginTop: "1rem" },
                                    children: githubStatus?.configured
                                      ? _jsxs(_Fragment, {
                                          children: [
                                            _jsx(CheckCircle2, { size: 14, className: "text-success" }),
                                            _jsxs("span", {
                                              className: "muted",
                                              children: [
                                                "Authenticated as ",
                                                _jsxs("code", {
                                                  className: "text-accent",
                                                  children: [githubStatus.tokenPrefix, "***"]
                                                })
                                              ]
                                            })
                                          ]
                                        })
                                      : _jsxs(_Fragment, {
                                          children: [
                                            _jsx(AlertCircle, { size: 14, className: "text-warning" }),
                                            _jsx("span", {
                                              className: "muted",
                                              children:
                                                "Connect to enable private repository synchronization."
                                            })
                                          ]
                                        })
                                  })
                                ]
                              }),
                              _jsx("button", {
                                className: "primary",
                                style: { marginTop: "1rem" },
                                onClick: saveGithubPat,
                                children: "Update Token"
                              })
                            ]
                          }),
                          _jsxs("div", {
                            className: "card glass-card",
                            children: [
                              _jsxs("div", {
                                className: "row",
                                children: [
                                  _jsx(Key, { className: "text-warning", size: 20 }),
                                  _jsx("h3", { children: "Infrastructure SSH Key" })
                                ]
                              }),
                              _jsx("p", {
                                className: "muted small",
                                style: { margin: "1rem 0" },
                                children:
                                  "This public key is used for Git clones and secure cluster communication."
                              }),
                              _jsx("div", {
                                className: "ssh-box",
                                children: _jsx("code", {
                                  children: sshInfo?.publicKey || "Generating keys..."
                                })
                              }),
                              _jsxs("button", {
                                className: "ghost small font-bold",
                                onClick: () =>
                                  sshInfo?.publicKey &&
                                  navigator.clipboard
                                    .writeText(sshInfo.publicKey)
                                    .then(() => toast.success("Key copied to buffer")),
                                children: [_jsx(Copy, { size: 14 }), " Copy Public Key"]
                              })
                            ]
                          })
                        ]
                      }),
                    activeTab === "data" &&
                      _jsx("div", {
                        className: "form-stack",
                        children: _jsxs("div", {
                          className: "card glass-card",
                          children: [
                            _jsxs("div", {
                              className: "row",
                              children: [
                                _jsx(Download, { className: "text-accent", size: 20 }),
                                _jsx("h3", { children: "Instance Snapshot" })
                              ]
                            }),
                            _jsx("p", {
                              className: "muted small",
                              style: { margin: "1rem 0" },
                              children:
                                "Export all configuration, routing rules, and service metadata as a portable JSON file."
                            }),
                            _jsx("button", {
                              className: "primary",
                              onClick: () =>
                                api("/backup/export").then((d) => {
                                  const blob = new Blob([JSON.stringify(d, null, 2)], {
                                    type: "application/json"
                                  });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement("a");
                                  a.href = url;
                                  a.download = `survhub-export-${new Date().toISOString().slice(0, 19)}.json`;
                                  a.click();
                                  toast.success("Snapshot prepared");
                                }),
                              children: "Generate JSON Export"
                            })
                          ]
                        })
                      }),
                    activeTab === "system" &&
                      _jsx("div", {
                        className: "form-stack",
                        children: _jsxs("div", {
                          className: "card glass-card",
                          children: [
                            _jsxs("div", {
                              className: "row",
                              children: [
                                _jsx(Monitor, { size: 20, className: "text-muted" }),
                                _jsx("h3", { children: "Cluster Administration" })
                              ]
                            }),
                            _jsx("p", {
                              className: "muted small",
                              style: { marginTop: "1rem" },
                              children: "Execute maintenance tasks directly on the node control plane."
                            }),
                            _jsxs("div", {
                              className: "row wrap",
                              style: { gap: "1rem", marginTop: "2rem" },
                              children: [
                                _jsxs("button", {
                                  className: "button",
                                  onClick: () =>
                                    api("/ops/audit-logs").then(() =>
                                      toast.success("Audit pushed to syslogs")
                                    ),
                                  children: [_jsx(Terminal, { size: 16 }), " Audit Log Stream"]
                                }),
                                _jsxs("button", {
                                  className: "button",
                                  onClick: () =>
                                    api("/ops/install-scripts").then(() =>
                                      toast.success("Setup wizard cached")
                                    ),
                                  children: [_jsx(Shield, { size: 16 }), " Refresh Hardening"]
                                })
                              ]
                            })
                          ]
                        })
                      })
                  ]
                },
                activeTab
              )
            })
          })
        ]
      }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
          __html: `
        .settings-page .settings-layout { display: grid; grid-template-columns: 280px 1fr; gap: 4rem; margin-top: 1rem; align-items: flex-start; }
        .settings-page .settings-nav { display: flex; flex-direction: column; gap: 0.75rem; background: var(--bg-glass); padding: 1rem; border-radius: var(--radius-lg); border: 1px solid var(--border-subtle); }
        .settings-page .settings-nav button { 
          display: flex; align-items: center; gap: 1rem; padding: 1rem; 
          background: none; border: 1px solid transparent; color: var(--text-muted); 
          cursor: pointer; border-radius: var(--radius-md); transition: var(--transition-fast); 
        }
        .settings-page .settings-nav button:hover { background: var(--bg-sunken); color: var(--text-primary); }
        .settings-page .settings-nav button.active { background: var(--bg-card); border-color: var(--border-glow); color: var(--text-primary); box-shadow: var(--shadow-md); }
        .settings-page .tab-icon-box { width: 36px; height: 36px; background: var(--bg-sunken); display: flex; align-items: center; justify-content: center; border-radius: 8px; transition: var(--transition-fast); }
        .settings-page .active-icon { background: var(--accent-gradient); color: white; }
        .settings-page .form-stack { display: flex; flex-direction: column; gap: 2.5rem; }
        .settings-page .footer-actions { display: flex; gap: 1rem; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border-subtle); }
        .settings-page .ssh-box { 
          background: #000; padding: 1.5rem; border-radius: var(--radius-md); 
          margin: 1.5rem 0; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85rem; color: var(--success);
          border: 1px solid #333; box-shadow: inset 0 2px 10px rgba(0,0,0,0.5);
        }
        .ml-auto { margin-left: auto; }
        .font-bold { font-weight: 700; }
        .tiny { font-size: 0.7rem; }
        .glass-card { background: var(--bg-glass); border-color: var(--border-subtle); }
      `
        }
      })
    ]
  });
}
