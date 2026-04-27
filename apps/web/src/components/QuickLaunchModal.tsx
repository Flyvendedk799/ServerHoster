import { useState, useEffect, useRef } from "react";
import { FolderOpen, GitBranch, Globe2, Laptop, Loader2, Play, RefreshCw, Search, Terminal } from "lucide-react";
import { api } from "../lib/api";
import { inferNameFromRepoUrl } from "../lib/repo";
import { toast } from "../lib/toast";

type Project = { id: string; name: string };
type Props = {
  projects: Project[];
  onClose: () => void;
  onLaunched: () => void;
};

type DevServerCandidate = {
  id: string;
  label: string;
  command: string;
  source: string;
  port?: number;
  recommended?: boolean;
};

type LocalProjectScan = {
  name: string;
  buildType: string;
  candidates: DevServerCandidate[];
  warnings: string[];
};

export function QuickLaunchModal({ projects, onClose, onLaunched }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<"local" | "github">("local");
  const [exposure, setExposure] = useState<"local" | "online">("local");
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [command, setCommand] = useState("");
  const [scan, setScan] = useState<LocalProjectScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const canLaunch =
    Boolean(name.trim()) &&
    (
      source === "github"
        ? Boolean(repoUrl.trim())
        : Boolean(localPath.trim()) && (Boolean(command.trim()) || scan?.buildType === "docker")
    );

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buildLog]);

  useEffect(() => {
    if (!projectId && projects[0]?.id) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);

  function handleRepoUrlChange(value: string) {
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
      const result = await api<LocalProjectScan>("/services/scan-local-project", {
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
      toast.success(`Found ${result.candidates.length} launch candidate${result.candidates.length === 1 ? "" : "s"}`);
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
        setBuildLog(prev => [...prev, "No project selected. Creating Default Project..."]);
        const project = await api<Project>("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Default Project" })
        });
        launchProjectId = project.id;
        setProjectId(project.id);
        setBuildLog(prev => [...prev, "Default Project ready."]);
      }

      const result = await api<any>(source === "local" ? "/services/deploy-from-local" : "/services/deploy-from-github", {
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
      });

      const svcId = result?.service?.id;
      if (!svcId) {
        setBuildLog(prev => [...prev, "Deployment failed: Service ID not returned"]);
        return;
      }

      setBuildLog(prev => [...prev, "Service registered. Waiting for activation..."]);

      if (exposure === "local") {
        toast.success("Local launch registered");
        setBuildLog(prev => [...prev, "Local mode selected. Service is available on the assigned local port."]);
        return;
      }

      // Poll for tunnel/status
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const svc = await api<any>(`/services/${svcId}`, { silent: true });
          if (svc.tunnel_url) {
            setTunnelUrl(svc.tunnel_url);
            setBuildLog(prev => [...prev, `Public URL ready: ${svc.tunnel_url}`]);
            toast.success("Quick Launch Successful!");
            break;
          }
          if (i === 15) setBuildLog(prev => [...prev, "Still provisioning edge routing..."]);
        } catch { break; }
      }
    } catch (err) {
      setBuildLog(prev => [...prev, `Error: ${err instanceof Error ? err.message : "Deployment failed"}`]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
           <div className="row">
              <div className="launch-icon">
                <Play size={22} />
              </div>
              <h3>Quick Launch Pipeline</h3>
           </div>
           <p className="hint">
             Import a local folder or paste a GitHub repository URL, then run it locally or through a tunnel.
           </p>
        </header>

        <div className="modal-body">
           {step === 1 ? (
             <div style={{ display: "grid", gap: "1.5rem" }}>
                <div className="form-group">
                   <label>Deployment Method</label>
                   <div className="row" style={{ gap: "1rem" }}>
                      <button
                        className={`ghost ${source === 'local' ? 'active-btn' : ''}`}
                        onClick={() => setSource("local")}
                        aria-label="Import from a local folder"
                        data-tooltip="Import from a folder on this machine"
                      ><FolderOpen size={16} /> Local Folder</button>
                      <button
                        className={`ghost ${source === 'github' ? 'active-btn' : ''}`}
                        onClick={() => setSource("github")}
                        aria-label="Import from a GitHub URL"
                        data-tooltip="Import from a remote GitHub repository"
                      ><GitBranch size={16} /> GitHub URL</button>
                   </div>
                </div>

                <div className="form-group">
                   <label>{source === 'local' ? 'Local System Path' : 'Repository URL'}</label>
                   <div className="row">
                     <input
                      placeholder={source === 'local' ? '/Users/tobias/my-app' : 'https://github.com/user/app'}
                      value={source === 'local' ? localPath : repoUrl}
                      onChange={e => {
                        if (source === 'local') {
                          setLocalPath(e.target.value);
                          setScan(null);
                        } else {
                          handleRepoUrlChange(e.target.value);
                        }
                      }}
                     />
                     {source === "local" && (
                       <button
                         className="ghost"
                         onClick={() => void scanLocalPath()}
                         disabled={scanning}
                         aria-label="Scan local folder for dev servers"
                         data-tooltip={scanning ? "Scanning folder..." : "Find runnable dev server commands"}
                         data-tooltip-side="left"
                       >
                         {scanning ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                         Scan
                       </button>
                     )}
                   </div>
                </div>

                {source === "local" && scan && (
                  <div className="scan-panel">
                    <div className="row between">
                      <div>
                        <div className="font-bold text-primary">Detected {scan.buildType} project</div>
                        <p className="muted small">{scan.candidates.length} possible dev server{scan.candidates.length === 1 ? "" : "s"} found.</p>
                      </div>
                      <button
                        className="ghost xsmall"
                        onClick={() => void scanLocalPath()}
                        aria-label="Rescan local folder"
                        data-tooltip="Refresh detected commands"
                      ><RefreshCw size={13} /> Rescan</button>
                    </div>
                    {scan.warnings.map((warning) => (
                      <div key={warning} className="scan-warning">{warning}</div>
                    ))}
                    <div className="candidate-list">
                      {scan.candidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          className={`candidate-item ${command === candidate.command ? "active" : ""}`}
                          aria-label={`Use ${candidate.label}: ${candidate.command || "Dockerfile service"}`}
                          data-tooltip="Use this launch command"
                          onClick={() => {
                            setCommand(candidate.command);
                            if (!port && candidate.port) setPort(String(candidate.port));
                          }}
                        >
                          <Terminal size={16} />
                          <span>
                            <strong>{candidate.label}</strong>
                            <code>{candidate.command || "Dockerfile service"}</code>
                          </span>
                          {candidate.recommended && <span className="badge accent">Recommended</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {source === "local" && (
                  <div className="form-group">
                    <label>Dev Server Command</label>
                    <input
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder="npm run dev"
                    />
                  </div>
                )}

                {source === "github" && (
                  <div className="scan-panel">
                    <div className="row">
                      <GitBranch size={16} className="text-accent" />
                      <div>
                        <div className="font-bold text-primary">GitHub direct launch</div>
                        <p className="muted small">
                          LocalSURV will clone the URL, detect the runtime, run the build pipeline, and register the service.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label>Exposure Mode</label>
                  <div className="mode-toggle">
                    <button
                      className={exposure === "local" ? "active" : ""}
                      onClick={() => setExposure("local")}
                      aria-label="Use local-only exposure mode"
                      data-tooltip="Keep the service on this machine"
                    >
                      <Laptop size={16} />
                      <span>
                        <strong>Local</strong>
                        <small>Bind to this machine only</small>
                      </span>
                    </button>
                    <button
                      className={exposure === "online" ? "active" : ""}
                      onClick={() => setExposure("online")}
                      aria-label="Use online tunnel exposure mode"
                      data-tooltip="Create a temporary public tunnel"
                    >
                      <Globe2 size={16} />
                      <span>
                        <strong>Online tunnel</strong>
                        <small>Create a public Cloudflare URL</small>
                      </span>
                    </button>
                  </div>
                </div>

                <div className="form-row">
                   <div className="form-group">
                      <label>App Name</label>
                      <input value={name} onChange={e => setName(e.target.value)} placeholder="my-quick-app" />
                   </div>
                   <div className="form-group">
                      <label>Project</label>
                      <select value={projectId} onChange={e => setProjectId(e.target.value)}>
                         {!projectId && projects.length === 0 && <option value="">Default Project will be created</option>}
                         {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                   </div>
                </div>
                <div className="form-group">
                  <label>Port</label>
                  <input value={port} onChange={e => setPort(e.target.value)} placeholder="Auto assign if empty" />
                </div>
             </div>
           ) : (
             <div className="launch-monitor" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <div className="logs-viewer" ref={logRef} style={{ height: "240px", fontSize: "0.8rem", background: "black" }}>
                   {buildLog.map((line, i) => <div key={i} className="log-line">{line}</div>)}
                </div>
                {tunnelUrl && (
                  <div className="card featured-form" style={{ padding: "1rem", border: "1px solid var(--success)" }}>
                     <div className="row between">
                        <span className="success font-bold">LIVE URL:</span>
                        <a href={tunnelUrl} target="_blank" rel="noreferrer" className="link font-bold">{tunnelUrl}</a>
                     </div>
                  </div>
                )}
             </div>
           )}
        </div>

        <footer className="modal-footer">
           <button className="ghost" onClick={onClose} aria-label="Close quick launch without saving" data-tooltip="Close without launching">Discard</button>
           {step === 1 && <button className="primary" onClick={handleLaunch} disabled={!canLaunch || loading} aria-label="Start the selected launch pipeline" data-tooltip="Create and start this service">Initialize Launch Sequence</button>}
           {step === 2 && <button className="primary" onClick={onLaunched} aria-label="Close launch monitor" data-tooltip="Return to services">Close Monitor</button>}
        </footer>

        <style dangerouslySetInnerHTML={{ __html: `
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
        `}} />
      </div>
    </div>
  );
}
