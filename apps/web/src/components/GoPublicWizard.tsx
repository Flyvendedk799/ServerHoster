import { useEffect, useRef, useState } from "react";
import { useExposure } from "../lib/exposure";
import { api, ApiError } from "../lib/api";
import { toast } from "../lib/toast";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  RotateCw,
  Sparkles,
  X,
  Zap
} from "lucide-react";

type TabId = "quick" | "domain";

type Props = {
  serviceId: string;
  onClose: () => void;
};

/**
 * Per-service "Go Public" wizard. S1 lays the shell — tabs render placeholder
 * panes that S2 / S3 will fill in. The shell already wires the unified
 * exposure read so each later sequence plugs into the same data source.
 */
export function GoPublicWizard({ serviceId, onClose }: Props) {
  const { data, loading, error, refetch } = useExposure(serviceId);
  const [tab, setTab] = useState<TabId>("quick");
  const [busy, setBusy] = useState<
    "start" | "stop" | "regenerate" | "bind" | "unbind" | "test" | "creds" | "connect" | null
  >(null);

  // Domain tab state
  const [domain, setDomain] = useState("");
  const [overwriteDns, setOverwriteDns] = useState(false);
  const [zoneMismatch, setZoneMismatch] = useState<{ authorizedZone: string | null; domain: string } | null>(
    null
  );
  // Guards the long (≤5-min) re-auth poll from touching state / re-binding after
  // the wizard is closed.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [creds, setCreds] = useState({
    apiToken: "",
    tunnelToken: "",
    accountId: "",
    tunnelId: "",
    zoneId: ""
  });
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number;
    latencyMs: number;
    error?: string;
  } | null>(null);
  const [renewing, setRenewing] = useState(false);

  async function renewCertificate(): Promise<void> {
    if (!serviceId) return;
    setRenewing(true);
    try {
      await api(`/services/${serviceId}/certificate/renew`, { method: "POST" });
      toast.success("Certificate renewal kicked off");
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setRenewing(false);
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Clipboard failed");
    }
  }

  async function startQuickTunnel(): Promise<void> {
    if (!serviceId) return;
    setBusy("start");
    try {
      const res = await api<{ spawned: boolean }>(`/cloudflare/quick-tunnel/${serviceId}`, {
        method: "POST"
      });
      toast.success(
        res.spawned ? "Quick tunnel starting…" : "Quick tunnel queued — will start when service runs."
      );
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function stopQuickTunnel(): Promise<void> {
    if (!serviceId) return;
    setBusy("stop");
    try {
      await api(`/cloudflare/quick-tunnel/${serviceId}`, { method: "DELETE" });
      toast.success("Quick tunnel stopped");
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function regenerateQuickTunnel(): Promise<void> {
    if (!serviceId) return;
    setBusy("regenerate");
    try {
      await api(`/cloudflare/quick-tunnel/${serviceId}/regenerate`, { method: "POST" });
      toast.success("Generating a new quick-tunnel URL…");
      // The new URL arrives via WS; refetch will be triggered by exposure_changed.
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function saveCredentials(): Promise<void> {
    setBusy("creds");
    try {
      const body: Record<string, string> = {};
      if (creds.apiToken.trim()) body.apiToken = creds.apiToken.trim();
      if (creds.tunnelToken.trim()) body.tunnelToken = creds.tunnelToken.trim();
      if (creds.accountId.trim()) body.accountId = creds.accountId.trim();
      if (creds.tunnelId.trim()) body.tunnelId = creds.tunnelId.trim();
      if (creds.zoneId.trim()) body.zoneId = creds.zoneId.trim();
      if (Object.keys(body).length === 0) {
        toast.error("Fill at least one field");
        return;
      }
      await api("/cloudflare/credentials", { method: "POST", body: JSON.stringify(body) });
      toast.success("Cloudflare credentials saved");
      setCreds({ apiToken: "", tunnelToken: "", accountId: "", tunnelId: "", zoneId: "" });
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function connectCloudflare(): Promise<void> {
    setBusy("connect");
    try {
      const res = await api<{ authUrl: string | null; connected: boolean }>(
        "/cloudflare/connect/login",
        { method: "POST" }
      );
      if (res.connected) {
        toast.success("Cloudflare already connected");
        await refetch();
        return;
      }
      if (res.authUrl) {
        window.open(res.authUrl, "_blank", "noopener,noreferrer");
        toast.info("Authorize ServerHoster in the Cloudflare tab, then come back here.");
      } else {
        toast.info("Starting Cloudflare login… the authorization link will open shortly.");
      }
      // Poll until cert.pem appears (≤5 min — the login link expires).
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await api<{ connected: boolean; authUrl: string | null }>(
          "/cloudflare/connect/status",
          { silent: true }
        );
        if (st.connected) {
          toast.success("Cloudflare connected");
          await refetch();
          return;
        }
      }
      toast.error("Login timed out. Click Connect Cloudflare to retry.");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function disconnectCloudflareTunnel(): Promise<void> {
    setBusy("connect");
    try {
      await api("/cloudflare/connect/disconnect", { method: "POST" });
      toast.success("Cloudflare disconnected");
      setZoneMismatch(null);
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function bindDomain(domainArg?: string): Promise<void> {
    if (!serviceId) return;
    const value = (domainArg ?? domain).trim().toLowerCase();
    if (!value) {
      toast.error("Enter a domain");
      return;
    }
    setBusy("bind");
    setZoneMismatch(null);
    try {
      await api(`/services/${serviceId}/expose/domain`, {
        method: "POST",
        body: JSON.stringify({ domain: value, overwriteDns }),
        silent: true // we surface CF_WRONG_ZONE as an in-panel re-auth CTA, others as a toast
      });
      toast.success(`Bound https://${value}`);
      setDomain("");
      setOverwriteDns(false);
      setZoneMismatch(null);
      await refetch();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CF_WRONG_ZONE") {
        setZoneMismatch({ authorizedZone: (err.meta?.authorizedZone as string) ?? null, domain: value });
      } else {
        toast.error(err instanceof Error ? err.message : "Could not bind domain");
      }
    } finally {
      setBusy(null);
    }
  }

  // One-click recovery for a wrong-zone bind: force a fresh Cloudflare login so
  // the user can authorize THIS domain's zone, then auto-retry the bind — no
  // manual DNS editing required.
  async function reauthorizeForZone(): Promise<void> {
    if (!zoneMismatch) return;
    const target = zoneMismatch.domain;
    setBusy("connect");
    try {
      const res = await api<{ authUrl: string | null }>("/cloudflare/connect/login", {
        method: "POST",
        body: JSON.stringify({ force: true })
      });
      if (res.authUrl) window.open(res.authUrl, "_blank", "noopener,noreferrer");
      toast.info(`In the Cloudflare tab, select "${target}" to authorize it.`);
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!mounted.current) return; // wizard closed — stop polling, don't re-bind
        const st = await api<{ connected: boolean }>("/cloudflare/connect/status", {
          silent: true,
          noAuthExpiry: true // a transient 401 during the 5-min poll must not redirect to /login
        });
        if (st.connected) {
          toast.success("Re-authorized — binding the domain…");
          setZoneMismatch(null);
          setBusy(null);
          await bindDomain(target); // retry now that the correct zone is authorized
          return;
        }
      }
      if (mounted.current) toast.error("Re-authorization timed out. Click Re-authorize to retry.");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function unbindDomain(): Promise<void> {
    if (!serviceId) return;
    setBusy("unbind");
    try {
      await api(`/services/${serviceId}/expose/domain`, { method: "DELETE" });
      toast.success("Domain unbound");
      setZoneMismatch(null);
      setTestResult(null);
      await refetch();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function testDomain(): Promise<void> {
    if (!serviceId) return;
    setBusy("test");
    try {
      const res = await api<{ ok: boolean; status: number; latencyMs: number; error?: string }>(
        `/services/${serviceId}/expose/test`,
        { method: "POST" }
      );
      setTestResult(res);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const credentialsComplete = data
    ? data.capabilities.hasCloudflareApiToken &&
      data.capabilities.hasCloudflareTunnelToken &&
      data.capabilities.hasCloudflareTunnelId &&
      data.capabilities.hasCloudflareZoneId
    : false;
  const cfConnected = data?.capabilities.cloudflareConnected ?? false;
  // A domain can be bound either via the browser-login tunnel OR the legacy tokens.
  const canBind = cfConnected || credentialsComplete;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content go-public-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="row" style={{ gap: "0.5rem" }}>
            <Sparkles size={18} />
            <h3>Go Public {data ? `— ${data.service.name}` : ""}</h3>
          </div>
          <button className="ghost icon-only" aria-label="Close wizard" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="go-public-body">
          <aside className="go-public-rail">
            <button
              className={`rail-item ${tab === "quick" ? "active" : ""}`}
              onClick={() => setTab("quick")}
            >
              <Zap size={14} /> Quick share
              <span className="muted tiny">Instant, ephemeral URL</span>
            </button>
            <button
              className={`rail-item ${tab === "domain" ? "active" : ""}`}
              onClick={() => setTab("domain")}
            >
              <Globe size={14} /> Custom domain
              <span className="muted tiny">Stable, your own DNS</span>
            </button>
          </aside>

          <section className="go-public-pane">
            {loading && !data && (
              <div className="muted small row">
                <Loader2 size={14} className="animate-spin" /> Loading exposure state…
              </div>
            )}
            {error && !data && <div className="text-warn small">Failed to load: {error}</div>}
            {data && tab === "quick" && (
              <div>
                <h4>Quick share</h4>
                <p className="muted small">
                  Instant share via a Cloudflare-hosted ephemeral URL. No account required. The URL changes on
                  regenerate or container restart.
                </p>

                {!data.capabilities.hasCloudflaredBinary && (
                  <div className="warn-block">
                    <strong>cloudflared not installed.</strong>
                    <span className="muted tiny">Settings → Edge & SSL → Install cloudflared.</span>
                  </div>
                )}

                {data.quickTunnel.running && data.quickTunnel.tunnelUrl ? (
                  <div className="public-url-block">
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <span className="status-dot running" />
                      <span className="muted tiny">Live</span>
                    </div>
                    <a
                      className="public-url-link"
                      href={data.quickTunnel.tunnelUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {data.quickTunnel.tunnelUrl}
                      <ExternalLink size={12} />
                    </a>
                    <div className="row" style={{ gap: "0.4rem" }}>
                      <button
                        className="ghost xsmall"
                        onClick={() => void copyToClipboard(data.quickTunnel.tunnelUrl!)}
                      >
                        <Copy size={12} /> Copy
                      </button>
                      <button
                        className="ghost xsmall"
                        disabled={busy === "regenerate"}
                        onClick={() => void regenerateQuickTunnel()}
                      >
                        {busy === "regenerate" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RotateCw size={12} />
                        )}{" "}
                        Regenerate
                      </button>
                      <button
                        className="ghost xsmall text-warn"
                        disabled={busy === "stop"}
                        onClick={() => void stopQuickTunnel()}
                      >
                        {busy === "stop" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}{" "}
                        Stop
                      </button>
                    </div>
                    <span className="muted tiny">
                      Auto-injects <code>PUBLIC_URL</code> into the service. Restart the service for new
                      processes to pick it up.
                    </span>
                  </div>
                ) : data.service.quick_tunnel_enabled ? (
                  <div className="public-url-block">
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <span className="status-dot starting" />
                      <span className="muted tiny">Queued — will start when service is running</span>
                    </div>
                    <button
                      className="ghost xsmall text-warn"
                      disabled={busy === "stop"}
                      onClick={() => void stopQuickTunnel()}
                    >
                      {busy === "stop" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}{" "}
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary"
                    style={{ marginTop: "0.75rem" }}
                    disabled={
                      busy === "start" || !data.capabilities.hasCloudflaredBinary || !data.service.port
                    }
                    onClick={() => void startQuickTunnel()}
                  >
                    {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                    Start quick tunnel
                  </button>
                )}

                {!data.service.port && (
                  <p className="muted tiny" style={{ marginTop: "0.5rem" }}>
                    Service has no port assigned — set one in Service settings before starting a tunnel.
                  </p>
                )}
              </div>
            )}
            {data && tab === "domain" && (
              <div>
                <h4>Custom domain</h4>
                <p className="muted small">
                  Stable URL on your own domain via a Cloudflare named tunnel. Free TLS at the edge.
                </p>

                {/* (A) Browser-login connect — primary path */}
                {cfConnected ? (
                  <div className="public-url-block">
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <span className="status-dot running" />
                      <span className="muted tiny">
                        Connected to Cloudflare
                        {data.capabilities.cloudflareAccountLabel
                          ? ` · tunnel "${data.capabilities.cloudflareAccountLabel}"`
                          : ""}
                      </span>
                    </div>
                    <span className="muted tiny">
                      Bind a domain you've already added to Cloudflare — no tokens to hunt down.
                    </span>
                    <button
                      className="ghost xsmall text-warn"
                      disabled={busy === "connect"}
                      onClick={() => void disconnectCloudflareTunnel()}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {busy === "connect" ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <X size={12} />
                      )}{" "}
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <div className="public-url-block">
                    <strong style={{ fontSize: "0.85rem" }}>Connect Cloudflare</strong>
                    <span className="muted tiny">
                      Authorize in your browser — no API keys. You'll need a domain already added to your
                      Cloudflare account.
                    </span>
                    <button
                      className="primary"
                      disabled={busy === "connect" || !data.capabilities.hasCloudflaredBinary}
                      onClick={() => void connectCloudflare()}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {busy === "connect" ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Globe size={14} />
                      )}{" "}
                      Connect Cloudflare
                    </button>
                    {!data.capabilities.hasCloudflaredBinary && (
                      <span className="muted tiny">
                        cloudflared not installed — Settings → Edge &amp; SSL → Install cloudflared.
                      </span>
                    )}

                    {/* (B) Advanced fallback: manual token entry (legacy path) */}
                    <details
                      className="creds-details"
                      open={showAdvanced}
                      onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
                    >
                      <summary>Advanced: paste API tokens instead</summary>
                      <p className="muted tiny" style={{ marginTop: "0.4rem" }}>
                        API token (with <em>DNS:Edit</em> + <em>Cloudflare Tunnel:Edit</em>), tunnel token,
                        account ID, tunnel ID, and zone ID. Already-saved fields can be left blank.
                      </p>
                      <div className="creds-grid">
                      <label>
                        <span>
                          API token{" "}
                          <span className="muted tiny">
                            {data.capabilities.hasCloudflareApiToken ? "✓ saved" : "missing"}
                          </span>
                        </span>
                        <input
                          type="password"
                          value={creds.apiToken}
                          onChange={(e) => setCreds({ ...creds, apiToken: e.target.value })}
                          placeholder="Bearer …"
                        />
                      </label>
                      <label>
                        <span>
                          Tunnel token{" "}
                          <span className="muted tiny">
                            {data.capabilities.hasCloudflareTunnelToken ? "✓ saved" : "missing"}
                          </span>
                        </span>
                        <input
                          type="password"
                          value={creds.tunnelToken}
                          onChange={(e) => setCreds({ ...creds, tunnelToken: e.target.value })}
                          placeholder="ey…"
                        />
                      </label>
                      <label>
                        <span>Account ID</span>
                        <input
                          value={creds.accountId}
                          onChange={(e) => setCreds({ ...creds, accountId: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>
                          Tunnel ID{" "}
                          <span className="muted tiny">
                            {data.capabilities.hasCloudflareTunnelId ? "✓ saved" : "missing"}
                          </span>
                        </span>
                        <input
                          value={creds.tunnelId}
                          onChange={(e) => setCreds({ ...creds, tunnelId: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>
                          Zone ID{" "}
                          <span className="muted tiny">
                            {data.capabilities.hasCloudflareZoneId ? "✓ saved" : "missing"}
                          </span>
                        </span>
                        <input
                          value={creds.zoneId}
                          onChange={(e) => setCreds({ ...creds, zoneId: e.target.value })}
                        />
                      </label>
                    </div>
                    <button
                      className="primary xsmall"
                      disabled={busy === "creds"}
                      onClick={() => void saveCredentials()}
                      style={{ marginTop: "0.5rem" }}
                    >
                      {busy === "creds" ? <Loader2 size={12} className="animate-spin" /> : null} Save
                      credentials
                    </button>
                    </details>
                  </div>
                )}

                {data.service.domain ? (
                  <div className="public-url-block">
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <span className="status-dot running" />
                      <span className="muted tiny">Bound to {data.service.domain}</span>
                    </div>
                    <a
                      className="public-url-link"
                      href={`https://${data.service.domain}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      https://{data.service.domain}
                      <ExternalLink size={12} />
                    </a>
                    <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
                      <button
                        className="ghost xsmall"
                        disabled={busy === "test"}
                        onClick={() => void testDomain()}
                      >
                        {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : null} Test
                        connection
                      </button>
                      <button
                        className="ghost xsmall"
                        onClick={() => void copyToClipboard(`https://${data.service.domain}`)}
                      >
                        <Copy size={12} /> Copy
                      </button>
                      <button
                        className="ghost xsmall text-warn"
                        disabled={busy === "unbind"}
                        onClick={() => void unbindDomain()}
                      >
                        {busy === "unbind" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}{" "}
                        Unbind
                      </button>
                    </div>
                    {testResult && (
                      <div className={`test-pill ${testResult.ok ? "good" : "bad"}`}>
                        {testResult.ok
                          ? `✓ ${testResult.status} in ${testResult.latencyMs}ms`
                          : `× ${testResult.error ?? `HTTP ${testResult.status}`}`}
                      </div>
                    )}
                    {data.certificate && (
                      <div
                        className={`cert-row ${data.certificate.days_remaining < 7 ? "stale" : data.certificate.days_remaining < 30 ? "warn" : "ok"}`}
                      >
                        <Lock size={12} />
                        <span>
                          {data.certificate.issuer === "cloudflare"
                            ? "TLS terminated at Cloudflare edge"
                            : `Let's Encrypt cert · expires in ${data.certificate.days_remaining}d`}
                        </span>
                        {data.certificate.issuer === "letsencrypt" && (
                          <button
                            className="ghost xsmall"
                            disabled={renewing}
                            onClick={() => void renewCertificate()}
                          >
                            {renewing ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RotateCw size={12} />
                            )}{" "}
                            Renew now
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bind-row">
                    <input
                      className="domain-input"
                      placeholder="app.example.com"
                      value={domain}
                      onChange={(e) => {
                        setDomain(e.target.value);
                        if (zoneMismatch) setZoneMismatch(null);
                      }}
                    />
                    <button
                      className="primary"
                      disabled={busy === "bind" || !canBind || !data.service.port}
                      onClick={() => void bindDomain()}
                    >
                      {busy === "bind" ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                      Bind domain
                    </button>
                  </div>
                )}

                {zoneMismatch && cfConnected && (
                  <div className="zone-mismatch" role="alert">
                    <AlertTriangle size={18} className="zone-mismatch-icon" />
                    <div className="zone-mismatch-body">
                      <strong>Wrong Cloudflare zone</strong>
                      <p className="muted tiny">
                        Cloudflare is authorized for{" "}
                        <code>{zoneMismatch.authorizedZone ?? "another zone"}</code>, but{" "}
                        <code>{zoneMismatch.domain}</code> is a separate zone — so its DNS won&rsquo;t
                        resolve to your tunnel. Re-authorize and pick <code>{zoneMismatch.domain}</code>;
                        ServerHoster will finish the binding automatically.
                      </p>
                      <button
                        className="primary"
                        disabled={busy !== null}
                        onClick={() => void reauthorizeForZone()}
                      >
                        {busy === "connect" ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Lock size={14} />
                        )}
                        Re-authorize for {zoneMismatch.domain}
                      </button>
                    </div>
                  </div>
                )}

                {cfConnected && !data.service.domain && (
                  <label className="overwrite-toggle">
                    <input
                      type="checkbox"
                      checked={overwriteDns}
                      onChange={(e) => setOverwriteDns(e.target.checked)}
                    />
                    <span className="muted tiny">
                      Overwrite an existing DNS record for this domain (tick this if binding failed with
                      &ldquo;DNS record already exists&rdquo;).
                    </span>
                  </label>
                )}

                {!canBind && !data.service.domain && (
                  <p className="muted tiny" style={{ marginTop: "0.4rem" }}>
                    Connect Cloudflare (or save tokens under Advanced) before binding a domain.
                  </p>
                )}
                {!data.service.port && (
                  <p className="muted tiny" style={{ marginTop: "0.4rem" }}>
                    Service has no port assigned — set one in Service settings before binding.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .go-public-modal { max-width: 720px; }
          .go-public-body {
            display: grid;
            grid-template-columns: 220px 1fr;
            gap: 1rem;
            min-height: 320px;
          }
          .go-public-rail { display: flex; flex-direction: column; gap: 0.25rem; padding-right: 0.75rem; border-right: 1px solid var(--border-subtle); }
          .rail-item {
            display: grid;
            grid-template-columns: auto 1fr;
            grid-template-rows: auto auto;
            column-gap: 0.5rem;
            row-gap: 0.15rem;
            align-items: center;
            padding: 0.55rem 0.7rem;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--radius-sm);
            color: var(--text-primary);
            font-size: 0.82rem;
            cursor: pointer;
            text-align: left;
          }
          .rail-item span { grid-column: 2 / 3; }
          .rail-item:hover { background: var(--bg-sunken); }
          .rail-item.active { background: var(--bg-card); border-color: var(--accent); }
          .go-public-pane h4 { margin: 0 0 0.4rem; font-size: 1rem; }
          .placeholder-block {
            margin-top: 0.75rem;
            padding: 0.75rem;
            border: 1px dashed var(--border-subtle);
            border-radius: var(--radius-sm);
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
          }
          .warn-block {
            margin-top: 0.75rem;
            padding: 0.6rem 0.75rem;
            border: 1px solid color-mix(in srgb, var(--warn, #d97706) 40%, transparent);
            background: color-mix(in srgb, var(--warn, #d97706) 10%, transparent);
            border-radius: var(--radius-sm);
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
          }
          .public-url-block {
            margin-top: 0.75rem;
            padding: 0.85rem 0.9rem;
            background: var(--bg-sunken);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          .public-url-link {
            font-family: var(--font-mono);
            font-size: 0.78rem;
            color: var(--accent-light, var(--accent));
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            word-break: break-all;
          }
          .public-url-link:hover { text-decoration: underline; }
          .status-dot {
            display: inline-block;
            width: 8px; height: 8px;
            border-radius: 50%;
            background: var(--text-muted);
          }
          .status-dot.running { background: var(--success, #10b981); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success, #10b981) 25%, transparent); }
          .status-dot.starting { background: var(--warn, #d97706); }
          .text-warn { color: var(--warn, #d97706); }
          .creds-details {
            margin-top: 0.75rem;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            padding: 0.6rem 0.75rem;
            background: var(--bg-sunken);
          }
          .creds-details summary { cursor: pointer; font-size: 0.82rem; font-weight: 700; }
          .creds-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.5rem;
            margin-top: 0.6rem;
          }
          .creds-grid label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.74rem; }
          .creds-grid input {
            padding: 0.35rem 0.5rem;
            border: 1px solid var(--border-subtle);
            background: var(--bg-card);
            color: var(--text-primary);
            border-radius: var(--radius-sm);
            font-size: 0.78rem;
          }
          .bind-row {
            display: flex;
            gap: 0.5rem;
            margin-top: 0.75rem;
          }
          .overwrite-toggle {
            display: flex;
            align-items: flex-start;
            gap: 0.4rem;
            margin-top: 0.5rem;
            cursor: pointer;
          }
          .overwrite-toggle input { margin-top: 0.15rem; }
          .domain-input {
            flex: 1;
            padding: 0.5rem 0.7rem;
            border: 1px solid var(--border-subtle);
            background: var(--bg-card);
            color: var(--text-primary);
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.82rem;
          }
          .test-pill {
            display: inline-flex;
            padding: 0.3rem 0.6rem;
            border-radius: 999px;
            font-size: 0.72rem;
            font-family: var(--font-mono);
            border: 1px solid var(--border-subtle);
            background: var(--bg-card);
          }
          .test-pill.good { color: var(--success, #10b981); border-color: color-mix(in srgb, var(--success, #10b981) 40%, transparent); }
          .test-pill.bad { color: var(--warn, #d97706); border-color: color-mix(in srgb, var(--warn, #d97706) 40%, transparent); }
          .cert-row {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.4rem 0.6rem;
            border-radius: var(--radius-sm);
            font-size: 0.74rem;
            border: 1px solid var(--border-subtle);
            background: var(--bg-card);
          }
          .cert-row.ok { color: var(--success, #10b981); border-color: color-mix(in srgb, var(--success, #10b981) 35%, transparent); }
          .cert-row.warn { color: var(--warn, #d97706); border-color: color-mix(in srgb, var(--warn, #d97706) 40%, transparent); }
          .cert-row.stale { color: var(--danger, #ef4444); border-color: color-mix(in srgb, var(--danger, #ef4444) 40%, transparent); background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent); }
          .cert-row button { margin-left: auto; }
          .text-warn { color: var(--warn, #d97706); }
          .animate-spin { animation: gpspin 1s linear infinite; }
          @keyframes gpspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          @media (max-width: 700px) {
            .go-public-body { grid-template-columns: 1fr; }
            .go-public-rail { border-right: none; border-bottom: 1px solid var(--border-subtle); padding-right: 0; padding-bottom: 0.5rem; flex-direction: row; overflow-x: auto; }
          }
        `
          }}
        />
      </div>
    </div>
  );
}
