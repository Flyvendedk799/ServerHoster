import { useEffect, useState } from "react";
import { api, clearAuthToken, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { StatusBadge } from "../components/StatusBadge";

type TunnelStatus = {
  cloudflaredInstalled: boolean;
  binaryPath: string | null;
  version: string | null;
  tokenConfigured: boolean;
  apiTokenConfigured: boolean;
  accountId: string | null;
  tunnelId: string | null;
  zoneId: string | null;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  recentOutput: string[];
};

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<"general" | "integrations" | "connectivity" | "data" | "system">("general");
  const [templates, setTemplates] = useState<{ linux: string; macos: string; windows: string } | null>(null);
  const [backup, setBackup] = useState<string>("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [bootstrapUsername, setBootstrapUsername] = useState("");
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [authInfo, setAuthInfo] = useState("");
  const [httpsInfo, setHttpsInfo] = useState<string>("");
  const [installScripts, setInstallScripts] = useState<string>("");
  const [backupImport, setBackupImport] = useState("");
  const [backupImportStatus, setBackupImportStatus] = useState("");
  const [auditLogs, setAuditLogs] = useState("");
  const [railwayPayload, setRailwayPayload] = useState("");
  const [pythonAnywherePayload, setPythonAnywherePayload] = useState("");
  const [migrationStatus, setMigrationStatus] = useState("");
  const [githubStatus, setGithubStatus] = useState<{ configured: boolean; tokenPrefix: string | null } | null>(null);
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [sshInfo, setSshInfo] = useState<{ configuredPath: string | null; resolvedPath: string | null; publicKey: string | null; source: string } | null>(null);
  const [sshPathInput, setSshPathInput] = useState("");
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [cfConfig, setCfConfig] = useState({ accountId: "", tunnelId: "", zoneId: "" });
  const [cfApiToken, setCfApiToken] = useState("");
  const [cfTunnelToken, setCfTunnelToken] = useState("");
  const [sslMode, setSslMode] = useState<"http-01" | "dns-01">("http-01");

  useEffect(() => {
    void api<{ linux: string; macos: string; windows: string }>("/service-templates").then(setTemplates);
    void loadGithubStatus();
    void loadSshInfo();
    void loadTunnel();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "tunnel_log" || typed.type === "tunnel_status") void loadTunnel();
    });
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTunnel(): Promise<void> {
    try {
      const s = await api<TunnelStatus>("/cloudflare/status", { silent: true });
      setTunnel(s);
      setCfConfig({
        accountId: s.accountId ?? "",
        tunnelId: s.tunnelId ?? "",
        zoneId: s.zoneId ?? ""
      });
    } catch {
      /* not authed yet */
    }
  }

  async function saveCloudflareConfig(): Promise<void> {
    try {
      await api("/cloudflare/config", { method: "PUT", body: JSON.stringify(cfConfig) });
      toast.success("Cloudflare config saved");
      await loadTunnel();
    } catch {
      /* toasted */
    }
  }

  async function saveCloudflareApiToken(): Promise<void> {
    if (!cfApiToken) return;
    try {
      await api("/cloudflare/api-token", { method: "PUT", body: JSON.stringify({ token: cfApiToken }) });
      toast.success("Cloudflare API token saved");
      setCfApiToken("");
      await loadTunnel();
    } catch {
      /* toasted */
    }
  }

  async function saveCloudflareTunnelToken(): Promise<void> {
    if (!cfTunnelToken) return;
    try {
      await api("/cloudflare/tunnel-token", { method: "PUT", body: JSON.stringify({ token: cfTunnelToken }) });
      toast.success("Cloudflare tunnel token saved");
      setCfTunnelToken("");
      await loadTunnel();
    } catch {
      /* toasted */
    }
  }

  async function startCloudflareTunnel(): Promise<void> {
    try {
      await api("/cloudflare/start", { method: "POST" });
      toast.success("Tunnel starting…");
      await loadTunnel();
    } catch {
      /* toasted */
    }
  }

  async function stopCloudflareTunnel(): Promise<void> {
    try {
      await api("/cloudflare/stop", { method: "POST" });
      toast.success("Tunnel stopped");
      await loadTunnel();
    } catch {
      /* toasted */
    }
  }

  async function saveSslMode(): Promise<void> {
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ key: "ssl_mode", value: sslMode }) });
      toast.success(`SSL mode set to ${sslMode}`);
    } catch {
      /* toasted */
    }
  }

  async function loadGithubStatus(): Promise<void> {
    try {
      const s = await api<{ configured: boolean; tokenPrefix: string | null }>("/settings/github/status", { silent: true });
      setGithubStatus(s);
    } catch {
      /* not authed yet */
    }
  }

  async function saveGithubPat(): Promise<void> {
    if (!githubTokenInput) return;
    try {
      const res = await api<{ ok: boolean; login: string | null }>("/settings/github/pat", {
        method: "POST",
        body: JSON.stringify({ token: githubTokenInput })
      });
      toast.success(`GitHub PAT saved${res.login ? ` for @${res.login}` : ""}`);
      setGithubTokenInput("");
      await loadGithubStatus();
    } catch {
      /* toasted */
    }
  }

  async function clearGithubPat(): Promise<void> {
    try {
      await api("/settings/github/pat", { method: "DELETE" });
      toast.success("GitHub PAT removed");
      await loadGithubStatus();
    } catch {
      /* toasted */
    }
  }

  async function loadSshInfo(): Promise<void> {
    try {
      const info = await api<{ configuredPath: string | null; resolvedPath: string | null; publicKey: string | null; source: string }>(
        "/settings/ssh",
        { silent: true }
      );
      setSshInfo(info);
      if (info.configuredPath) setSshPathInput(info.configuredPath);
    } catch {
      /* not authed yet */
    }
  }

  async function saveSshKeyPath(): Promise<void> {
    if (!sshPathInput) return;
    try {
      await api("/settings/ssh", { method: "PUT", body: JSON.stringify({ path: sshPathInput }) });
      toast.success("SSH key path saved");
      await loadSshInfo();
    } catch {
      /* toasted */
    }
  }

  async function copyPublicKey(): Promise<void> {
    if (!sshInfo?.publicKey) return;
    try {
      await navigator.clipboard.writeText(sshInfo.publicKey);
      toast.success("Public key copied to clipboard");
    } catch {
      toast.error("Clipboard write failed");
    }
  }

  async function exportBackup(): Promise<void> {
    const data = await api<{ exportedAt: string; data: unknown }>("/backup/export");
    setBackup(JSON.stringify(data, null, 2));
  }

  async function login(): Promise<void> {
    try {
      const response = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username || undefined, password })
      });
      setAuthToken(response.token);
      setAuthInfo("Login successful");
    } catch {
      setAuthInfo("Login failed");
    }
  }

  async function bootstrapAdmin(): Promise<void> {
    try {
      await api("/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ username: bootstrapUsername, password: bootstrapPassword })
      });
      setAuthInfo("Bootstrap successful — you can log in with that username and password.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Bootstrap already completed")) {
        setAuthInfo("Bootstrap already done — use Login with your username and password.");
      } else if (msg.includes("401") || msg.includes("Unauthorized")) {
        setAuthInfo("Bootstrap rejected (session issue). Click Logout and try again, or use a password with 8+ characters.");
      } else {
        setAuthInfo(`Bootstrap failed: ${msg.slice(0, 500)}`);
      }
    }
  }

  async function loadAuditLogs(): Promise<void> {
    const logs = await api<unknown[]>("/ops/audit-logs?limit=100");
    setAuditLogs(JSON.stringify(logs, null, 2));
  }

  async function generateHttpsCerts(): Promise<void> {
    const data = await api<{
      certPath: string;
      keyPath: string;
      trustGuide: Record<string, string[]>;
    }>("/ops/https/generate", { method: "POST", body: JSON.stringify({}) });
    setHttpsInfo(JSON.stringify(data, null, 2));
  }

  async function checkHttpsStatus(): Promise<void> {
    const data = await api<{
      certExists: boolean;
      keyExists: boolean;
      certPath: string;
      keyPath: string;
      trustGuide: Record<string, string[]>;
    }>("/ops/https/status");
    setHttpsInfo(JSON.stringify(data, null, 2));
  }

  async function exportInstallScripts(): Promise<void> {
    const data = await api<{
      linux: { path: string; script: string };
      macos: { path: string; script: string };
      windows: { path: string; script: string };
    }>("/ops/install-scripts");
    setInstallScripts(JSON.stringify(data, null, 2));
  }

  async function importBackup(): Promise<void> {
    try {
      const parsed = JSON.parse(backupImport) as { data: unknown };
      await api("/backup/import", {
        method: "POST",
        body: JSON.stringify(parsed)
      });
      setBackupImportStatus("Import successful");
    } catch {
      setBackupImportStatus("Import failed");
    }
  }

  async function runRailwayImport(dryRun: boolean): Promise<void> {
    try {
      const payload = JSON.parse(railwayPayload) as { projects: unknown[] };
      const result = await api("/migrations/railway/import", {
        method: "POST",
        body: JSON.stringify({ ...payload, dryRun })
      });
      setMigrationStatus(JSON.stringify(result, null, 2));
    } catch {
      setMigrationStatus("Railway import failed");
    }
  }

  async function runPythonAnywhereImport(dryRun: boolean): Promise<void> {
    try {
      const payload = JSON.parse(pythonAnywherePayload) as { apps: unknown[] };
      const result = await api("/migrations/pythonanywhere/import", {
        method: "POST",
        body: JSON.stringify({ ...payload, dryRun })
      });
      setMigrationStatus(JSON.stringify(result, null, 2));
    } catch {
      setMigrationStatus("PythonAnywhere import failed");
    }
  }

  return (
    <section>
      <div className="row" style={{ marginBottom: "var(--space-6)", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>System Settings</h2>
        <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>v1.4.2 Production Build</div>
      </div>

      <div className="row" style={{ 
        background: "var(--bg-sunken)", 
        padding: "0.25rem", 
        borderRadius: "var(--radius-md)", 
        marginBottom: "var(--space-8)",
        gap: "0.25rem",
        border: "1px solid var(--border-subtle)",
        width: "fit-content"
      }}>
        {[
          { id: "general", label: "General", icon: "⚙️" },
          { id: "integrations", label: "Integrations", icon: "🔗" },
          { id: "connectivity", label: "Connectivity", icon: "🌐" },
          { id: "data", label: "Data & Sync", icon: "💾" },
          { id: "system", label: "System/Ops", icon: "🛠️" },
        ].map(tab => (
          <button 
            key={tab.id}
            className={activeTab === tab.id ? "primary" : "ghost"}
            style={{ 
              padding: "0.5rem 1rem", 
              fontSize: "0.82rem",
              borderRadius: "var(--radius-sm)",
              border: "none",
              boxShadow: activeTab === tab.id ? "var(--shadow-sm)" : "none"
            }}
            onClick={() => setActiveTab(tab.id as any)}
          >
            <span style={{ marginRight: "0.4rem" }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-content" style={{ animation: "slideUp 0.3s ease-out" }}>
        {activeTab === "general" && (
          <div className="grid">
            <div className="card elevated">
              <h3>Dashboard Auth</h3>
              <p className="gh-hint" style={{ marginBottom: "var(--space-4)" }}>Login or finalize administrative bootstrap.</p>
              <div className="gh-field-group">
                <label className="gh-label">User</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
              </div>
              <div className="gh-field-group">
                <label className="gh-label">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Dashboard password" />
              </div>
              <button className="primary" style={{ width: "100%" }} onClick={() => void login()}>Sign In</button>
              
              <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-6)", borderTop: "1px solid var(--border-subtle)" }}>
                <h4>Bootstrap Admin</h4>
                <div className="gh-field-group">
                  <input value={bootstrapUsername} onChange={(e) => setBootstrapUsername(e.target.value)} placeholder="New Root User" />
                </div>
                <div className="gh-field-group">
                  <input type="password" value={bootstrapPassword} onChange={(e) => setBootstrapPassword(e.target.value)} placeholder="New Root Pass (min 8)" />
                </div>
                <button style={{ width: "100%" }} onClick={() => void bootstrapAdmin()}>Finalize Bootstrap</button>
              </div>

              <div style={{ marginTop: "var(--space-4)" }}>
                <button className="ghost btn-danger" style={{ width: "100%" }} onClick={() => {
                  void api("/auth/logout", { method: "POST" }).catch(() => undefined);
                  clearAuthToken();
                  setAuthInfo("Logged out");
                }}>Logout Session</button>
                {authInfo && <p style={{ fontSize: "0.8rem", textAlign: "center", color: "var(--accent)" }}>{authInfo}</p>}
              </div>
            </div>

            <div className="card">
              <h3>Server Identity</h3>
              <p className="gh-hint">Details about this LocalSURV node.</p>
              <div className="metric-group" style={{ marginTop: "var(--space-4)" }}>
                <div className="metric-card">
                  <div className="metric-label">Node Hostname</div>
                  <div className="metric-value" style={{ fontSize: "1rem" }}>{window.location.hostname}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">OS Environment</div>
                  <div className="metric-value" style={{ fontSize: "1rem" }}>{navigator.platform}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "integrations" && (
          <div className="grid">
            <div className="card elevated">
              <div className="row" style={{ gap: "0.75rem", marginBottom: "var(--space-4)" }}>
                <div style={{ background: "var(--bg-sunken)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                </div>
                <h3 style={{ margin: 0 }}>GitHub Connectivity</h3>
              </div>
              <p className="gh-hint">Used for private repos, polling, and auto-webhooks.</p>
              
              <div style={{ margin: "var(--space-4) 0" }}>
                {githubStatus?.configured ? (
                  <div className="row" style={{ background: "var(--success-soft)", padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--success-soft)" }}>
                    <div style={{ color: "var(--success)", fontWeight: 600 }}>Active Token: {githubStatus.tokenPrefix}</div>
                    <button className="ghost btn-danger" style={{ marginLeft: "auto", padding: "0.2rem 0.5rem" }} onClick={() => void clearGithubPat()}>Clear</button>
                  </div>
                ) : (
                  <div style={{ color: "var(--text-dim)", fontStyle: "italic", fontSize: "0.85rem" }}>No Personal Access Token configured.</div>
                )}
              </div>

              <div className="gh-field-group">
                <label className="gh-label">New Personal Access Token</label>
                <input type="password" placeholder="ghp_..." value={githubTokenInput} onChange={(e) => setGithubTokenInput(e.target.value)} />
                <p className="gh-hint">Required scopes: `contents:read`, `administration:write` (for hooks).</p>
              </div>
              <button onClick={() => void saveGithubPat()} disabled={!githubTokenInput}>Connect Account</button>
            </div>

            <div className="card">
              <h3>SSH Deployment Keys</h3>
              <p className="gh-hint">For cloning via SSH without personal tokens.</p>
              <div className="gh-field-group" style={{ marginTop: "var(--space-4)" }}>
                <label className="gh-label">SSH Key Path</label>
                <input placeholder="/Users/me/.ssh/id_ed25519" value={sshPathInput} onChange={(e) => setSshPathInput(e.target.value)} />
              </div>
              <button className="ghost" onClick={() => void saveSshKeyPath()}>Save Path</button>

              {sshInfo?.publicKey && (
                <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-subtle)" }}>
                  <div className="gh-label">Public Key ({sshInfo.source})</div>
                  <pre style={{ fontSize: "0.65rem", padding: "0.75rem", borderRadius: "var(--radius-sm)", background: "var(--bg-sunken)", overflowX: "auto", marginBottom: "var(--space-3)" }}>
                    {sshInfo.publicKey}
                  </pre>
                  <button className="ghost" onClick={() => void copyPublicKey()}>Copy to Clipboard</button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "connectivity" && (
          <div className="grid">
            <div className="card elevated">
              <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
                <h3 style={{ margin: 0 }}>Cloudflare Tunnel</h3>
                {tunnel && <StatusBadge status={tunnel.running ? "running" : "stopped"} />}
              </div>
              
              <div className="metric-group" style={{ gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
                <div className="metric-card" style={{ background: "var(--bg-sunken)" }}>
                  <div className="metric-label">Binary</div>
                  <div className="metric-value" style={{ fontSize: "0.75rem" }}>{tunnel?.cloudflaredInstalled ? (tunnel.version || "Installed") : "Not Found"}</div>
                </div>
                <div className="metric-card" style={{ background: "var(--bg-sunken)" }}>
                  <div className="metric-label">Token</div>
                  <div className="metric-value" style={{ fontSize: "0.75rem" }}>{tunnel?.tokenConfigured ? "Configured ✓" : "Missing"}</div>
                </div>
              </div>

              <div className="row" style={{ gap: "0.5rem", marginBottom: "var(--space-6)" }}>
                <button className="primary" onClick={() => void startCloudflareTunnel()} disabled={tunnel?.running || !tunnel?.tokenConfigured}>Start Tunnel</button>
                <button className="ghost btn-danger" onClick={() => void stopCloudflareTunnel()} disabled={!tunnel?.running}>Stop</button>
                <button className="ghost" onClick={() => void loadTunnel()}>↻ Refresh</button>
              </div>

              <div className="gh-field-group">
                <input placeholder="Account ID" value={cfConfig.accountId} onChange={(e) => setCfConfig({...cfConfig, accountId: e.target.value})} />
                <input placeholder="Tunnel ID" value={cfConfig.tunnelId} onChange={(e) => setCfConfig({...cfConfig, tunnelId: e.target.value})} style={{ marginTop: "0.5rem" }} />
                <input placeholder="Zone ID" value={cfConfig.zoneId} onChange={(e) => setCfConfig({...cfConfig, zoneId: e.target.value})} style={{ marginTop: "0.5rem" }} />
                <button className="ghost" style={{ marginTop: "var(--space-2)", width: "100%" }} onClick={() => void saveCloudflareConfig()}>Save Identifiers</button>
              </div>

              <div className="gh-field-group" style={{ marginTop: "var(--space-4)" }}>
                <label className="gh-label">Update Tokens</label>
                <input type="password" placeholder="API Token" value={cfApiToken} onChange={(e) => setCfApiToken(e.target.value)} />
                <button className="ghost" style={{ marginTop: "0.5rem", width: "100%" }} onClick={() => void saveCloudflareApiToken()}>Save API Token</button>
                <input type="password" placeholder="Tunnel Token" value={cfTunnelToken} onChange={(e) => setCfTunnelToken(e.target.value)} style={{ marginTop: "0.5rem" }} />
                <button className="ghost" style={{ marginTop: "0.5rem", width: "100%" }} onClick={() => void saveCloudflareTunnelToken()}>Save Tunnel Token</button>
              </div>
            </div>

            <div className="card">
              <h3>SSL & Certificates</h3>
              <p className="gh-hint">Managed via Let's Encrypt / ACME.</p>
              <div className="gh-field-group" style={{ marginTop: "var(--space-4)" }}>
                <label className="gh-label">Validation Mode</label>
                <select value={sslMode} onChange={(event) => setSslMode(event.target.value as any)}>
                  <option value="http-01">HTTP-01 (Standard, requires Port 80)</option>
                  <option value="dns-01">DNS-01 (Wildcard, requires CF API Token)</option>
                </select>
              </div>
              <button className="ghost" onClick={() => void saveSslMode()}>Apply SSL Policy</button>

              <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-subtle)" }}>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void checkHttpsStatus()}>Status</button>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void generateHttpsCerts()}>Gen Local</button>
                </div>
                {httpsInfo && <pre style={{ marginTop: "var(--space-2)", maxHeight: "150px" }}>{httpsInfo}</pre>}
              </div>
            </div>
          </div>
        )}

        {activeTab === "data" && (
          <div className="grid">
            <div className="card elevated">
              <h3>Backup & Restore</h3>
              <p className="gh-hint">Snapshot of the entire SURVHub database.</p>
              <button className="primary" style={{ width: "100%", margin: "var(--space-4) 0" }} onClick={() => void exportBackup()}>Generate Full Export</button>
              {backup && (
                <pre style={{ maxHeight: "200px", background: "var(--bg-sunken)", padding: "0.75rem", borderRadius: "var(--radius-sm)" }}>
                  {backup.slice(0, 1000)}...
                </pre>
              )}
              
              <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-subtle)" }}>
                <label className="gh-label">Import from JSON</label>
                <textarea rows={6} placeholder='{"data": ...}' value={backupImport} onChange={(e) => setBackupImport(e.target.value)} />
                <button className="ghost" style={{ width: "100%", marginTop: "0.5rem" }} onClick={() => void importBackup()}>Perform Restore</button>
                {backupImportStatus && <p className="gh-hint" style={{ color: "var(--accent)" }}>{backupImportStatus}</p>}
              </div>
            </div>

            <div className="card">
              <h3>Platform Migrations</h3>
              <p className="gh-hint">Import services from other platforms.</p>
              <div className="gh-field-group" style={{ marginTop: "var(--space-4)" }}>
                <label className="gh-label">Railway Export Payload</label>
                <textarea rows={4} value={railwayPayload} onChange={(e) => setRailwayPayload(e.target.value)} />
                <div className="row" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void runRailwayImport(true)}>Dry Run</button>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void runRailwayImport(false)}>Import</button>
                </div>
              </div>
              <div className="gh-field-group" style={{ marginTop: "var(--space-4)" }}>
                <label className="gh-label">PythonAnywhere Export</label>
                <textarea rows={4} value={pythonAnywherePayload} onChange={(e) => setPythonAnywherePayload(e.target.value)} />
                <div className="row" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void runPythonAnywhereImport(true)}>Dry Run</button>
                  <button className="ghost" style={{ flex: 1 }} onClick={() => void runPythonAnywhereImport(false)}>Import</button>
                </div>
              </div>
              {migrationStatus && <pre style={{ maxHeight: "200px" }}>{migrationStatus}</pre>}
            </div>
          </div>
        )}

        {activeTab === "system" && (
          <div className="grid">
            <div className="card elevated">
              <h3>Service Templates</h3>
              <p className="gh-hint">OS-specific configuration templates.</p>
              <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-4)" }}>
                <div>
                  <div className="gh-label">Linux systemd</div>
                  <pre style={{ maxHeight: "120px" }}>{templates?.linux}</pre>
                </div>
                <div>
                  <div className="gh-label">macOS launchd</div>
                  <pre style={{ maxHeight: "120px" }}>{templates?.macos}</pre>
                </div>
                <div>
                  <div className="gh-label">Windows Service</div>
                  <pre style={{ maxHeight: "120px" }}>{templates?.windows}</pre>
                </div>
              </div>
            </div>

            <div className="card">
              <h3>Maintenance & Logs</h3>
              <div style={{ display: "grid", gap: "var(--space-3)" }}>
                <button className="ghost" style={{ justifyContent: "flex-start" }} onClick={() => void loadAuditLogs()}>🔍 View Latest Audit Logs</button>
                <button className="ghost" style={{ justifyContent: "flex-start" }} onClick={() => void exportInstallScripts()}>📥 Download OS Install Scripts</button>
              </div>
              {auditLogs && <pre style={{ marginTop: "var(--space-4)", maxHeight: "300px" }}>{auditLogs}</pre>}
              {installScripts && <pre style={{ marginTop: "var(--space-4)", maxHeight: "300px" }}>{installScripts}</pre>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
