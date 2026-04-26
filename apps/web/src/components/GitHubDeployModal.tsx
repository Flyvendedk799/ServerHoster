import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Project = { id: string; name: string };
type GitHubRepo = {
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
};

type Props = {
  projects: Project[];
  onClose: () => void;
  onDeployed: () => void;
};

type Step = 1 | 2 | 3;

export function GitHubDeployModal({ projects, onClose, onDeployed }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployProgress, setDeployProgress] = useState<{
    status: "idle" | "deploying" | "success" | "failed";
    message: string;
    log?: string;
  }>({ status: "idle", message: "" });

  const [form, setForm] = useState({
    projectId: projects[0]?.id ?? "",
    name: "",
    repoUrl: "",
    branch: "main",
    port: "",
    domain: "",
    startAfterDeploy: true,
    autoPull: true,
  });

  async function loadGithubRepos(): Promise<void> {
    setReposLoading(true);
    try {
      const rows = await api<GitHubRepo[]>("/github/repos");
      setGithubRepos(rows);
    } catch {
      /* api() toasts */
    } finally {
      setReposLoading(false);
    }
  }

  function selectRepo(repo: GitHubRepo): void {
    setForm((prev) => ({
      ...prev,
      repoUrl: repo.clone_url,
      branch: repo.default_branch || prev.branch,
      name: prev.name || repo.full_name.split("/")[1],
    }));
  }

  const filteredRepos = githubRepos.filter((r) =>
    r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  );

  function canAdvanceToStep2(): boolean {
    return form.repoUrl.trim().length > 0;
  }

  function canAdvanceToStep3(): boolean {
    return form.name.trim().length > 0 && form.projectId.length > 0;
  }

  async function deploy(): Promise<void> {
    setDeploying(true);
    setDeployProgress({ status: "deploying", message: "Cloning repository and running build pipeline…" });
    try {
      const result = await api<{
        deployment: { status: string; build_log?: string };
      }>("/services/deploy-from-github", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId || projects[0]?.id,
          name: form.name,
          repoUrl: form.repoUrl,
          branch: form.branch || "main",
          port: form.port ? Number(form.port) : undefined,
          startAfterDeploy: form.startAfterDeploy,
          domain: form.domain || undefined,
          autoPull: form.autoPull,
        }),
      });
      if (result.deployment.status === "failed") {
        setDeployProgress({
          status: "failed",
          message: "Deployment failed during build",
          log: result.deployment.build_log ?? "No build log returned.",
        });
      } else {
        setDeployProgress({ status: "success", message: "Service deployed successfully!" });
        toast.success(`"${form.name}" deployed from GitHub`);
        onDeployed();
      }
    } catch (err) {
      setDeployProgress({
        status: "failed",
        message: "Deployment failed",
        log: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeploying(false);
    }
  }

  const stepLabels = ["Source", "Configure", "Deploy"];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal github-deploy-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 620 }}
      >
        {/* Header */}
        <div className="gh-deploy-header">
          <div className="gh-deploy-title-row">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--text-primary)" }}>
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            <div>
              <h3 style={{ margin: 0 }}>Deploy from GitHub</h3>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted)" }}>
                Clone, build, and deploy a repository in one step
              </p>
            </div>
          </div>

          {/* Step indicator */}
          <div className="gh-steps">
            {stepLabels.map((label, i) => {
              const stepNum = (i + 1) as Step;
              const isActive = step === stepNum;
              const isComplete = step > stepNum;
              const isDone = deployProgress.status === "success";
              return (
                <div
                  key={label}
                  className={`gh-step ${isActive ? "active" : ""} ${isComplete || isDone ? "complete" : ""}`}
                >
                  <div className="gh-step-circle">
                    {isComplete || isDone ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      stepNum
                    )}
                  </div>
                  <span className="gh-step-label">{label}</span>
                  {i < stepLabels.length - 1 && <div className="gh-step-line" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 1: Source */}
        {step === 1 && (
          <div className="gh-step-content">
            <div className="gh-field-group">
              <label className="gh-label">Repository URL <span className="gh-required">*</span></label>
              <div className="gh-input-with-action">
                <input
                  placeholder="https://github.com/user/repo.git"
                  value={form.repoUrl}
                  onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
                  className="gh-input-flex"
                />
                <button
                  className="btn-ghost gh-browse-btn"
                  onClick={() => void loadGithubRepos()}
                  disabled={reposLoading}
                >
                  {reposLoading ? (
                    <span className="gh-spinner" />
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      Browse
                    </>
                  )}
                </button>
              </div>
              <p className="gh-hint">Paste a GitHub URL or browse your connected repositories</p>
            </div>

            {/* Repo browser */}
            {githubRepos.length > 0 && (
              <div className="gh-repo-browser">
                <input
                  placeholder="Search repositories…"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  className="gh-repo-search"
                />
                <div className="gh-repo-list">
                  {filteredRepos.slice(0, 20).map((repo) => (
                    <button
                      key={repo.full_name}
                      className={`gh-repo-item ${form.repoUrl === repo.clone_url ? "selected" : ""}`}
                      onClick={() => selectRepo(repo)}
                    >
                      <div className="gh-repo-info">
                        <span className="gh-repo-name">
                          {repo.private && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4, opacity: 0.6 }}>
                              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                          )}
                          {repo.full_name}
                        </span>
                        <span className="gh-repo-branch">{repo.default_branch}</span>
                      </div>
                      {form.repoUrl === repo.clone_url && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                  {filteredRepos.length === 0 && (
                    <p style={{ padding: "0.75rem", color: "var(--text-muted)", fontSize: "0.85rem", margin: 0 }}>
                      No repositories match your search
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="gh-field-group">
              <label className="gh-label">Branch</label>
              <input
                placeholder="main"
                value={form.branch}
                onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
              />
            </div>

            <div className="gh-actions">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button disabled={!canAdvanceToStep2()} onClick={() => setStep(2)}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="gh-step-content">
            <div className="gh-field-group">
              <label className="gh-label">Service name <span className="gh-required">*</span></label>
              <input
                placeholder="my-api"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
              />
              <p className="gh-hint">A unique name for this service in your dashboard</p>
            </div>

            <div className="gh-field-group">
              <label className="gh-label">Project</label>
              <select
                value={form.projectId}
                onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="gh-field-row">
              <div className="gh-field-group" style={{ flex: 1 }}>
                <label className="gh-label">
                  Port
                  <span className="gh-optional">optional</span>
                </label>
                <input
                  placeholder="3000"
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  type="number"
                />
              </div>
              <div className="gh-field-group" style={{ flex: 2 }}>
                <label className="gh-label">
                  Domain
                  <span className="gh-optional">optional</span>
                </label>
                <input
                  placeholder="api.example.com"
                  value={form.domain}
                  onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
                />
              </div>
            </div>

            <div className="gh-toggles">
              <label className="gh-toggle">
                <input
                  type="checkbox"
                  checked={form.startAfterDeploy}
                  onChange={(e) => setForm((f) => ({ ...f, startAfterDeploy: e.target.checked }))}
                />
                <div className="gh-toggle-info">
                  <span className="gh-toggle-title">Start after deploy</span>
                  <span className="gh-toggle-desc">Automatically start the service once the build completes</span>
                </div>
              </label>
              <label className="gh-toggle">
                <input
                  type="checkbox"
                  checked={form.autoPull}
                  onChange={(e) => setForm((f) => ({ ...f, autoPull: e.target.checked }))}
                />
                <div className="gh-toggle-info">
                  <span className="gh-toggle-title">Auto-pull (GitOps)</span>
                  <span className="gh-toggle-desc">Poll for new commits every 60s and redeploy automatically</span>
                </div>
              </label>
            </div>

            <div className="gh-actions">
              <button className="btn-ghost" onClick={() => setStep(1)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                Back
              </button>
              <button disabled={!canAdvanceToStep3()} onClick={() => setStep(3)}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Review & Deploy */}
        {step === 3 && (
          <div className="gh-step-content">
            {deployProgress.status === "idle" && (
              <>
                {/* Summary card */}
                <div className="gh-summary">
                  <h4 style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "var(--text-primary)" }}>Review deployment</h4>
                  <div className="gh-summary-grid">
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Repository</span>
                      <span className="gh-summary-value">{form.repoUrl.replace("https://github.com/", "").replace(".git", "")}</span>
                    </div>
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Branch</span>
                      <span className="gh-summary-value">{form.branch || "main"}</span>
                    </div>
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Service name</span>
                      <span className="gh-summary-value">{form.name}</span>
                    </div>
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Project</span>
                      <span className="gh-summary-value">{projects.find((p) => p.id === form.projectId)?.name ?? "—"}</span>
                    </div>
                    {form.port && (
                      <div className="gh-summary-item">
                        <span className="gh-summary-label">Port</span>
                        <span className="gh-summary-value">{form.port}</span>
                      </div>
                    )}
                    {form.domain && (
                      <div className="gh-summary-item">
                        <span className="gh-summary-label">Domain</span>
                        <span className="gh-summary-value">{form.domain}</span>
                      </div>
                    )}
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Auto-start</span>
                      <span className="gh-summary-value">{form.startAfterDeploy ? "Yes" : "No"}</span>
                    </div>
                    <div className="gh-summary-item">
                      <span className="gh-summary-label">Auto-pull</span>
                      <span className="gh-summary-value">{form.autoPull ? "Enabled" : "Disabled"}</span>
                    </div>
                  </div>
                </div>

                <div className="gh-actions">
                  <button className="btn-ghost" onClick={() => setStep(2)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back
                  </button>
                  <button className="gh-deploy-btn" onClick={() => void deploy()}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v20" /><path d="M5 9l7-7 7 7" />
                    </svg>
                    Deploy now
                  </button>
                </div>
              </>
            )}

            {deployProgress.status === "deploying" && (
              <div className="gh-deploy-progress">
                <div className="gh-deploy-spinner-wrap">
                  <div className="gh-deploy-spinner-large" />
                </div>
                <h4 style={{ margin: "0.75rem 0 0.25rem", color: "var(--text-primary)" }}>Deploying…</h4>
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: 0 }}>
                  {deployProgress.message}
                </p>
                <div className="gh-progress-steps">
                  <div className="gh-progress-step active">
                    <span className="gh-spinner" /> Cloning repository
                  </div>
                  <div className="gh-progress-step">Installing dependencies</div>
                  <div className="gh-progress-step">Building project</div>
                  <div className="gh-progress-step">Starting service</div>
                </div>
              </div>
            )}

            {deployProgress.status === "success" && (
              <div className="gh-deploy-result success">
                <div className="gh-result-icon success">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <h4 style={{ margin: "0.5rem 0 0.25rem", color: "var(--success)" }}>Deployment successful!</h4>
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "0 0 1rem" }}>
                  Your service "{form.name}" is now running.
                </p>

                <div className="gh-webhook-info">
                  <div className="gh-webhook-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    Want auto-deploys on push?
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.25rem 0 0.5rem" }}>
                    Add this webhook to your GitHub repository settings:
                  </p>
                  <code className="gh-webhook-url">
                    http(s)://&lt;your-server&gt;/webhooks/github
                  </code>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", margin: "0.35rem 0 0" }}>
                    Content type: <strong>application/json</strong> · Events: <strong>Push</strong>
                  </p>
                </div>

                <div className="gh-actions" style={{ marginTop: "1rem" }}>
                  <button onClick={onClose}>Done</button>
                </div>
              </div>
            )}

            {deployProgress.status === "failed" && (
              <div className="gh-deploy-result failed">
                <div className="gh-result-icon failed">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                </div>
                <h4 style={{ margin: "0.5rem 0 0.25rem", color: "var(--danger)" }}>Deployment failed</h4>
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "0 0 0.75rem" }}>
                  {deployProgress.message}
                </p>
                {deployProgress.log && (
                  <pre className="gh-error-log">{deployProgress.log}</pre>
                )}
                <div className="gh-actions" style={{ marginTop: "0.75rem" }}>
                  <button className="btn-ghost" onClick={() => { setDeployProgress({ status: "idle", message: "" }); setStep(2); }}>
                    Edit settings
                  </button>
                  <button onClick={() => { setDeployProgress({ status: "idle", message: "" }); void deploy(); }}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
