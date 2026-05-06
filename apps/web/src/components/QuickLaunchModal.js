import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from "react";
import {
  FolderOpen,
  GitBranch,
  Globe2,
  Laptop,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Terminal
} from "lucide-react";
import { api } from "../lib/api";
import { inferNameFromRepoUrl } from "../lib/repo";
import { toast } from "../lib/toast";
export function QuickLaunchModal({ projects, onClose, onLaunched }) {
  const [step, setStep] = useState(1);
  const [source, setSource] = useState("local");
  const [exposure, setExposure] = useState("local");
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [command, setCommand] = useState("");
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [buildLog, setBuildLog] = useState([]);
  const [tunnelUrl, setTunnelUrl] = useState(null);
  const logRef = useRef(null);
  const canLaunch =
    Boolean(name.trim()) &&
    (source === "github"
      ? Boolean(repoUrl.trim())
      : Boolean(localPath.trim()) && (Boolean(command.trim()) || scan?.buildType === "docker"));
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buildLog]);
  useEffect(() => {
    if (!projectId && projects[0]?.id) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);
  function handleRepoUrlChange(value) {
    const previousInferred = inferNameFromRepoUrl(repoUrl);
    const nextInferred = inferNameFromRepoUrl(value);
    setRepoUrl(value);
    if (nextInferred && (!name.trim() || name === previousInferred)) {
      setName(nextInferred);
    }
  }
  async function scanLocalPath() {
    if (!localPath.trim()) {
      toast.error("Local folder path is required");
      return;
    }
    setScanning(true);
    try {
      const result = await api("/services/scan-local-project", {
        method: "POST",
        body: JSON.stringify({ localPath: localPath.trim() })
      });
      setScan(result);
      if (!name.trim()) setName(result.name);
      const recommended = result.candidates.find((item) => item.recommended) ?? result.candidates[0];
      if (recommended) {
        setCommand(recommended.command);
        if (!port && recommended.port) setPort(String(recommended.port));
      }
      toast.success(
        `Found ${result.candidates.length} launch candidate${result.candidates.length === 1 ? "" : "s"}`
      );
    } catch {
      setScan(null);
    } finally {
      setScanning(false);
    }
  }
  async function handleLaunch() {
    const allowsEmptyCommand = source === "local" && scan?.buildType === "docker";
    if (source === "local" && !command.trim() && !allowsEmptyCommand) {
      toast.error("Choose or enter a dev server command");
      return;
    }
    setLoading(true);
    setBuildLog(["Initializing deployment environment..."]);
    setStep(2);
    try {
      let launchProjectId = projectId;
      if (!launchProjectId) {
        setBuildLog((prev) => [...prev, "No project selected. Creating Default Project..."]);
        const project = await api("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Default Project" })
        });
        launchProjectId = project.id;
        setProjectId(project.id);
        setBuildLog((prev) => [...prev, "Default Project ready."]);
      }
      const result = await api(
        source === "local" ? "/services/deploy-from-local" : "/services/deploy-from-github",
        {
          method: "POST",
          body: JSON.stringify({
            projectId: launchProjectId,
            name: name.trim(),
            localPath: source === "local" ? localPath.trim() : undefined,
            repoUrl: source === "github" ? repoUrl.trim() : undefined,
            command: source === "local" ? command.trim() : undefined,
            port: port ? Number(port) : undefined,
            startAfterDeploy: true,
            enableQuickTunnel: exposure === "online"
          })
        }
      );
      const svcId = result?.service?.id;
      if (!svcId) {
        setBuildLog((prev) => [...prev, "Deployment failed: Service ID not returned"]);
        return;
      }
      setBuildLog((prev) => [...prev, "Service registered. Waiting for activation..."]);
      if (exposure === "local") {
        toast.success("Local launch registered");
        setBuildLog((prev) => [
          ...prev,
          "Local mode selected. Service is available on the assigned local port."
        ]);
        return;
      }
      // Poll for tunnel/status
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const svc = await api(`/services/${svcId}`, { silent: true });
          if (svc.tunnel_url) {
            setTunnelUrl(svc.tunnel_url);
            setBuildLog((prev) => [...prev, `Public URL ready: ${svc.tunnel_url}`]);
            toast.success("Quick Launch Successful!");
            break;
          }
          if (i === 15) setBuildLog((prev) => [...prev, "Still provisioning edge routing..."]);
        } catch {
          break;
        }
      }
    } catch (err) {
      setBuildLog((prev) => [...prev, `Error: ${err instanceof Error ? err.message : "Deployment failed"}`]);
    } finally {
      setLoading(false);
    }
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
            _jsxs("div", {
              className: "row",
              children: [
                _jsx("div", { className: "launch-icon", children: _jsx(Play, { size: 22 }) }),
                _jsx("h3", { children: "Quick Launch Pipeline" })
              ]
            }),
            _jsx("p", {
              className: "hint",
              children:
                "Import a local folder or paste a GitHub repository URL, then run it locally or through a tunnel."
            })
          ]
        }),
        _jsx("div", {
          className: "modal-body",
          children:
            step === 1
              ? _jsxs("div", {
                  style: { display: "grid", gap: "1.5rem" },
                  children: [
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", { children: "Deployment Method" }),
                        _jsxs("div", {
                          className: "row",
                          style: { gap: "1rem" },
                          children: [
                            _jsxs("button", {
                              className: `ghost ${source === "local" ? "active-btn" : ""}`,
                              onClick: () => setSource("local"),
                              "aria-label": "Import from a local folder",
                              "data-tooltip": "Import from a folder on this machine",
                              children: [_jsx(FolderOpen, { size: 16 }), " Local Folder"]
                            }),
                            _jsxs("button", {
                              className: `ghost ${source === "github" ? "active-btn" : ""}`,
                              onClick: () => setSource("github"),
                              "aria-label": "Import from a GitHub URL",
                              "data-tooltip": "Import from a remote GitHub repository",
                              children: [_jsx(GitBranch, { size: 16 }), " GitHub URL"]
                            })
                          ]
                        })
                      ]
                    }),
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", {
                          children: source === "local" ? "Local System Path" : "Repository URL"
                        }),
                        _jsxs("div", {
                          className: "row",
                          children: [
                            _jsx("input", {
                              placeholder:
                                source === "local" ? "/Users/tobias/my-app" : "https://github.com/user/app",
                              value: source === "local" ? localPath : repoUrl,
                              onChange: (e) => {
                                if (source === "local") {
                                  setLocalPath(e.target.value);
                                  setScan(null);
                                } else {
                                  handleRepoUrlChange(e.target.value);
                                }
                              }
                            }),
                            source === "local" &&
                              _jsxs("button", {
                                className: "ghost",
                                onClick: () => void scanLocalPath(),
                                disabled: scanning,
                                "aria-label": "Scan local folder for dev servers",
                                "data-tooltip": scanning
                                  ? "Scanning folder..."
                                  : "Find runnable dev server commands",
                                "data-tooltip-side": "left",
                                children: [
                                  scanning
                                    ? _jsx(Loader2, { size: 16, className: "animate-spin" })
                                    : _jsx(Search, { size: 16 }),
                                  "Scan"
                                ]
                              })
                          ]
                        })
                      ]
                    }),
                    source === "local" &&
                      scan &&
                      _jsxs("div", {
                        className: "scan-panel",
                        children: [
                          _jsxs("div", {
                            className: "row between",
                            children: [
                              _jsxs("div", {
                                children: [
                                  _jsxs("div", {
                                    className: "font-bold text-primary",
                                    children: ["Detected ", scan.buildType, " project"]
                                  }),
                                  _jsxs("p", {
                                    className: "muted small",
                                    children: [
                                      scan.candidates.length,
                                      " possible dev server",
                                      scan.candidates.length === 1 ? "" : "s",
                                      " found."
                                    ]
                                  })
                                ]
                              }),
                              _jsxs("button", {
                                className: "ghost xsmall",
                                onClick: () => void scanLocalPath(),
                                "aria-label": "Rescan local folder",
                                "data-tooltip": "Refresh detected commands",
                                children: [_jsx(RefreshCw, { size: 13 }), " Rescan"]
                              })
                            ]
                          }),
                          scan.warnings.map((warning) =>
                            _jsx("div", { className: "scan-warning", children: warning }, warning)
                          ),
                          _jsx("div", {
                            className: "candidate-list",
                            children: scan.candidates.map((candidate) =>
                              _jsxs(
                                "button",
                                {
                                  className: `candidate-item ${command === candidate.command ? "active" : ""}`,
                                  "aria-label": `Use ${candidate.label}: ${candidate.command || "Dockerfile service"}`,
                                  "data-tooltip": "Use this launch command",
                                  onClick: () => {
                                    setCommand(candidate.command);
                                    if (!port && candidate.port) setPort(String(candidate.port));
                                  },
                                  children: [
                                    _jsx(Terminal, { size: 16 }),
                                    _jsxs("span", {
                                      children: [
                                        _jsx("strong", { children: candidate.label }),
                                        _jsx("code", { children: candidate.command || "Dockerfile service" })
                                      ]
                                    }),
                                    candidate.recommended &&
                                      _jsx("span", { className: "badge accent", children: "Recommended" })
                                  ]
                                },
                                candidate.id
                              )
                            )
                          })
                        ]
                      }),
                    source === "local" &&
                      _jsxs("div", {
                        className: "form-group",
                        children: [
                          _jsx("label", { children: "Dev Server Command" }),
                          _jsx("input", {
                            value: command,
                            onChange: (event) => setCommand(event.target.value),
                            placeholder: "npm run dev"
                          })
                        ]
                      }),
                    source === "github" &&
                      _jsx("div", {
                        className: "scan-panel",
                        children: _jsxs("div", {
                          className: "row",
                          children: [
                            _jsx(GitBranch, { size: 16, className: "text-accent" }),
                            _jsxs("div", {
                              children: [
                                _jsx("div", {
                                  className: "font-bold text-primary",
                                  children: "GitHub direct launch"
                                }),
                                _jsx("p", {
                                  className: "muted small",
                                  children:
                                    "LocalSURV will clone the URL, detect the runtime, run the build pipeline, and register the service."
                                })
                              ]
                            })
                          ]
                        })
                      }),
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", { children: "Exposure Mode" }),
                        _jsxs("div", {
                          className: "mode-toggle",
                          children: [
                            _jsxs("button", {
                              className: exposure === "local" ? "active" : "",
                              onClick: () => setExposure("local"),
                              "aria-label": "Use local-only exposure mode",
                              "data-tooltip": "Keep the service on this machine",
                              children: [
                                _jsx(Laptop, { size: 16 }),
                                _jsxs("span", {
                                  children: [
                                    _jsx("strong", { children: "Local" }),
                                    _jsx("small", { children: "Bind to this machine only" })
                                  ]
                                })
                              ]
                            }),
                            _jsxs("button", {
                              className: exposure === "online" ? "active" : "",
                              onClick: () => setExposure("online"),
                              "aria-label": "Use online tunnel exposure mode",
                              "data-tooltip": "Create a temporary public tunnel",
                              children: [
                                _jsx(Globe2, { size: 16 }),
                                _jsxs("span", {
                                  children: [
                                    _jsx("strong", { children: "Online tunnel" }),
                                    _jsx("small", { children: "Create a public Cloudflare URL" })
                                  ]
                                })
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
                            _jsx("label", { children: "App Name" }),
                            _jsx("input", {
                              value: name,
                              onChange: (e) => setName(e.target.value),
                              placeholder: "my-quick-app"
                            })
                          ]
                        }),
                        _jsxs("div", {
                          className: "form-group",
                          children: [
                            _jsx("label", { children: "Project" }),
                            _jsxs("select", {
                              value: projectId,
                              onChange: (e) => setProjectId(e.target.value),
                              children: [
                                !projectId &&
                                  projects.length === 0 &&
                                  _jsx("option", { value: "", children: "Default Project will be created" }),
                                projects.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))
                              ]
                            })
                          ]
                        })
                      ]
                    }),
                    _jsxs("div", {
                      className: "form-group",
                      children: [
                        _jsx("label", { children: "Port" }),
                        _jsx("input", {
                          value: port,
                          onChange: (e) => setPort(e.target.value),
                          placeholder: "Auto assign if empty"
                        })
                      ]
                    })
                  ]
                })
              : _jsxs("div", {
                  className: "launch-monitor",
                  style: { display: "flex", flexDirection: "column", gap: "1rem" },
                  children: [
                    _jsx("div", {
                      className: "logs-viewer",
                      ref: logRef,
                      style: { height: "240px", fontSize: "0.8rem", background: "black" },
                      children: buildLog.map((line, i) =>
                        _jsx("div", { className: "log-line", children: line }, i)
                      )
                    }),
                    tunnelUrl &&
                      _jsx("div", {
                        className: "card featured-form",
                        style: { padding: "1rem", border: "1px solid var(--success)" },
                        children: _jsxs("div", {
                          className: "row between",
                          children: [
                            _jsx("span", { className: "success font-bold", children: "LIVE URL:" }),
                            _jsx("a", {
                              href: tunnelUrl,
                              target: "_blank",
                              rel: "noreferrer",
                              className: "link font-bold",
                              children: tunnelUrl
                            })
                          ]
                        })
                      })
                  ]
                })
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", {
              className: "ghost",
              onClick: onClose,
              "aria-label": "Close quick launch without saving",
              "data-tooltip": "Close without launching",
              children: "Discard"
            }),
            step === 1 &&
              _jsx("button", {
                className: "primary",
                onClick: handleLaunch,
                disabled: !canLaunch || loading,
                "aria-label": "Start the selected launch pipeline",
                "data-tooltip": "Create and start this service",
                children: "Initialize Launch Sequence"
              }),
            step === 2 &&
              _jsx("button", {
                className: "primary",
                onClick: onLaunched,
                "aria-label": "Close launch monitor",
                "data-tooltip": "Return to services",
                children: "Close Monitor"
              })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
            __html: `
          .launch-icon { background: var(--accent-gradient); color: white; padding: 0.5rem; border-radius: var(--radius-sm); display: flex; }
          .active-btn { background: var(--accent-gradient) !important; color: white !important; }
          .success { color: var(--success); }
          .scan-panel { display: grid; gap: 1rem; padding: 1rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-sunken); }
          .scan-warning { padding: 0.65rem 0.75rem; border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); font-size: 0.8rem; font-weight: 700; }
          .candidate-list { display: grid; gap: 0.6rem; }
          .candidate-item { justify-content: flex-start; text-align: left; background: var(--bg-elevated); }
          .candidate-item.active { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
          .candidate-item span { display: grid; gap: 0.2rem; min-width: 0; }
          .candidate-item code { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.74rem; white-space: normal; word-break: break-word; }
          .mode-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
          .mode-toggle button { justify-content: flex-start; text-align: left; background: var(--bg-sunken); }
          .mode-toggle button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text-primary); }
          .mode-toggle span { display: grid; gap: 0.2rem; }
          .mode-toggle small { color: var(--text-muted); font-size: 0.72rem; }
          .animate-spin { animation: spin 1s linear infinite; }
          @media (max-width: 640px) { .mode-toggle { grid-template-columns: 1fr; } }
        `
          }
        })
      ]
    })
  });
}
