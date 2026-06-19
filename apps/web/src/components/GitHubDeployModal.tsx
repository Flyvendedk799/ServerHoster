import { useEffect, useRef, useState } from "react";
import { Database, Search, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";

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

type DatabaseSetupMode = "auto" | "review" | "skip";
type DatabaseSetupResult = {
  status: "skipped" | "review" | "ready" | "blocked" | "failed" | "no-database-detected";
  message: string;
};

export function GitHubDeployModal({ projects, onClose, onDeployed }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [deploying, setDeploying] = useState(false);

  const [form, setForm] = useState({
    projectId: "",
    name: "",
    repoUrl: "",
    branch: "main",
    port: "",
    autoPull: true,
    databaseMode: "auto" as DatabaseSetupMode
  });
  const ref = useRef<HTMLDivElement>(null);

  useModalA11y(ref, { onClose, onSubmit: step === 1 ? undefined : handleDeploy });

  async function loadRepos() {
    setLoading(true);
    try {
      const data = await api<GitHubRepo[]>("/github/repos");
      setRepos(data);
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  // Auto-load the repo list on open so the user doesn't have to click Refresh.
  useEffect(() => {
    void loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRepo(repo: GitHubRepo) {
    setForm((f) => ({
      ...f,
      repoUrl: repo.clone_url,
      branch: repo.default_branch || "main",
      name: repo.full_name.split("/")[1] || f.name
    }));
    setStep(2);
  }

  async function handleDeploy() {
    if (!form.name || !form.repoUrl) return;
    setDeploying(true);
    try {
      const result = await api<{ databaseSetup?: DatabaseSetupResult }>("/services/deploy-from-github", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          port: form.port ? Number(form.port) : undefined,
          databaseSetup: { mode: form.databaseMode }
        })
      });
      if (result.databaseSetup?.status === "failed" || result.databaseSetup?.status === "blocked") {
        toast.error(`Deployment queued, database setup needs attention: ${result.databaseSetup.message}`);
      } else if (result.databaseSetup?.status === "ready") {
        toast.success("Deployment queued with database setup ready");
      } else {
        toast.success("Deployment pipeline initiated");
      }
      onDeployed();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setDeploying(false);
    }
  }

  const filtered = repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-deploy-title"
        style={{ maxWidth: "640px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div className="row">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            <h3 id="github-deploy-title">GitHub GitOps</h3>
          </div>
          <p className="hint">Deploy automatically from any GitHub repository.</p>
        </header>

        <div className="modal-body">
          {step === 1 ? (
            <div className="form-group">
              <div className="row">
                <input
                  placeholder="Search your repos..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="ghost" onClick={loadRepos} disabled={loading}>
                  Refresh List
                </button>
              </div>

              <div
                className="repo-list"
                style={{
                  marginTop: "1rem",
                  maxHeight: "300px",
                  overflowY: "auto",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)"
                }}
              >
                {loading &&
                  [0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      style={{
                        padding: "1rem",
                        borderBottom: "1px solid var(--border-subtle)"
                      }}
                    >
                      <div className="skeleton" style={{ height: "14px", width: "60%" }} />
                    </div>
                  ))}
                {!loading && repos.length === 0 && (
                  <div className="muted small text-center" style={{ padding: "2rem" }}>
                    No repositories found on your account.
                  </div>
                )}
                {!loading && repos.length > 0 && filtered.length === 0 && (
                  <div className="muted small text-center" style={{ padding: "2rem" }}>
                    No repositories match “{search}”.
                  </div>
                )}
                {!loading &&
                  filtered.map((repo) => (
                  <div
                    key={repo.full_name}
                    className="repo-item"
                    onClick={() => selectRepo(repo)}
                    style={{
                      padding: "1rem",
                      borderBottom: "1px solid var(--border-subtle)",
                      cursor: "pointer",
                      transition: "var(--transition)"
                    }}
                  >
                    <div className="row between">
                      <span className="font-semibold">{repo.full_name}</span>
                      <span className="tiny muted">{repo.default_branch}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="form-group" style={{ marginTop: "1.5rem" }}>
                <label>Or use external URL</label>
                <input
                  placeholder="https://github.com/..."
                  value={form.repoUrl}
                  onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                />
              </div>
            </div>
          ) : (
            <div className="form-column" style={{ display: "grid", gap: "1.5rem" }}>
              <div className="row tiny muted" style={{ gap: "6px" }}>
                <button className="ghost tiny" onClick={() => setStep(1)} style={{ padding: 0 }}>
                  Repositories
                </button>
                <span>›</span>
                <span className="font-semibold" style={{ color: "var(--accent-light)" }}>
                  {form.repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "") ||
                    "External repo"}
                </span>
              </div>

              <div className="form-group">
                <label>Service Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Target Project</label>
                  <select
                    value={form.projectId}
                    onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                  >
                    <option value="">Auto: create or reuse app project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Branch</label>
                  <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                </div>
              </div>

              <div className="form-group">
                <label>Internal Port</label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="3000"
                />
              </div>

              <div className="form-group">
                <label>Database setup</label>
                <div className="database-mode-grid">
                  <button
                    type="button"
                    className={`database-mode-option ${form.databaseMode === "auto" ? "active" : ""}`}
                    onClick={() => setForm({ ...form, databaseMode: "auto" })}
                  >
                    <Sparkles size={15} />
                    <span>
                      <strong>Auto</strong>
                      <small>Detect, create, or connect local DB</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`database-mode-option ${form.databaseMode === "review" ? "active" : ""}`}
                    onClick={() => setForm({ ...form, databaseMode: "review" })}
                  >
                    <Search size={15} />
                    <span>
                      <strong>Review</strong>
                      <small>Scan and decide after deploy</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`database-mode-option ${form.databaseMode === "skip" ? "active" : ""}`}
                    onClick={() => setForm({ ...form, databaseMode: "skip" })}
                  >
                    <Database size={15} />
                    <span>
                      <strong>Skip</strong>
                      <small>No database changes</small>
                    </span>
                  </button>
                </div>
              </div>

              <label className="toggle-group">
                <input
                  type="checkbox"
                  checked={form.autoPull}
                  onChange={(e) => setForm({ ...form, autoPull: e.target.checked })}
                />
                <div className="toggle-info">
                  <span className="toggle-title">GitHub Auto Update</span>
                  <span className="toggle-desc">
                    Poll for new commits on {form.branch}; add a webhook from service settings for instant
                    pushes.
                  </span>
                </div>
              </label>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {step === 2 && (
            <button className="ghost" onClick={() => setStep(1)}>
              Back
            </button>
          )}
          {step === 1 && (
            <button className="primary" onClick={() => setStep(2)} disabled={!form.repoUrl}>
              Next Step
            </button>
          )}
          {step === 2 && (
            <button className="primary" onClick={handleDeploy} disabled={deploying}>
              {deploying ? "Queuing..." : "Start Deployment"}
            </button>
          )}
        </footer>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .repo-item:hover { background: var(--bg-sunken); color: var(--accent-light); }
        .font-semibold { font-weight: 600; }
        .database-mode-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem; }
        .database-mode-option { justify-content: flex-start; align-items: flex-start; gap: 0.5rem; padding: 0.65rem; text-align: left; background: var(--bg-sunken); }
        .database-mode-option.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text-primary); }
        .database-mode-option span { display: grid; gap: 0.15rem; min-width: 0; }
        .database-mode-option small { color: var(--text-muted); font-size: 0.68rem; line-height: 1.2; }
        @media (max-width: 640px) { .database-mode-grid { grid-template-columns: 1fr; } }
      `
        }}
      />
    </div>
  );
}
