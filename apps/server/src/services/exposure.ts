import type { AppContext } from "../types.js";
import { detectCloudflared, getQuickTunnelStatus, getTunnelStatus } from "./cloudflare.js";
import { getSecretSetting, getSetting } from "./settings.js";

/**
 * Unified read of "is this service public, and what mechanisms can the user
 * pick from?" Powers the GoPublicWizard so it doesn't have to cross-reference
 * /services, /databases, /cloudflare/status, /proxy and /certificates.
 */

export type ExposureMode = "none" | "quick-tunnel" | "named-tunnel";

export type ExposureSummary = {
  service: {
    id: string;
    name: string;
    port: number | null;
    domain: string | null;
    status: string;
    tunnel_url: string | null;
    quick_tunnel_enabled: boolean;
    ssl_status: string | null;
    public_url: string | null;
  };
  mode: ExposureMode;
  /** Live cloudflared quick-tunnel runtime, if any. */
  quickTunnel: {
    running: boolean;
    pid: number | null;
    tunnelUrl: string | null;
  };
  /** Cloudflare named tunnel daemon state. */
  namedTunnel: ReturnType<typeof getTunnelStatus>;
  proxyRoute: { domain: string; target_port: number } | null;
  certificate: {
    issuer: string;
    issued_at: string | null;
    expires_at: string;
    days_remaining: number;
  } | null;
  capabilities: {
    /** cloudflared binary present and runnable. */
    hasCloudflaredBinary: boolean;
    /** Cloudflare API token saved (for named-tunnel DNS upserts). */
    hasCloudflareApiToken: boolean;
    /** Cloudflare tunnel token saved (the credential cloudflared run --token uses). */
    hasCloudflareTunnelToken: boolean;
    /** Tunnel ID saved (named tunnel); needed to upsert ingress and CNAME. */
    hasCloudflareTunnelId: boolean;
    /** Zone ID saved (where DNS records live). */
    hasCloudflareZoneId: boolean;
  };
};

type ServiceRow = {
  id: string;
  name: string;
  port: number | null;
  domain: string | null;
  status: string;
  tunnel_url: string | null;
  quick_tunnel_enabled: number | null;
  ssl_status: string | null;
};

type ProxyRow = { domain: string; target_port: number };
type CertRow = { domain: string; expires_at: number; created_at: string };

function deriveMode(svc: ServiceRow, quickRunning: boolean): ExposureMode {
  if (quickRunning || svc.tunnel_url) return "quick-tunnel";
  if (svc.domain) return "named-tunnel";
  return "none";
}

function derivePublicUrl(svc: ServiceRow, mode: ExposureMode): string | null {
  if (mode === "quick-tunnel") return svc.tunnel_url;
  if (mode === "named-tunnel" && svc.domain) {
    const scheme = svc.ssl_status === "secure" || svc.ssl_status === "cloudflare" ? "https" : "http";
    return `${scheme}://${svc.domain}`;
  }
  return null;
}

export function getExposure(ctx: AppContext, serviceId: string): ExposureSummary {
  const svc = ctx.db
    .prepare(
      "SELECT id, name, port, domain, status, tunnel_url, quick_tunnel_enabled, ssl_status FROM services WHERE id = ?"
    )
    .get(serviceId) as ServiceRow | undefined;
  if (!svc) throw new Error("Service not found");

  const quickStatus = getQuickTunnelStatus(serviceId);
  const namedStatus = getTunnelStatus(ctx);

  const proxyRoute =
    (ctx.db.prepare("SELECT domain, target_port FROM proxy_routes WHERE service_id = ?").get(serviceId) as
      | ProxyRow
      | undefined) ?? null;

  const certRow = svc.domain
    ? ((ctx.db
        .prepare("SELECT domain, expires_at, created_at FROM certificates WHERE domain = ?")
        .get(svc.domain) as CertRow | undefined) ?? null)
    : null;

  const certificate = certRow
    ? {
        issuer: svc.ssl_status === "cloudflare" ? "cloudflare" : "letsencrypt",
        issued_at: certRow.created_at,
        expires_at: new Date(certRow.expires_at).toISOString(),
        days_remaining: Math.max(0, Math.floor((certRow.expires_at - Date.now()) / 86400000))
      }
    : null;

  const detected = detectCloudflared(ctx);
  const capabilities = {
    hasCloudflaredBinary: Boolean(detected.binary),
    hasCloudflareApiToken: Boolean(getSecretSetting(ctx, "cloudflare_api_token")),
    hasCloudflareTunnelToken: Boolean(getSecretSetting(ctx, "cloudflare_tunnel_token")),
    hasCloudflareTunnelId: Boolean(getSetting(ctx, "cloudflare_tunnel_id")),
    hasCloudflareZoneId: Boolean(getSetting(ctx, "cloudflare_zone_id"))
  };

  const mode = deriveMode(svc, quickStatus.running);
  const public_url = derivePublicUrl(svc, mode);

  return {
    service: {
      id: svc.id,
      name: svc.name,
      port: svc.port,
      domain: svc.domain,
      status: svc.status,
      tunnel_url: svc.tunnel_url,
      quick_tunnel_enabled: Boolean(svc.quick_tunnel_enabled),
      ssl_status: svc.ssl_status,
      public_url
    },
    mode,
    quickTunnel: quickStatus,
    namedTunnel: namedStatus,
    proxyRoute,
    certificate,
    capabilities
  };
}
