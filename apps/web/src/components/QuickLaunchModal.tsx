import { useState, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";

type Project = { id: string; name: string };

type Props = {
  projects: Project[];
  onClose: () => void;
  onLaunched: () => void;
};

type Step = 1 | 2 | 3 | 4;
type LaunchStatus = "idle" | "launching" | "success" | "failed";

export function QuickLaunchModal({ projects, onClose, onLaunched }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<"local" | "github">("local");
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [enableTunnel, setEnableTunnel] = useState(true);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>("idle");
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ReturnType<typeof connectLogs> | null>(null);

  // Auto-scroll build log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [buildLog]);

  // Connect WebSocket when on step 4
  useEffect(() => {
    if (step !== 4) return;
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as Record<string, unknown>;
      if (typed.type === "build_log" && typeof typed.line === "string") {
        setBuildLog((prev) => [...prev, typed.line as string]);
      }
      if (typed.type === "build_progress" && typeof typed.phase === "string") {
        setBuildLog((prev) => [...prev, `▶ Phase: ${typed.phase as string}`]);
      }
      if (typed.type === "tunnel_url" && typed.serviceId === serviceId && typeof typed.tunnelUrl === "string") {
        setTunnelUrl(typed.tunnelUrl as string);
      }
    });
    wsRef.current = ws;
    return () => { ws.close(); wsRef.current = null; };
  }, [step, serviceId]);

  function canAdvance(): boolean {
    if (step === 1) return source === "local" ? localPath.trim().length > 0 : repoUrl.trim().length > 0;
    if (step === 2) return name.trim().length > 0 && Boolean(projectId);
    return true;
  }

  async function handleLaunch(): Promise<void> {
    setStep(4);
    setLaunchStatus("launching");
    setBuildLog([]);
    setTunnelUrl(null);
    setServiceId(null);

    try {
      let result: { service?: { id?: string }; deployment?: { status?: string } };

      if (source === "local") {
        result = await api<typeof result>("/services/deploy-from-local", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name: name.trim(),
            localPath: localPath.trim(),
            port: port ? Number(port) : undefined,
            startAfterDeploy: true,
            enableQuickTunnel: enableTunnel
          })
        });
      } else {
        result = await api<typeof result>("/services/deploy-from-github", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name: name.trim(),
            repoUrl: repoUrl.trim(),
            port: port ? Number(port) : undefined,
            startAfterDeploy: true,
            autoPull: true
          })
        });
        // For GitHub deploys, start quick tunnel separately if enabled
        if (enableTunnel && result?.service?.id && result?.deployment?.status === "success") {
          try {
            await api(`/cloudflare/quick-tunnel/${result.service.id}`, { method: "POST" });
          } catch { /* ignore — tunnel is best-effort */ }
        }
      }

      const svcId = result?.service?.id ?? null;
      setServiceId(svcId);

      if (result?.deployment?.status !== "success") {
        setLaunchStatus("failed");
        return;
      }

      setLaunchStatus("success");

      // Poll for tunnel URL if tunnel was requested
      if (enableTunnel && svcId) {
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          try {
            const svc = await api<{ tunnel_url?: string | null }>(`/services/${svcId}`);
            if (svc.tunnel_url) {
              setTunnelUrl(svc.tunnel_url);
              break;
            }
          } catch { break; }
        }
      }
    } catch {
      setLaunchStatus("failed");
    }
  }

  const steps: Array<{ label: string }> = [
    { label: "Source" },
    { label: "Details" },
    { label: "Options" },
    { label: "Launch" }
  ];

  return (
    <div className="modal-overlay" onClick={launchStatus === "idle" ? onClose : undefined}>
      <div className="card github-deploy-modal" style={{ maxWidth: "580px" }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <div style={{ background: "var(--success-soft)", padding: "0.6rem", borderRadius: "var(--radius-sm)", color: "var(--success)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </div>
            <div>
              <h3 style={{ margin: 0 }}>Quick Launch</h3>
              <p className="gh-hint">Deploy any app and get a public Cloudflare URL in seconds.</p>
            </div>
          </div>
          <div className="gh-step-indicator">
            {steps.map((s, i) => (
              <div key={s.label} className={`gh-step ${step === i + 1 ? "active" : step > i + 1 ? "done" : ""}`}>
                <span className="gh-step-dot">{step > i + 1 ? "✓" : i + 1}</span>
                <span className="gh-step-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Step 1: Source */}
        {step === 1 && (
          <div className="gh-step-content">
            <div className="gh-field-group">
              <label className="gh-label">Source type</label>
              <div className="row" style={{ gap: "0.75rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontWeight: source === "local" ? 600 : 400 }}>
                  <input type="radio" name="source" value="local" checked={source === "local"} onChange={() => setSource("local")} />
                  Local directory
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontWeight: source === "github" ? 600 : 400 }}>
                  <input type="radio" name="source" value="github" checked={source === "github"} onChange={() => setSource("github")} />
                  GitHub URL
                </label>
              </div>
            </div>

            {source === "local" ? (
              <div className="gh-field-group">
                <label className="gh-label">Local path <span className="gh-required">*</span></label>
                <input
                  placeholder="/home/user/my-app"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  autoFocus
                />
                <p className="gh-hint">Absolute path to the directory containing your app. The system will auto-detect Node.js, Python, or Docker.</p>
              </div>
            ) : (
              <div className="gh-field-group">
                <label className="gh-label">GitHub repo URL <span className="gh-required">*</span></label>
                <input
                  placeholder="https://github.com/user/repo.git"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  autoFocus
                />
                <p className="gh-hint">Public repos work without setup. For private repos, configure a GitHub PAT in Settings first.</p>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Details */}
        {step === 2 && (
          <div className="gh-step-content">
            <div className="gh-field-group">
              <label className="gh-label">Project <span className="gh-required">*</span></label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="gh-field-row">
              <div className="gh-field-group" style={{ flex: 2 }}>
                <label className="gh-label">Service name <span className="gh-required">*</span></label>
                <input
                  placeholder="my-app"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="gh-field-group" style={{ flex: 1 }}>
                <label className="gh-label">Port <span className="gh-optional">(auto)</span></label>
                <input
                  placeholder="3000"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  type="number"
                  min="1"
                  max="65535"
                />
              </div>
            </div>
            <p className="gh-hint">If no port is set, one is auto-assigned (3000–3999) and injected as the <code>PORT</code> env var.</p>
          </div>
        )}

        {/* Step 3: Options */}
        {step === 3 && (
          <div className="gh-step-content">
            <label className="gh-toggle">
              <input
                type="checkbox"
                checked={enableTunnel}
                onChange={(e) => setEnableTunnel(e.target.checked)}
              />
              <div className="gh-toggle-info">
                <span className="gh-toggle-title">Enable quick tunnel</span>
                <span className="gh-toggle-desc">
                  Generates a public <strong>*.trycloudflare.com</strong> URL via <code>cloudflared</code> — no Cloudflare account required. URL is temporary and changes on restart.
                </span>
              </div>
            </label>
            <p className="gh-hint" style={{ marginTop: "var(--space-3)" }}>
              The <code>cloudflared</code> binary is auto-downloaded to <code>~/.survhub/bin/</code> if not already installed.
            </p>
          </div>
        )}

        {/* Step 4: Launch */}
        {step === 4 && (
          <div className="gh-step-content">
            {launchStatus === "launching" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <div className="status-dot running" />
                  <span style={{ fontWeight: 600 }}>Deploying…</span>
                </div>
                <div ref={logRef} className="logs" style={{ maxHeight: "220px", overflowY: "auto", background: "var(--bg-sunken)", borderRadius: "var(--radius-sm)", padding: "0.75rem", fontSize: "0.75rem" }}>
                  {buildLog.map((line, i) => <p key={i} style={{ margin: 0 }}>{line}</p>)}
                  {buildLog.length === 0 && <p style={{ margin: 0, color: "var(--text-dim)" }}>Starting build…</p>}
                </div>
              </div>
            )}

            {launchStatus === "success" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                <div className="row" style={{ gap: "0.5rem", color: "var(--success)", fontWeight: 600 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  App deployed and running!
                </div>

                {enableTunnel && !tunnelUrl && (
                  <div className="row" style={{ gap: "0.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                    <div className="status-dot running" />
                    Waiting for tunnel URL… (can take ~15s)
                  </div>
                )}

                {tunnelUrl && (
                  <div style={{ background: "rgba(34,197,94,0.06)", border: "1px solid var(--success-soft)", borderRadius: "var(--radius-sm)", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                    <div style={{ fontWeight: 600, color: "var(--success)", fontSize: "0.85rem" }}>Your public URL is ready:</div>
                    <a href={tunnelUrl} target="_blank" rel="noreferrer" style={{ color: "var(--success)", fontWeight: 700, wordBreak: "break-all" }}>{tunnelUrl}</a>
                    <button
                      className="ghost"
                      style={{ alignSelf: "flex-start", padding: "0.3rem 0.8rem", fontSize: "0.78rem" }}
                      onClick={() => { void navigator.clipboard.writeText(tunnelUrl); toast.success("URL copied!"); }}
                    >
                      Copy URL
                    </button>
                  </div>
                )}

                {enableTunnel && !tunnelUrl && (
                  <p className="gh-hint">The tunnel URL will appear here automatically. You can also close this and see it on the service card.</p>
                )}
              </div>
            )}

            {launchStatus === "failed" && (
              <div style={{ color: "var(--danger)", fontWeight: 600 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: "middle", marginRight: "0.4rem" }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                Deploy failed. Check the service logs for details.
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="gh-actions">
          {step < 4 && (
            <>
              <button className="ghost" onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as Step)}>
                {step === 1 ? "Cancel" : "Back"}
              </button>
              {step < 3 ? (
                <button className="primary" disabled={!canAdvance()} onClick={() => setStep((s) => (s + 1) as Step)}>
                  Next
                </button>
              ) : (
                <button className="primary" onClick={() => void handleLaunch()}>
                  Launch
                </button>
              )}
            </>
          )}
          {step === 4 && launchStatus !== "launching" && (
            <button
              className="primary"
              onClick={() => { if (launchStatus === "success") onLaunched(); else onClose(); }}
            >
              {launchStatus === "success" ? "Done" : "Close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
