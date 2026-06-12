import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  Plus,
  Trash2,
  RefreshCw,
  ShieldCheck,
  Clock,
  XCircle,
  Copy,
  KeyRound,
  Network,
  CheckCircle2,
  AlertTriangle,
  ExternalLink
} from "lucide-react";

import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";

type Service = { id: string; name: string; status?: string; port?: number };

type SaasDomain = {
  id: string;
  service_id: string;
  hostname: string;
  status: "pending_dns" | "dns_verified" | "ssl_issuing" | "active" | "failed" | string;
  ssl_status: string;
  mode: "custom_hostname" | "own_zone" | string;
  cname_target: string | null;
  verification_txt_name: string | null;
  verification_txt_value: string | null;
  failure_reason: string | null;
  last_checked_at: string | null;
  created_at: string;
};

type SaasConfig = {
  ready: boolean;
  tenantDomainsReady: boolean;
  missing: string[];
  apiTokenConfigured: boolean;
  zoneId: string | null;
  zoneName: string | null;
  tunnelId: string | null;
  tunnelConnected: boolean;
  fallbackOrigin: string | null;
  fallbackServiceId: string | null;
  apiHostname: string | null;
  machineTokenConfigured: boolean;
  domainsCount: number;
};

const STATUS_META: Record<string, { label: string; icon: typeof Clock; cls: string }> = {
  pending_dns: { label: "Pending DNS", icon: Clock, cls: "dom-status-pending" },
  dns_verified: { label: "Validating", icon: Clock, cls: "dom-status-progress" },
  ssl_issuing: { label: "Issuing SSL", icon: Clock, cls: "dom-status-progress" },
  active: { label: "Active", icon: ShieldCheck, cls: "dom-status-active" },
  failed: { label: "Failed", icon: XCircle, cls: "dom-status-failed" }
};

const MISSING_HINTS: Record<string, string> = {
  cloudflare_api_token: "Add a Cloudflare API token (Zone DNS Edit + SSL and Certificates Edit) under Settings → Cloudflare.",
  cloudflare_zone_id: "Set your Cloudflare Zone ID under Settings → Cloudflare.",
  cloudflare_tunnel: "Connect Cloudflare (browser login) or configure a named tunnel so traffic can reach this machine."
};

export function DomainsPage() {
  const [config, setConfig] = useState<SaasConfig | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [domains, setDomains] = useState<SaasDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [serviceId, setServiceId] = useState<string>(() => localStorage.getItem("survhub_saas_service") ?? "");
  const [newHostname, setNewHostname] = useState("");
  const [adding, setAdding] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [fallbackOriginInput, setFallbackOriginInput] = useState("");
  const [apiHostnameInput, setApiHostnameInput] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  async function loadBase(): Promise<void> {
    try {
      const [cfg, svcRows] = await Promise.all([
        api<SaasConfig>("/saas/config", { silent: true }),
        api<Service[]>("/services", { silent: true })
      ]);
      setConfig(cfg);
      setServices(svcRows);
      setFallbackOriginInput((prev) => prev || cfg.fallbackOrigin || "");
      setApiHostnameInput((prev) => prev || cfg.apiHostname || "");
      setServiceId((prev) => {
        if (prev && svcRows.some((s) => s.id === prev)) return prev;
        return cfg.fallbackServiceId && svcRows.some((s) => s.id === cfg.fallbackServiceId)
          ? cfg.fallbackServiceId
          : (svcRows[0]?.id ?? "");
      });
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  async function loadDomains(svcId: string): Promise<void> {
    if (!svcId) {
      setDomains([]);
      return;
    }
    try {
      setDomains(await api<SaasDomain[]>(`/saas/services/${svcId}/domains`, { silent: true }));
    } catch {
      /* silent */
    }
  }

  useEffect(() => {
    void loadBase();
  }, []);

  useEffect(() => {
    if (serviceId) localStorage.setItem("survhub_saas_service", serviceId);
    void loadDomains(serviceId);
  }, [serviceId]);

  const selectedService = useMemo(() => services.find((s) => s.id === serviceId), [services, serviceId]);

  async function copyText(text: string, what = "Value"): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Clipboard failed");
    }
  }

  async function addDomain(): Promise<void> {
    const hostname = newHostname.trim().toLowerCase();
    if (!hostname || !serviceId) return;
    setAdding(true);
    try {
      await api(`/saas/services/${serviceId}/domains`, {
        method: "POST",
        body: JSON.stringify({ hostname })
      });
      setNewHostname("");
      toast.success(`${hostname} registered — DNS instructions are on the card`);
      await Promise.all([loadDomains(serviceId), loadBase()]);
    } catch {
      /* toasted */
    } finally {
      setAdding(false);
    }
  }

  async function verifyDomain(domain: SaasDomain): Promise<void> {
    setVerifyingId(domain.id);
    try {
      const res = await api<{ status: string; message: string }>(`/saas/domains/${domain.id}/verify`, {
        method: "POST"
      });
      if (res.status === "active") toast.success(res.message);
      else toast.info(res.message);
      await loadDomains(serviceId);
    } catch {
      /* toasted */
    } finally {
      setVerifyingId(null);
    }
  }

  async function removeDomain(domain: SaasDomain): Promise<void> {
    const ok = await confirmDialog({
      title: `Disconnect ${domain.hostname}?`,
      message:
        "The Cloudflare custom hostname and tunnel route will be removed. The tenant's site stops resolving on this domain.",
      danger: true,
      confirmLabel: "Disconnect"
    });
    if (!ok) return;
    try {
      await api(`/saas/domains/${domain.id}`, { method: "DELETE" });
      toast.success(`${domain.hostname} disconnected`);
      await Promise.all([loadDomains(serviceId), loadBase()]);
    } catch {
      /* toasted */
    }
  }

  async function rotateToken(): Promise<void> {
    const ok = await confirmDialog({
      title: config?.machineTokenConfigured ? "Rotate machine token?" : "Generate machine token?",
      message: config?.machineTokenConfigured
        ? "External callers (e.g. the publisher's Supabase edge functions) using the old token stop working until updated."
        : "This token lets external machine clients (e.g. Supabase edge functions) manage domains via the /saas API.",
      confirmLabel: config?.machineTokenConfigured ? "Rotate" : "Generate"
    });
    if (!ok) return;
    try {
      const res = await api<{ token: string }>("/saas/token/rotate", { method: "POST" });
      setFreshToken(res.token);
      await loadBase();
      toast.success("Machine token generated — copy it now, it is shown only once");
    } catch {
      /* toasted */
    }
  }

  async function saveSaasConfig(): Promise<void> {
    setSavingConfig(true);
    try {
      const body: Record<string, string> = {};
      if (fallbackOriginInput.trim()) body.fallbackOrigin = fallbackOriginInput.trim().toLowerCase();
      if (serviceId) body.fallbackServiceId = serviceId;
      if (apiHostnameInput.trim()) body.apiHostname = apiHostnameInput.trim().toLowerCase();
      const res = await api<{ ok: boolean; fallbackError: string | null; apiHostnameError: string | null }>(
        "/saas/config",
        { method: "POST", body: JSON.stringify(body) }
      );
      if (res.fallbackError) toast.error(`Fallback origin: ${res.fallbackError}`);
      if (res.apiHostnameError) toast.error(`API hostname: ${res.apiHostnameError}`);
      if (res.ok) toast.success("SaaS domain configuration applied");
      await loadBase();
    } catch {
      /* toasted */
    } finally {
      setSavingConfig(false);
    }
  }

  if (loading) {
    return (
      <div className="domains-page">
        <header className="page-header">
          <Skeleton style={{ height: "3rem", width: "420px" }} />
        </header>
        <Skeleton style={{ height: "200px", marginBottom: "2rem" }} />
        <div className="grid">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="domains-page">
      <header className="page-header">
        <div className="title-group">
          <h2>SaaS Domains</h2>
          <p className="muted">
            Tenant-owned custom domains for a hosted multi-tenant app — registered as Cloudflare for SaaS
            custom hostnames and routed through the tunnel to the service.
          </p>
        </div>
      </header>

      {/* ── Readiness / configuration ─────────────────────────────────── */}
      <section className="card" style={{ border: "1px solid var(--border-glow)" }}>
        <div className="section-title">
          <div className="row">
            <Network className="text-accent" size={20} />
            <h3>Cloudflare for SaaS Setup</h3>
            {config?.ready ? (
              <span className="badge accent">
                <CheckCircle2 size={12} /> Ready
              </span>
            ) : (
              <span className="badge danger">
                <AlertTriangle size={12} /> Needs configuration
              </span>
            )}
          </div>
        </div>

        {!config?.ready && (
          <div className="dom-missing-list">
            {(config?.missing ?? []).map((key) => (
              <div key={key} className="dom-missing-item">
                <AlertTriangle size={14} />
                <span>{MISSING_HINTS[key] ?? key}</span>
              </div>
            ))}
          </div>
        )}
        {config?.ready && !config.tenantDomainsReady && (
          <p className="tiny muted" style={{ marginTop: "0.75rem" }}>
            Connected via browser login — domains in your own Cloudflare zones bind instantly.
            To accept <strong>tenant-owned</strong> custom domains (Cloudflare for SaaS), also save a
            Cloudflare API token (Zone DNS Edit + SSL and Certificates Edit) and the Zone ID under
            Settings → Cloudflare.
          </p>
        )}

        <div className="form-row" style={{ marginTop: "1rem" }}>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">SaaS Service</label>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {services.length === 0 && <option value="">No services yet</option>}
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                  {service.port ? ` (:${service.port})` : ""}
                </option>
              ))}
            </select>
            <span className="field-hint">Tenant domains added below route to this service.</span>
          </div>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">Fallback Origin (CNAME target)</label>
            <input
              placeholder={config?.zoneName ? `apps.${config.zoneName}` : "apps.yourzone.com"}
              value={fallbackOriginInput}
              onChange={(e) => setFallbackOriginInput(e.target.value)}
            />
            <span className="field-hint">
              Hostname in your zone that tenants CNAME to. Created + pointed at the tunnel automatically.
            </span>
          </div>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">Public API Hostname (optional)</label>
            <input
              placeholder={config?.zoneName ? `hoster-api.${config.zoneName}` : "hoster-api.yourzone.com"}
              value={apiHostnameInput}
              onChange={(e) => setApiHostnameInput(e.target.value)}
            />
            <span className="field-hint">
              Exposes this control plane's /saas API through the tunnel so external edge functions can call it.
            </span>
          </div>
        </div>

        <div className="row" style={{ marginTop: "1rem", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="ghost" onClick={() => void rotateToken()}>
              <KeyRound size={16} />
              {config?.machineTokenConfigured ? "Rotate machine token" : "Generate machine token"}
            </button>
            {config?.machineTokenConfigured && !freshToken && (
              <span className="tiny muted">A machine token is configured (hidden).</span>
            )}
          </div>
          <button className="primary" disabled={savingConfig} onClick={() => void saveSaasConfig()}>
            {savingConfig ? <RefreshCw size={16} className="dom-spin" /> : <CheckCircle2 size={16} />}
            Apply configuration
          </button>
        </div>

        {freshToken && (
          <div className="dom-token-reveal">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="tiny uppercase font-bold muted">Machine token — shown once</span>
              <button className="ghost xsmall" onClick={() => void copyText(freshToken, "Token")}>
                <Copy size={13} /> Copy
              </button>
            </div>
            <code className="dom-token-value">{freshToken}</code>
            <p className="tiny muted" style={{ marginTop: "0.5rem" }}>
              For the publisher app, set these Supabase function secrets:{" "}
              <code>SERVERHOSTER_URL=https://{config?.apiHostname ?? "<api-hostname>"}</code>,{" "}
              <code>SERVERHOSTER_API_TOKEN=&lt;this token&gt;</code>,{" "}
              <code>SERVERHOSTER_SERVICE_ID={serviceId || "<service-id>"}</code>
            </p>
          </div>
        )}
      </section>

      {/* ── Add domain ─────────────────────────────────────────────────── */}
      <section className="card">
        <div className="section-title">
          <div className="row">
            <Plus className="text-accent" size={18} />
            <h3>Connect Tenant Domain</h3>
          </div>
        </div>
        <div className="row" style={{ marginTop: "1rem", gap: "0.75rem", flexWrap: "wrap" }}>
          <div className="row pr-overlap" style={{ flex: 1, minWidth: "260px" }}>
            <Globe size={18} className="icon-overlay muted" />
            <input
              className="with-icon"
              placeholder="blog.tenantdomain.com"
              value={newHostname}
              onChange={(e) => setNewHostname(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addDomain()}
            />
          </div>
          <button
            className="primary"
            disabled={adding || !newHostname.trim() || !serviceId || !config?.ready}
            onClick={() => void addDomain()}
          >
            {adding ? <RefreshCw size={16} className="dom-spin" /> : <Plus size={16} />} Connect
          </button>
        </div>
        <p className="tiny muted" style={{ marginTop: "0.75rem" }}>
          Hostnames inside your own zone ({config?.zoneName ?? "—"}) bind instantly. External tenant domains
          get a Cloudflare custom hostname: the tenant adds one CNAME and Cloudflare validates + issues SSL
          automatically.
        </p>
      </section>

      {/* ── Domain list ───────────────────────────────────────────────── */}
      <div className="section-title">
        <div className="row">
          <Globe className="text-accent" size={18} />
          <h3>Domains for {selectedService?.name ?? "—"}</h3>
          <span className="badge accent">{domains.length}</span>
        </div>
      </div>

      <div className="grid">
        <AnimatePresence>
          {domains.length === 0 ? (
            <motion.div key="empty" className="card text-center empty-state-card" style={{ gridColumn: "1 / -1" }}>
              <Globe size={60} className="muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
              <p className="muted font-bold">No tenant domains connected yet.</p>
              <p className="tiny muted" style={{ maxWidth: "460px", margin: "1rem auto" }}>
                Domains registered here (or via the /saas machine API from the hosted app) appear with their
                live validation and certificate state.
              </p>
            </motion.div>
          ) : (
            domains.map((domain) => {
              const meta = STATUS_META[domain.status] ?? STATUS_META.pending_dns;
              const StatusIcon = meta.icon;
              return (
                <motion.div
                  key={domain.id}
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="card service-card"
                >
                  <div className="service-header" style={{ marginBottom: "0.75rem" }}>
                    <div className="row" style={{ minWidth: 0 }}>
                      <Globe size={18} className="text-accent" />
                      <h3 style={{ fontSize: "1.15rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {domain.hostname}
                      </h3>
                    </div>
                  </div>

                  <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                    <span className={`dom-status ${meta.cls}`}>
                      <StatusIcon size={12} /> {meta.label}
                    </span>
                    <span className="dom-mode">
                      {domain.mode === "own_zone" ? "own zone" : "custom hostname"}
                    </span>
                    {domain.ssl_status === "active" && (
                      <span className="dom-status dom-status-active">
                        <ShieldCheck size={12} /> HTTPS
                      </span>
                    )}
                  </div>

                  {domain.failure_reason && domain.status !== "active" && (
                    <p className="tiny text-danger" style={{ marginTop: "0.75rem" }}>
                      {domain.failure_reason}
                    </p>
                  )}

                  {domain.status !== "active" && domain.cname_target && (
                    <div className="dom-dns-box">
                      <span className="tiny uppercase font-bold muted">Tenant DNS record</span>
                      <div className="dom-dns-row">
                        <span className="dom-dns-type">CNAME</span>
                        <span className="dom-dns-host">{domain.hostname}</span>
                        <span className="muted">→</span>
                        <span
                          className="dom-dns-value copyable"
                          onClick={() => void copyText(domain.cname_target ?? "", "CNAME target")}
                        >
                          {domain.cname_target}
                        </span>
                      </div>
                      {domain.verification_txt_name && domain.verification_txt_value && (
                        <div className="dom-dns-row">
                          <span className="dom-dns-type">TXT</span>
                          <span className="dom-dns-host">{domain.verification_txt_name}</span>
                          <span className="muted">→</span>
                          <span
                            className="dom-dns-value copyable"
                            onClick={() => void copyText(domain.verification_txt_value ?? "", "TXT value")}
                          >
                            {domain.verification_txt_value}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    className="service-footer"
                    style={{ marginTop: "1rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "0.75rem" }}
                  >
                    {domain.status !== "active" || domain.mode === "custom_hostname" ? (
                      <button
                        className="ghost xsmall"
                        disabled={verifyingId === domain.id}
                        onClick={() => void verifyDomain(domain)}
                      >
                        <RefreshCw size={14} className={verifyingId === domain.id ? "dom-spin" : ""} /> Check status
                      </button>
                    ) : null}
                    <a
                      href={`https://${domain.hostname}`}
                      target="_blank"
                      rel="noreferrer"
                      className="button ghost xsmall"
                    >
                      <ExternalLink size={14} /> Open
                    </a>
                    <button
                      className="ghost text-danger xsmall"
                      style={{ marginLeft: "auto" }}
                      onClick={() => void removeDomain(domain)}
                    >
                      <Trash2 size={14} /> Disconnect
                    </button>
                  </div>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
