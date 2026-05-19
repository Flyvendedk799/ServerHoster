import { useEffect, useState } from "react";
import { API_BASE_URL, api } from "../lib/api";
import { toast } from "../lib/toast";

type Service = {
  id: string;
  name: string;
  type: string;
  status: string;
  project_id: string;
  domain?: string;
  port?: number;
  command?: string;
  working_dir?: string;
  environment?: string;
  depends_on?: string | null;
  linked_database_id?: string | null;
  stop_with_hoster?: number;
  github_repo_url?: string | null;
  github_branch?: string | null;
  github_auto_pull?: number | null;
  latest_commit_hash?: string | null;
};

type Database = { id: string; name: string; engine: string };
type AllService = { id: string; name: string; project_id: string };
type GithubStatus = {
  configured: boolean;
  webhookUrl: string | null;
  webhookSecretConfigured: boolean;
  webhookInsecure: boolean;
};
type GithubSyncStatus = {
  branch: string;
  autoPull: boolean;
  latestCommitHash: string | null;
  remoteHash: string | null;
  updateAvailable: boolean;
  requiresRestart?: boolean;
  canCheck: boolean;
  reason: string | null;
};

type Props = {
  service: Service;
  onClose: () => void;
  onUpdated: () => void;
};

function parseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function ServiceSettingsModal({ service, onClose, onUpdated }: Props) {
  const [form, setForm] = useState({
    name: service.name,
    domain: service.domain || "",
    port: String(service.port || ""),
    command: service.command || "",
    workingDir: service.working_dir || "",
    type: service.type,
    environment: (service.environment as "production" | "staging" | "development") ?? "production",
    dependsOn: parseDependsOn(service.depends_on ?? null),
    linkedDatabaseId: service.linked_database_id ?? "",
    stopWithHoster: service.stop_with_hoster !== 0,
    githubAutoPull: service.github_auto_pull !== 0
  });
  const [loading, setLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState<"redeploy" | "webhook" | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [databases, setDatabases] = useState<Database[]>([]);
  const [otherServices, setOtherServices] = useState<AllService[]>([]);
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [syncStatus, setSyncStatus] = useState<GithubSyncStatus | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(`${API_BASE_URL.replace(/\/$/, "")}/webhooks/github`);
  const webhookLooksLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(webhookUrl);

  useEffect(() => {
    void Promise.all([
      api<AllService[]>("/services", { silent: true }),
      api<Database[]>("/databases", { silent: true })
    ])
      .then(([svcs, dbs]) => {
        setOtherServices(svcs.filter((s) => s.id !== service.id && s.project_id === service.project_id));
        setDatabases(dbs);
      })
      .catch(() => undefined);
  }, [service.id, service.project_id]);

  useEffect(() => {
    if (!service.github_repo_url) return;
    void api<GithubStatus>("/settings/github/status", { silent: true })
      .then((status) => {
        setGithubStatus(status);
        if (status.webhookUrl) setWebhookUrl(status.webhookUrl);
      })
      .catch(() => undefined);
    void loadGithubSyncStatus(true);
  }, [service.github_repo_url]);

  async function save() {
    setLoading(true);
    try {
      await api(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          command: form.command,
          workingDir: form.workingDir,
          port: form.port ? Number(form.port) : undefined,
          domain: form.domain || undefined,
          environment: form.environment,
          dependsOn: form.dependsOn,
          linkedDatabaseId: form.linkedDatabaseId || null,
          stopWithHoster: form.stopWithHoster,
          githubAutoPull: form.githubAutoPull
        })
      });
      toast.success("Settings updated");
      onUpdated();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  async function redeployLatest(): Promise<void> {
    setGitBusy("redeploy");
    try {
      await api(`/services/${service.id}/redeploy`, { method: "POST" });
      toast.success("Redeployed latest GitHub commit");
      await loadGithubSyncStatus(true);
      onUpdated();
    } catch {
      /* toasted */
    } finally {
      setGitBusy(null);
    }
  }

  async function registerWebhook(): Promise<void> {
    if (!service.github_repo_url) return;
    setGitBusy("webhook");
    try {
      await api("/settings/github/webhook-url", {
        method: "PUT",
        body: JSON.stringify({ url: webhookUrl })
      });
      await api("/github/webhook/ensure", {
        method: "POST",
        body: JSON.stringify({ repoUrl: service.github_repo_url, webhookUrl })
      });
      toast.success("GitHub webhook registered");
      await loadGithubSyncStatus(true);
      onUpdated();
    } catch {
      /* toasted */
    } finally {
      setGitBusy(null);
    }
  }

  async function loadGithubSyncStatus(silent = false): Promise<void> {
    if (!service.github_repo_url) return;
    if (!silent) setSyncBusy(true);
    try {
      const status = await api<GithubSyncStatus>(`/services/${service.id}/github-sync-status`, { silent });
      setSyncStatus(status);
      if (!silent) {
        if (!status.canCheck) toast.error(status.reason ?? "Could not check GitHub remote");
        else if (status.updateAvailable) toast.success("Remote has a newer commit");
        else toast.success("Tracked branch is already current");
      }
    } catch {
      /* toasted */
    } finally {
      if (!silent) setSyncBusy(false);
    }
  }

  function toggleDep(id: string): void {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((x) => x !== id)
        : [...prev.dependsOn, id]
    }));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Service Settings</h3>
          <p className="hint">
            Configuring <span style={{ color: "var(--accent-light)" }}>{service.name}</span>
          </p>
        </header>

        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>Service Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Runtime Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="process">Binary Process</option>
                <option value="docker">Docker Image</option>
                <option value="static">Static Web</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Environment</label>
              <select
                value={form.environment}
                onChange={(e) => setForm({ ...form, environment: e.target.value as any })}
              >
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
              </select>
            </div>
            <div className="form-group">
              <label>Internal Port</label>
              <input
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="3000"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Custom Domain</label>
            <input
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              placeholder="app.myserver.com"
            />
          </div>

          <div className="form-group">
            <label>Start Command</label>
            <input
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder="npm run start"
            />
          </div>

          <div className="form-group">
            <label>Database Link</label>
            <select
              value={form.linkedDatabaseId}
              onChange={(e) => setForm({ ...form, linkedDatabaseId: e.target.value })}
            >
              <option value="">— No active link —</option>
              {databases.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.name} ({db.engine})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Dependencies (Start Priority)</label>
            <div className="row wrap" style={{ gap: "0.5rem", marginTop: "0.25rem" }}>
              {otherServices.length === 0 && (
                <span className="muted tiny">No other project services found.</span>
              )}
              {otherServices.map((s) => (
                <button
                  key={s.id}
                  className={`ghost xsmall ${form.dependsOn.includes(s.id) ? "active-chip" : ""}`}
                  onClick={() => toggleDep(s.id)}
                  style={{
                    borderRadius: "var(--radius-full)",
                    padding: "0.3rem 0.8rem",
                    border: "1px solid var(--border-default)"
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.stopWithHoster}
              onChange={(e) => setForm({ ...form, stopWithHoster: e.target.checked })}
            />
            <span>Stop this service when ServerHoster stops</span>
          </label>
          <p className="hint">
            Leave this on for local dev apps. Turn it off for durable background services that should survive
            the control panel.
          </p>

          {service.github_repo_url && (
            <div className="form-group github-sync-box">
              <label>GitHub Update</label>
              <div className="github-sync-meta">
                <code>{service.github_repo_url}</code>
                <span className="hint">
                  {syncStatus?.branch ?? service.github_branch ?? "main"}
                  {syncStatus?.latestCommitHash
                    ? ` · local ${syncStatus.latestCommitHash.slice(0, 7)}`
                    : service.latest_commit_hash
                      ? ` · local ${service.latest_commit_hash.slice(0, 7)}`
                      : " · no local baseline"}
                  {syncStatus?.remoteHash ? ` · remote ${syncStatus.remoteHash.slice(0, 7)}` : ""}
                </span>
                {syncStatus?.reason && <span className="hint">{syncStatus.reason}</span>}
                {syncStatus?.updateAvailable && (
                  <span className="hint text-warning">
                    Remote branch has changes that are not deployed.
                    {syncStatus.requiresRestart ? " The live service is still running the older commit." : ""}
                  </span>
                )}
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.githubAutoPull}
                  onChange={(e) => setForm({ ...form, githubAutoPull: e.target.checked })}
                />
                <span>Redeploy when the tracked branch changes</span>
              </label>

              <div className="form-row" style={{ marginTop: "0.75rem" }}>
                <div className="form-group">
                  <label>Webhook URL</label>
                  <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
                  {webhookLooksLocal && (
                    <span className="hint">
                      GitHub cannot reach localhost. Use a public HTTPS URL for live webhooks.
                    </span>
                  )}
                </div>
              </div>

              <div className="row wrap" style={{ gap: "0.5rem", marginTop: "0.75rem" }}>
                <button
                  className="ghost small"
                  onClick={() => void loadGithubSyncStatus(false)}
                  disabled={syncBusy}
                >
                  {syncBusy ? "Checking..." : "Check Remote"}
                </button>
                <button className="ghost small" onClick={redeployLatest} disabled={gitBusy !== null}>
                  {gitBusy === "redeploy" ? "Redeploying..." : "Redeploy Latest"}
                </button>
                <button
                  className="ghost small"
                  onClick={registerWebhook}
                  disabled={gitBusy !== null || !githubStatus?.configured}
                >
                  {gitBusy === "webhook" ? "Registering..." : "Register Webhook"}
                </button>
                {!githubStatus?.configured && (
                  <span className="hint">GitHub PAT required for webhook registration.</span>
                )}
                {githubStatus && !githubStatus.webhookInsecure && !githubStatus.webhookSecretConfigured && (
                  <span className="hint">SURVHUB_WEBHOOK_SECRET required for signed webhooks.</span>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Discard
          </button>
          <button className="primary" onClick={save} disabled={loading}>
            {loading ? "Saving..." : "Save Settings"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .active-chip { background: var(--accent-gradient) !important; color: white !important; border-color: transparent !important; }
          .github-sync-box { border-top: 1px solid var(--border-default); padding-top: 1rem; margin-top: 1rem; }
          .github-sync-meta { display: grid; gap: 0.25rem; margin: 0.5rem 0 0.75rem; }
          .github-sync-meta code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent-light); }
        `
          }}
        />
      </div>
    </div>
  );
}
