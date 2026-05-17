import { jsx, jsxs } from "react/jsx-runtime";
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
function QuickLaunchModal({ projects, onClose, onLaunched }) {
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
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(false);
  const [buildLog, setBuildLog] = useState([]);
  const [tunnelUrl, setTunnelUrl] = useState(null);
  const logRef = useRef(null);
  const canLaunch = Boolean(name.trim()) && (source === "github" ? Boolean(repoUrl.trim()) : Boolean(localPath.trim()) && (Boolean(command.trim()) || scan?.buildType === "docker"));
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buildLog]);
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
      const launchProjectId = projectId;
      if (!launchProjectId) {
        setBuildLog((prev) => [...prev, "No project selected. LocalSURV will create or reuse an app project."]);
      }
      const result = await api(
        source === "local" ? "/services/deploy-from-local" : "/services/deploy-from-github",
        {
          method: "POST",
          body: JSON.stringify({
            projectId: launchProjectId,
            name: name.trim(),
            localPath: source === "local" ? localPath.trim() : void 0,
            repoUrl: source === "github" ? repoUrl.trim() : void 0,
            command: source === "local" ? command.trim() : void 0,
            port: port ? Number(port) : void 0,
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
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2e3));
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
  return /* @__PURE__ */ jsx("div", { className: "modal-overlay", onClick: onClose, children: /* @__PURE__ */ jsxs("div", { className: "modal-content", style: { maxWidth: "600px" }, onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ jsxs("header", { className: "modal-header", children: [
      /* @__PURE__ */ jsxs("div", { className: "row", children: [
        /* @__PURE__ */ jsx("div", { className: "launch-icon", children: /* @__PURE__ */ jsx(Play, { size: 22 }) }),
        /* @__PURE__ */ jsx("h3", { children: "Quick Launch Pipeline" })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "hint", children: "Import a local folder or paste a GitHub repository URL, then run it locally or through a tunnel." })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "modal-body", children: step === 1 ? /* @__PURE__ */ jsxs("div", { style: { display: "grid", gap: "1.5rem" }, children: [
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Deployment Method" }),
        /* @__PURE__ */ jsxs("div", { className: "row", style: { gap: "1rem" }, children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: `ghost ${source === "local" ? "active-btn" : ""}`,
              onClick: () => setSource("local"),
              "aria-label": "Import from a local folder",
              "data-tooltip": "Import from a folder on this machine",
              children: [
                /* @__PURE__ */ jsx(FolderOpen, { size: 16 }),
                " Local Folder"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: `ghost ${source === "github" ? "active-btn" : ""}`,
              onClick: () => setSource("github"),
              "aria-label": "Import from a GitHub URL",
              "data-tooltip": "Import from a remote GitHub repository",
              children: [
                /* @__PURE__ */ jsx(GitBranch, { size: 16 }),
                " GitHub URL"
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: source === "local" ? "Local System Path" : "Repository URL" }),
        /* @__PURE__ */ jsxs("div", { className: "row", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: source === "local" ? "/Users/tobias/my-app" : "https://github.com/user/app",
              value: source === "local" ? localPath : repoUrl,
              onChange: (e) => {
                if (source === "local") {
                  setLocalPath(e.target.value);
                  setScan(null);
                } else {
                  handleRepoUrlChange(e.target.value);
                }
              }
            }
          ),
          source === "local" && /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost",
              onClick: () => void scanLocalPath(),
              disabled: scanning,
              "aria-label": "Scan local folder for dev servers",
              "data-tooltip": scanning ? "Scanning folder..." : "Find runnable dev server commands",
              "data-tooltip-side": "left",
              children: [
                scanning ? /* @__PURE__ */ jsx(Loader2, { size: 16, className: "animate-spin" }) : /* @__PURE__ */ jsx(Search, { size: 16 }),
                "Scan"
              ]
            }
          )
        ] })
      ] }),
      source === "local" && scan && /* @__PURE__ */ jsxs("div", { className: "scan-panel", children: [
        /* @__PURE__ */ jsxs("div", { className: "row between", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsxs("div", { className: "font-bold text-primary", children: [
              "Detected ",
              scan.buildType,
              " project"
            ] }),
            /* @__PURE__ */ jsxs("p", { className: "muted small", children: [
              scan.candidates.length,
              " possible dev server",
              scan.candidates.length === 1 ? "" : "s",
              " ",
              "found."
            ] })
          ] }),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost xsmall",
              onClick: () => void scanLocalPath(),
              "aria-label": "Rescan local folder",
              "data-tooltip": "Refresh detected commands",
              children: [
                /* @__PURE__ */ jsx(RefreshCw, { size: 13 }),
                " Rescan"
              ]
            }
          )
        ] }),
        scan.warnings.map((warning) => /* @__PURE__ */ jsx("div", { className: "scan-warning", children: warning }, warning)),
        /* @__PURE__ */ jsx("div", { className: "candidate-list", children: scan.candidates.map((candidate) => /* @__PURE__ */ jsxs(
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
              /* @__PURE__ */ jsx(Terminal, { size: 16 }),
              /* @__PURE__ */ jsxs("span", { children: [
                /* @__PURE__ */ jsx("strong", { children: candidate.label }),
                /* @__PURE__ */ jsx("code", { children: candidate.command || "Dockerfile service" })
              ] }),
              candidate.recommended && /* @__PURE__ */ jsx("span", { className: "badge accent", children: "Recommended" })
            ]
          },
          candidate.id
        )) })
      ] }),
      source === "local" && /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Dev Server Command" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            value: command,
            onChange: (event) => setCommand(event.target.value),
            placeholder: "npm run dev"
          }
        )
      ] }),
      source === "github" && /* @__PURE__ */ jsx("div", { className: "scan-panel", children: /* @__PURE__ */ jsxs("div", { className: "row", children: [
        /* @__PURE__ */ jsx(GitBranch, { size: 16, className: "text-accent" }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("div", { className: "font-bold text-primary", children: "GitHub direct launch" }),
          /* @__PURE__ */ jsx("p", { className: "muted small", children: "LocalSURV will clone the URL, detect the runtime, run the build pipeline, and register the service." })
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Exposure Mode" }),
        /* @__PURE__ */ jsxs("div", { className: "mode-toggle", children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: exposure === "local" ? "active" : "",
              onClick: () => setExposure("local"),
              "aria-label": "Use local-only exposure mode",
              "data-tooltip": "Keep the service on this machine",
              children: [
                /* @__PURE__ */ jsx(Laptop, { size: 16 }),
                /* @__PURE__ */ jsxs("span", { children: [
                  /* @__PURE__ */ jsx("strong", { children: "Local" }),
                  /* @__PURE__ */ jsx("small", { children: "Bind to this machine only" })
                ] })
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: exposure === "online" ? "active" : "",
              onClick: () => setExposure("online"),
              "aria-label": "Use online tunnel exposure mode",
              "data-tooltip": "Create a temporary public tunnel",
              children: [
                /* @__PURE__ */ jsx(Globe2, { size: 16 }),
                /* @__PURE__ */ jsxs("span", { children: [
                  /* @__PURE__ */ jsx("strong", { children: "Online tunnel" }),
                  /* @__PURE__ */ jsx("small", { children: "Create a public Cloudflare URL" })
                ] })
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-row", children: [
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsx("label", { children: "App Name" }),
          /* @__PURE__ */ jsx("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "my-quick-app" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsx("label", { children: "Project" }),
          /* @__PURE__ */ jsxs("select", { value: projectId, onChange: (e) => setProjectId(e.target.value), children: [
            /* @__PURE__ */ jsx("option", { value: "", children: "Auto: create or reuse app project" }),
            projects.map((p) => /* @__PURE__ */ jsx("option", { value: p.id, children: p.name }, p.id))
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Port" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            value: port,
            onChange: (e) => setPort(e.target.value),
            placeholder: "Auto assign if empty"
          }
        )
      ] })
    ] }) : /* @__PURE__ */ jsxs("div", { className: "launch-monitor", style: { display: "flex", flexDirection: "column", gap: "1rem" }, children: [
      /* @__PURE__ */ jsx(
        "div",
        {
          className: "logs-viewer",
          ref: logRef,
          style: { height: "240px", fontSize: "0.8rem", background: "black" },
          children: buildLog.map((line, i) => /* @__PURE__ */ jsx("div", { className: "log-line", children: line }, i))
        }
      ),
      tunnelUrl && /* @__PURE__ */ jsx(
        "div",
        {
          className: "card featured-form",
          style: { padding: "1rem", border: "1px solid var(--success)" },
          children: /* @__PURE__ */ jsxs("div", { className: "row between", children: [
            /* @__PURE__ */ jsx("span", { className: "success font-bold", children: "LIVE URL:" }),
            /* @__PURE__ */ jsx("a", { href: tunnelUrl, target: "_blank", rel: "noreferrer", className: "link font-bold", children: tunnelUrl })
          ] })
        }
      )
    ] }) }),
    /* @__PURE__ */ jsxs("footer", { className: "modal-footer", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "ghost",
          onClick: onClose,
          "aria-label": "Close quick launch without saving",
          "data-tooltip": "Close without launching",
          children: "Discard"
        }
      ),
      step === 1 && /* @__PURE__ */ jsx(
        "button",
        {
          className: "primary",
          onClick: handleLaunch,
          disabled: !canLaunch || loading,
          "aria-label": "Start the selected launch pipeline",
          "data-tooltip": "Create and start this service",
          children: "Initialize Launch Sequence"
        }
      ),
      step === 2 && /* @__PURE__ */ jsx(
        "button",
        {
          className: "primary",
          onClick: onLaunched,
          "aria-label": "Close launch monitor",
          "data-tooltip": "Return to services",
          children: "Close Monitor"
        }
      )
    ] }),
    /* @__PURE__ */ jsx(
      "style",
      {
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
      }
    )
  ] }) });
}
export {
  QuickLaunchModal
};
