import { useEffect, useState } from "react";
import {
  Globe,
  ShieldCheck,
  GitBranch,
  Key,
  Database,
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
  Play,
  Loader2
} from "lucide-react";

import { API_BASE_URL, api, clearAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { StatusBadge } from "../components/StatusBadge";
import { motion, AnimatePresence } from "framer-motion";

type TunnelStatus = {
  cloudflaredInstalled: boolean;
  version: string | null;
  tokenConfigured: boolean;
  running: boolean;
  accountId: string | null;
  tunnelId: string | null;
  zoneId: string | null;
};

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<"connectivity" | "integrations" | "data" | "system">(
    "connectivity"
  );
  const [githubStatus, setGithubStatus] = useState<{
    configured: boolean;
    tokenPrefix: string | null;
    pollIntervalMs: number;
    webhookUrl: string | null;
    webhookSecretConfigured: boolean;
    webhookInsecure: boolean;
  } | null>(null);
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [githubWebhookUrl, setGithubWebhookUrl] = useState("");
  const [sshInfo, setSshInfo] = useState<{ publicKey: string | null; source: string } | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [cfConfig, setCfConfig] = useState({ accountId: "", tunnelId: "", zoneId: "" });
  const [sslMode, setSslMode] = useState<"http-01" | "dns-01">("http-01");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [gh, ssh, t, settings] = await Promise.all([
        api<any>("/settings/github/status", { silent: true }),
        api<any>("/settings/ssh", { silent: true }),
        api<TunnelStatus>("/cloudflare/status", { silent: true }),
        api<{ settings: Array<{ key: string; value: string; secret: boolean }> }>("/settings", {
          silent: true
        })
      ]);
      setGithubStatus(gh);
      setGithubWebhookUrl(gh?.webhookUrl ?? `${API_BASE_URL.replace(/\/$/, "")}/webhooks/github`);
      setSshInfo(ssh);
      setTunnel(t);
      if (t)
        setCfConfig({ accountId: t.accountId ?? "", tunnelId: t.tunnelId ?? "", zoneId: t.zoneId ?? "" });
      const storedSslMode = settings?.settings?.find((s) => s.key === "ssl_mode")?.value;
      if (storedSslMode === "http-01" || storedSslMode === "dns-01") setSslMode(storedSslMode);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    const ws = connectLogs((payload) => {
      if (typeof payload === "object" && payload && (payload as any).type === "tunnel_status") loadAll();
    });
    return () => ws.close();
  }, []);

  async function saveGithubPat() {
    setBusy("github-pat");
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
    } finally {
      setBusy(null);
    }
  }

  async function saveGithubWebhookUrl() {
    setBusy("github-webhook");
    try {
      await api("/settings/github/webhook-url", {
        method: "PUT",
        body: JSON.stringify({ url: githubWebhookUrl })
      });
      toast.success("GitHub webhook URL saved");
      await loadAll();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function startTunnel() {
    setBusy("tunnel-start");
    try {
      await api("/cloudflare/start", { method: "POST" });
      toast.success("Cloudflare Tunnel handshake initiated");
      await loadAll();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function stopTunnel() {
    setBusy("tunnel-stop");
    try {
      await api("/cloudflare/stop", { method: "POST" });
      toast.success("Cloudflare Tunnel terminated");
      await loadAll();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function saveSslMode() {
    setBusy("ssl-mode");
    try {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "ssl_mode", value: sslMode })
      });
      toast.success("Validation strategy saved");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function exportSnapshot() {
    setBusy("export");
    try {
      const d = await api("/backup/export");
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `localsurv-export-${new Date().toISOString().slice(0, 19)}.json`;
      a.click();
      toast.success("Snapshot prepared");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function runOpsTask(taskId: string, path: string, message: string) {
    setBusy(taskId);
    try {
      await api(path);
      toast.success(message);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const tabs = [
    { id: "connectivity", label: "Edge & SSL", icon: Globe, desc: "DNS & Tunneling" },
    { id: "integrations", label: "Dev Tools", icon: GitBranch, desc: "Git & SSH Identity" },
    { id: "data", label: "Persistence", icon: HardDrive, desc: "Backups & Exports" },
    { id: "system", label: "Ops Console", icon: Cpu, desc: "Node Administration" }
  ];

  return (
    <div className="settings-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Platform Settings</h2>
          <p className="muted">Global configuration for edge routing and infrastructure identity.</p>
        </div>
        <button
          className="ghost logout"
          onClick={() => {
            clearAuthToken();
            window.location.href = "/login";
          }}
        >
          <LogOut size={18} /> Sign Out
        </button>
      </header>

      <div className="settings-layout">
        <aside className="settings-nav" role="tablist" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              id={`settings-tab-${tab.id}`}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id as any)}
            >
              <div className="row" style={{ gap: "1rem" }}>
                <div className={`tab-icon-box ${activeTab === tab.id ? "active-icon" : ""}`}>
                  <tab.icon size={18} />
                </div>
                <div className="column" style={{ alignItems: "flex-start", gap: "2px" }}>
                  <span className="tab-label font-bold small">{tab.label}</span>
                  <span className="tiny muted">{tab.desc}</span>
                </div>
              </div>
              <ChevronRight
                size={14}
                className="muted ml-auto"
                style={{ opacity: activeTab === tab.id ? 1 : 0 }}
              />
            </button>
          ))}
        </aside>

        <section
          className="settings-content"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          {loading ? (
            <div className="form-stack">
              <div className="card settings-skeleton" aria-busy="true" aria-live="polite">
                <div className="skeleton-line" style={{ width: "40%" }} />
                <div className="skeleton-line" style={{ width: "75%" }} />
                <div className="skeleton-line" style={{ width: "60%" }} />
              </div>
              <span className="sr-only">Loading settings…</span>
            </div>
          ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === "connectivity" && (
                <div className="form-stack">
                  <div className="card">
                    <header className="section-title">
                      <div className="row">
                        <Cloud className="text-info" size={20} />
                        <h3>Cloudflare Zero Trust</h3>
                      </div>
                      <StatusBadge status={tunnel?.running ? "running" : "stopped"} />
                    </header>
                    <p className="muted small" style={{ marginBottom: "1rem" }}>
                      Connect your local node to the Cloudflare edge without opening ingress ports.
                    </p>

                    <div className="form-row">
                      <div className="form-group">
                        <label className="tiny uppercase font-bold muted">Account Pointer (ID)</label>
                        <input
                          value={cfConfig.accountId}
                          onChange={(e) => setCfConfig({ ...cfConfig, accountId: e.target.value })}
                          placeholder="32-character ID"
                        />
                      </div>
                      <div className="form-group">
                        <label className="tiny uppercase font-bold muted">Tunnel Identifier</label>
                        <input
                          value={cfConfig.tunnelId}
                          onChange={(e) => setCfConfig({ ...cfConfig, tunnelId: e.target.value })}
                          placeholder="UUID"
                        />
                      </div>
                    </div>

                    <footer className="footer-actions">
                      <button
                        className="primary"
                        onClick={startTunnel}
                        disabled={tunnel?.running || busy === "tunnel-start"}
                      >
                        {busy === "tunnel-start" ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <Play size={16} />
                        )}{" "}
                        Establish Connection
                      </button>
                      <button
                        className="ghost text-danger"
                        onClick={stopTunnel}
                        disabled={busy === "tunnel-stop"}
                      >
                        {busy === "tunnel-stop" && <Loader2 size={16} className="spin" />} Terminate
                        Connection
                      </button>
                    </footer>
                  </div>

                  <div className="card">
                    <div className="row">
                      <ShieldCheck className="text-success" size={20} />
                      <h3>Certificate Authority</h3>
                    </div>
                    <p className="muted small" style={{ margin: "1rem 0" }}>
                      Configure how LocalSURV issues SSL/TLS certificates via Let's Encrypt.
                    </p>
                    <div className="form-group">
                      <label className="tiny uppercase font-bold muted">Validation Strategy</label>
                      <select value={sslMode} onChange={(e) => setSslMode(e.target.value as any)}>
                        <option value="http-01">HTTP-01 Challenge (Standard)</option>
                        <option value="dns-01">DNS-01 Challenge (Wildcard Support)</option>
                      </select>
                    </div>
                    <button
                      className="button small"
                      style={{ marginTop: "1.5rem" }}
                      onClick={saveSslMode}
                      disabled={busy === "ssl-mode"}
                    >
                      {busy === "ssl-mode" && <Loader2 size={14} className="spin" />} Save Strategy
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "integrations" && (
                <div className="form-stack">
                  <div className="card">
                    <div className="row">
                      <GitBranch className="text-primary" size={20} />
                      <h3>GitHub CI Integration</h3>
                    </div>
                    <div className="form-group" style={{ marginTop: "1.5rem" }}>
                      <label className="tiny uppercase font-bold muted">Personal Access Token</label>
                      <input
                        type="password"
                        placeholder="ghp_****************"
                        value={githubTokenInput}
                        onChange={(e) => setGithubTokenInput(e.target.value)}
                      />
                      <div className="row small" style={{ marginTop: "1rem" }}>
                        {githubStatus?.configured ? (
                          <>
                            <CheckCircle2 size={14} className="text-success" />
                            <span className="muted">
                              Authenticated as{" "}
                              <code className="text-accent">{githubStatus.tokenPrefix}***</code>
                            </span>
                          </>
                        ) : (
                          <>
                            <AlertCircle size={14} className="text-warning" />
                            <span className="muted">
                              Connect to enable private repository synchronization.
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      className="primary"
                      style={{ marginTop: "1rem" }}
                      onClick={saveGithubPat}
                      disabled={busy === "github-pat"}
                    >
                      {busy === "github-pat" && <Loader2 size={16} className="spin" />} Update Token
                    </button>

                    <div className="form-group" style={{ marginTop: "1.75rem" }}>
                      <label className="tiny uppercase font-bold muted">Webhook Payload URL</label>
                      <input
                        value={githubWebhookUrl}
                        onChange={(e) => setGithubWebhookUrl(e.target.value)}
                        placeholder="https://host.example.com/webhooks/github"
                      />
                      <div className="row small" style={{ marginTop: "1rem", flexWrap: "wrap" }}>
                        <span className="muted">
                          Polling every{" "}
                          <code className="text-accent">
                            {Math.round((githubStatus?.pollIntervalMs ?? 60000) / 1000)}s
                          </code>
                        </span>
                        {githubStatus?.webhookSecretConfigured || githubStatus?.webhookInsecure ? (
                          <span className="row muted">
                            <CheckCircle2 size={14} className="text-success" /> Webhook receiver ready
                          </span>
                        ) : (
                          <span className="row muted">
                            <AlertCircle size={14} className="text-warning" /> Webhook secret missing
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="row" style={{ gap: "0.5rem", marginTop: "1rem" }}>
                      <button
                        className="ghost"
                        onClick={saveGithubWebhookUrl}
                        disabled={busy === "github-webhook"}
                      >
                        {busy === "github-webhook" && <Loader2 size={14} className="spin" />} Save
                        Webhook URL
                      </button>
                      <button
                        className="ghost small font-bold"
                        onClick={() =>
                          githubWebhookUrl &&
                          navigator.clipboard
                            .writeText(githubWebhookUrl)
                            .then(() => toast.success("Webhook URL copied to buffer"))
                        }
                      >
                        <Copy size={14} /> Copy URL
                      </button>
                    </div>
                  </div>

                  <div className="card">
                    <div className="row">
                      <Key className="text-warning" size={20} />
                      <h3>Infrastructure SSH Key</h3>
                    </div>
                    <p className="muted small" style={{ margin: "1rem 0" }}>
                      This public key is used for Git clones and secure cluster communication.
                    </p>
                    <div className="ssh-box">
                      <code>{sshInfo?.publicKey || "Generating keys..."}</code>
                    </div>
                    <button
                      className="ghost small font-bold"
                      onClick={() =>
                        sshInfo?.publicKey &&
                        navigator.clipboard
                          .writeText(sshInfo.publicKey)
                          .then(() => toast.success("Key copied to buffer"))
                      }
                    >
                      <Copy size={14} /> Copy Public Key
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "data" && (
                <div className="form-stack">
                  <div className="card">
                    <div className="row">
                      <Download className="text-accent" size={20} />
                      <h3>Instance Snapshot</h3>
                    </div>
                    <p className="muted small" style={{ margin: "1rem 0" }}>
                      Export all configuration, routing rules, and service metadata as a portable JSON file.
                    </p>
                    <button className="primary" onClick={exportSnapshot} disabled={busy === "export"}>
                      {busy === "export" && <Loader2 size={16} className="spin" />} Generate JSON
                      Export
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "system" && (
                <div className="form-stack">
                  <div className="card">
                    <div className="row">
                      <Monitor size={20} className="text-muted" />
                      <h3>Cluster Administration</h3>
                    </div>
                    <p className="muted small" style={{ marginTop: "1rem" }}>
                      Execute maintenance tasks directly on the node control plane.
                    </p>
                    <div className="row wrap" style={{ gap: "0.5rem", marginTop: "1rem" }}>
                      <button
                        className="button"
                        onClick={() =>
                          runOpsTask("ops-audit", "/ops/audit-logs", "Audit pushed to syslogs")
                        }
                        disabled={busy === "ops-audit"}
                      >
                        {busy === "ops-audit" ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <Terminal size={16} />
                        )}{" "}
                        Audit Log Stream
                      </button>
                      <button
                        className="button"
                        onClick={() =>
                          runOpsTask("ops-harden", "/ops/install-scripts", "Setup wizard cached")
                        }
                        disabled={busy === "ops-harden"}
                      >
                        {busy === "ops-harden" ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <Shield size={16} />
                        )}{" "}
                        Refresh Hardening
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          )}
        </section>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .settings-page .settings-layout { display: grid; grid-template-columns: 240px 1fr; gap: 1.5rem; align-items: flex-start; }
        .settings-page .settings-nav { display: flex; flex-direction: column; gap: 0.25rem; background: var(--bg-glass); padding: 0.35rem; border-radius: var(--radius-lg); border: 1px solid var(--border-subtle); }
        .settings-page .settings-nav button { 
          display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0.65rem;
          background: none; border: 1px solid transparent; color: var(--text-muted); 
          cursor: pointer; border-radius: var(--radius-md); transition: var(--transition-fast); 
        }
        .settings-page .settings-nav button:hover { background: var(--bg-sunken); color: var(--text-primary); }
        .settings-page .settings-nav button.active { background: var(--bg-card); border-color: var(--border-glow); color: var(--text-primary); box-shadow: var(--shadow-md); }
        .settings-page .tab-icon-box { width: 30px; height: 30px; background: var(--bg-sunken); display: flex; align-items: center; justify-content: center; border-radius: 7px; transition: var(--transition-fast); }
        .settings-page .active-icon { background: var(--accent-soft); color: var(--accent); }
        .settings-page .form-stack { display: flex; flex-direction: column; gap: 1rem; }
        .settings-page .footer-actions { display: flex; gap: 0.5rem; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
        .settings-page .ssh-box { 
          background: #050505; padding: 1rem; border-radius: var(--radius-md);
          margin: 1.5rem 0; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85rem; color: var(--success);
          border: 1px solid #333; box-shadow: inset 0 2px 10px rgba(0,0,0,0.5);
        }
        .ml-auto { margin-left: auto; }
        .font-bold { font-weight: 700; }
        .tiny { font-size: 0.7rem; }
        .settings-page .spin { animation: settings-spin 0.8s linear infinite; }
        @keyframes settings-spin { to { transform: rotate(360deg); } }
        .settings-page .settings-skeleton { display: flex; flex-direction: column; gap: 0.85rem; }
        .settings-page .skeleton-line { height: 0.9rem; border-radius: var(--radius-md); background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--bg-glass) 50%, var(--bg-sunken) 75%); background-size: 200% 100%; animation: settings-shimmer 1.4s ease-in-out infinite; }
        @keyframes settings-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        .settings-page .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
      `
        }}
      />
    </div>
  );
}
