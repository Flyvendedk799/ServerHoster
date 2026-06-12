import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, nowIso } from "../lib/core.js";
import { getSetting, getSecretSetting, setSetting } from "./settings.js";
import {
  cf,
  isCloudflareConnected,
  refreshLoginIngress,
  removeTunnelIngress,
  upsertTunnelIngress
} from "./cloudflare.js";

/**
 * SaaS tenant domains — Cloudflare for SaaS (custom hostnames).
 *
 * A hosted multi-tenant app (e.g. a blog platform) lets ITS end users connect
 * domains they own at arbitrary registrars. Those zones are not in the
 * operator's Cloudflare account, so the regular `tunnel route dns` bind cannot
 * serve them. Cloudflare for SaaS covers exactly this: the tenant CNAMEs their
 * hostname at a "fallback origin" inside the operator's zone, Cloudflare
 * validates ownership over HTTP and issues an edge certificate, and traffic
 * flows fallback origin → named tunnel → the service's local port.
 *
 * Status vocabulary intentionally matches the publisher app's domains table
 * (pending_dns | dns_verified | ssl_issuing | active | failed) so its edge
 * functions can store our responses without translation.
 */

export type SaasDomainRow = {
  id: string;
  service_id: string;
  hostname: string;
  status: string;
  ssl_status: string;
  mode: string;
  cf_custom_hostname_id: string | null;
  cname_target: string | null;
  target_port: number | null;
  verification_txt_name: string | null;
  verification_txt_value: string | null;
  failure_reason: string | null;
  last_checked_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

type CustomHostname = {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    method?: string;
    validation_errors?: Array<{ message?: string }>;
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
  verification_errors?: string[];
};

function httpError(message: string, statusCode: number, code?: string): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

/** The tunnel UUID currently in use — login tunnel preferred, token tunnel fallback. */
function resolveTunnelId(ctx: AppContext): string | null {
  return getSetting(ctx, "cloudflare_login_tunnel_id") ?? getSetting(ctx, "cloudflare_tunnel_id");
}

/** Zone name for the configured zone id, cached in settings after first lookup. */
async function resolveZoneName(ctx: AppContext): Promise<string> {
  const cached = getSetting(ctx, "cloudflare_zone_name");
  if (cached) return cached;
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId) throw httpError("cloudflare_zone_id is not configured", 422, "SAAS_NOT_CONFIGURED");
  const zone = await cf<{ name: string }>(ctx, `/zones/${zoneId}`);
  setSetting(ctx, "cloudflare_zone_name", zone.name.toLowerCase());
  return zone.name.toLowerCase();
}

export type SaasConfigStatus = {
  ready: boolean;
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

export function getSaasConfigStatus(ctx: AppContext): SaasConfigStatus {
  const apiTokenConfigured = Boolean(getSecretSetting(ctx, "cloudflare_api_token"));
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  const tunnelId = resolveTunnelId(ctx);
  const missing: string[] = [];
  if (!apiTokenConfigured) missing.push("cloudflare_api_token");
  if (!zoneId) missing.push("cloudflare_zone_id");
  if (!tunnelId) missing.push("cloudflare_tunnel");
  const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM saas_domains").get() as { n: number };
  return {
    ready: missing.length === 0,
    missing,
    apiTokenConfigured,
    zoneId,
    zoneName: getSetting(ctx, "cloudflare_zone_name"),
    tunnelId,
    tunnelConnected: isCloudflareConnected(ctx) || Boolean(getSetting(ctx, "cloudflare_tunnel_id")),
    fallbackOrigin: getSetting(ctx, "saas_fallback_origin"),
    fallbackServiceId: getSetting(ctx, "saas_fallback_service_id"),
    apiHostname: getSetting(ctx, "saas_api_hostname"),
    machineTokenConfigured: Boolean(getSecretSetting(ctx, "saas_api_token")),
    domainsCount: count.n
  };
}

type DnsRecord = { id: string; type: string; name: string; content: string; proxied: boolean };

/**
 * Upsert a PROXIED CNAME `name` → `<tunnelId>.cfargotunnel.com` in the
 * configured zone. Proxied is mandatory here: the fallback origin must
 * terminate at Cloudflare's edge for custom-hostname traffic to route.
 */
async function upsertProxiedTunnelCname(ctx: AppContext, name: string): Promise<void> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  const tunnelId = resolveTunnelId(ctx);
  if (!zoneId) throw httpError("cloudflare_zone_id is not configured", 422, "SAAS_NOT_CONFIGURED");
  if (!tunnelId) throw httpError("No Cloudflare tunnel is provisioned yet", 422, "SAAS_NOT_CONFIGURED");
  const target = `${tunnelId}.cfargotunnel.com`;
  const records = await cf<DnsRecord[]>(ctx, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const existing = records.find((r) => r.name === name);
  if (existing) {
    if (existing.type === "CNAME" && existing.content === target && existing.proxied) return;
    await cf(ctx, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ type: "CNAME", name, content: target, proxied: true })
    });
    return;
  }
  await cf(ctx, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "CNAME", name, content: target, proxied: true })
  });
}

/**
 * Make sure the zone's custom-hostname fallback origin exists and points at the
 * tunnel. Default host is `apps.<zone>`; the first service to register a tenant
 * domain becomes the fallback service (overridable via /saas/config).
 */
export async function ensureFallbackOrigin(ctx: AppContext, serviceId: string): Promise<string> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId) throw httpError("cloudflare_zone_id is not configured", 422, "SAAS_NOT_CONFIGURED");
  const zoneName = await resolveZoneName(ctx);
  let origin = getSetting(ctx, "saas_fallback_origin");
  if (!origin) {
    origin = `apps.${zoneName}`;
    setSetting(ctx, "saas_fallback_origin", origin);
  }
  if (!getSetting(ctx, "saas_fallback_service_id")) {
    setSetting(ctx, "saas_fallback_service_id", serviceId);
  }
  await upsertProxiedTunnelCname(ctx, origin);
  await cf(ctx, `/zones/${zoneId}/custom_hostnames/fallback_origin`, {
    method: "PUT",
    body: JSON.stringify({ origin })
  });
  return origin;
}

/**
 * Push the hostname → port rule to whichever tunnel is live. The login tunnel
 * rebuilds its whole config from collectIngressRoutes; the token tunnel takes
 * remote per-rule updates. Best-effort on the remote path — a transient API
 * error must not lose the locally-registered domain.
 */
async function applyIngress(ctx: AppContext, hostname: string, port: number | null): Promise<void> {
  if (isCloudflareConnected(ctx)) {
    refreshLoginIngress(ctx);
    return;
  }
  if (!getSetting(ctx, "cloudflare_tunnel_id") || !getSetting(ctx, "cloudflare_account_id")) return;
  try {
    if (port !== null) await upsertTunnelIngress(ctx, hostname, port);
    else await removeTunnelIngress(ctx, hostname);
  } catch {
    /* surfaced on next verify; the route is also reachable via the port proxy */
  }
}

function getDomainRow(ctx: AppContext, domainId: string): SaasDomainRow {
  const row = ctx.db.prepare("SELECT * FROM saas_domains WHERE id = ?").get(domainId) as
    | SaasDomainRow
    | undefined;
  if (!row) throw httpError("Domain not found", 404, "DOMAIN_NOT_FOUND");
  return row;
}

export function listSaasDomains(ctx: AppContext, serviceId: string): SaasDomainRow[] {
  return ctx.db
    .prepare("SELECT * FROM saas_domains WHERE service_id = ? ORDER BY created_at DESC")
    .all(serviceId) as SaasDomainRow[];
}

/**
 * Register a tenant hostname for a service. Inside the operator's own zone the
 * domain binds directly (proxied CNAME → tunnel, active immediately); anywhere
 * else it becomes a Cloudflare for SaaS custom hostname with HTTP validation,
 * so the tenant only has to add ONE CNAME record at their registrar.
 */
export async function registerSaasDomain(
  ctx: AppContext,
  serviceId: string,
  rawHostname: string,
  // Explicit local target port for this hostname (defaults to the service's
  // own port). Lets an own-zone hostname front a sidecar listener — e.g. the
  // local Supabase stack's API gateway — that isn't a ServerHoster service.
  explicitPort?: number
): Promise<{ domain: SaasDomainRow; dns_records: Array<Record<string, string>> }> {
  const hostname = normalizeHostname(rawHostname);
  // Wildcards are supported ONLY inside the operator's own zone (e.g.
  // `*.dinredaktion.dk` to serve every tenant's default subdomain). Cloudflare
  // for SaaS wildcard custom hostnames are an Enterprise feature, so tenant
  // domains stay exact-match.
  const isWildcard = hostname.startsWith("*.");
  const bareHostname = isWildcard ? hostname.slice(2) : hostname;
  if (!HOSTNAME_RE.test(bareHostname)) {
    throw httpError(`"${rawHostname}" is not a valid hostname (e.g. blog.example.com)`, 400, "BAD_HOSTNAME");
  }
  const service = ctx.db.prepare("SELECT id, name, port FROM services WHERE id = ?").get(serviceId) as
    | { id: string; name: string; port?: number }
    | undefined;
  if (!service) throw httpError("Service not found", 404, "SERVICE_NOT_FOUND");
  const targetPort = explicitPort ?? service.port;
  if (!targetPort) throw httpError("Service has no port assigned", 422, "NO_PORT");

  const existing = ctx.db.prepare("SELECT id, service_id FROM saas_domains WHERE hostname = ?").get(hostname) as
    | { id: string; service_id: string }
    | undefined;
  if (existing && existing.service_id !== serviceId) {
    throw httpError(`${hostname} is already registered to another service`, 409, "DOMAIN_IN_USE");
  }
  const proxyOwner = ctx.db.prepare("SELECT service_id FROM proxy_routes WHERE domain = ?").get(hostname) as
    | { service_id: string }
    | undefined;
  if (proxyOwner) {
    throw httpError(`${hostname} is already bound as an operator domain (Edge Ingress)`, 409, "DOMAIN_IN_USE");
  }

  const zoneName = await resolveZoneName(ctx);
  const inOwnZone = bareHostname === zoneName || bareHostname.endsWith(`.${zoneName}`);
  if (isWildcard && !inOwnZone) {
    throw httpError(
      `Wildcard hostnames are only supported inside your own Cloudflare zone (${zoneName}). Tenant domains must be exact hostnames.`,
      422,
      "WILDCARD_OUT_OF_ZONE"
    );
  }
  const now = nowIso();

  if (inOwnZone) {
    // Same-zone hostnames don't need (and Cloudflare rejects) custom hostnames —
    // bind directly: proxied CNAME → tunnel, served by Universal SSL.
    await upsertProxiedTunnelCname(ctx, hostname);
    const row: SaasDomainRow = {
      id: existing?.id ?? nanoid(),
      service_id: serviceId,
      hostname,
      status: "active",
      ssl_status: "active",
      mode: "own_zone",
      cf_custom_hostname_id: null,
      cname_target: null,
      target_port: explicitPort ?? null,
      verification_txt_name: null,
      verification_txt_value: null,
      failure_reason: null,
      last_checked_at: now,
      verified_at: now,
      created_at: now,
      updated_at: now
    };
    upsertDomainRow(ctx, row, Boolean(existing));
    await applyIngress(ctx, hostname, targetPort);
    broadcast(ctx, { type: "saas_domains_changed", serviceId });
    return { domain: getDomainRow(ctx, row.id), dns_records: [] };
  }

  const fallbackOrigin = await ensureFallbackOrigin(ctx, serviceId);
  const zoneId = getSetting(ctx, "cloudflare_zone_id");

  let ch: CustomHostname;
  try {
    ch = await cf<CustomHostname>(ctx, `/zones/${zoneId}/custom_hostnames`, {
      method: "POST",
      body: JSON.stringify({
        hostname,
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } }
      })
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Re-registering an existing custom hostname is fine — reuse it.
    if (/duplicate|already exists/i.test(msg)) {
      const list = await cf<CustomHostname[]>(
        ctx,
        `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`
      );
      const found = list.find((c) => c.hostname === hostname);
      if (!found) throw error;
      ch = found;
    } else {
      throw error;
    }
  }

  const row: SaasDomainRow = {
    id: existing?.id ?? nanoid(),
    service_id: serviceId,
    hostname,
    status: "pending_dns",
    ssl_status: "issuing",
    mode: "custom_hostname",
    cf_custom_hostname_id: ch.id,
    cname_target: fallbackOrigin,
    target_port: explicitPort ?? null,
    verification_txt_name: ch.ownership_verification?.name ?? null,
    verification_txt_value: ch.ownership_verification?.value ?? null,
    failure_reason: null,
    last_checked_at: now,
    verified_at: null,
    created_at: now,
    updated_at: now
  };
  upsertDomainRow(ctx, row, Boolean(existing));
  await applyIngress(ctx, hostname, targetPort);
  broadcast(ctx, { type: "saas_domains_changed", serviceId });

  const dnsRecords: Array<Record<string, string>> = [
    { type: "CNAME", name: hostname, value: fallbackOrigin, purpose: "routing" }
  ];
  if (row.verification_txt_name && row.verification_txt_value) {
    dnsRecords.push({
      type: "TXT",
      name: row.verification_txt_name,
      value: row.verification_txt_value,
      purpose: "ownership_prevalidation_optional"
    });
  }
  return { domain: getDomainRow(ctx, row.id), dns_records: dnsRecords };
}

function upsertDomainRow(ctx: AppContext, row: SaasDomainRow, exists: boolean): void {
  if (exists) {
    ctx.db
      .prepare(
        `UPDATE saas_domains SET service_id = ?, status = ?, ssl_status = ?, mode = ?,
         cf_custom_hostname_id = ?, cname_target = ?, target_port = ?, verification_txt_name = ?, verification_txt_value = ?,
         failure_reason = ?, last_checked_at = ?, verified_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        row.service_id,
        row.status,
        row.ssl_status,
        row.mode,
        row.cf_custom_hostname_id,
        row.cname_target,
        row.target_port,
        row.verification_txt_name,
        row.verification_txt_value,
        row.failure_reason,
        row.last_checked_at,
        row.verified_at,
        row.updated_at,
        row.id
      );
    return;
  }
  ctx.db
    .prepare(
      `INSERT INTO saas_domains (
        id, service_id, hostname, status, ssl_status, mode, cf_custom_hostname_id, cname_target, target_port,
        verification_txt_name, verification_txt_value, failure_reason, last_checked_at, verified_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.service_id,
      row.hostname,
      row.status,
      row.ssl_status,
      row.mode,
      row.cf_custom_hostname_id,
      row.cname_target,
      row.target_port,
      row.verification_txt_name,
      row.verification_txt_value,
      row.failure_reason,
      row.last_checked_at,
      row.verified_at,
      row.created_at,
      row.updated_at
    );
}

type DohAnswer = { name: string; type: number; data: string };

/** DNS-over-HTTPS lookup so verify can distinguish "no CNAME yet" from "Cloudflare still validating". */
async function dohHasPointingRecord(hostname: string): Promise<boolean> {
  for (const type of ["CNAME", "A"]) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { Accept: "application/dns-json" } }
      );
      if (!res.ok) continue;
      const json = (await res.json()) as { Answer?: DohAnswer[] };
      if ((json.Answer ?? []).length > 0) return true;
    } catch {
      /* DoH unavailable — fall through to Cloudflare status only */
    }
  }
  return false;
}

const SSL_PENDING = new Set(["initializing", "pending_validation", "pending_issuance", "pending_deployment"]);

/**
 * Poll Cloudflare for the hostname's validation/certificate state and update
 * the local row. Returns the publisher-compatible status + a human message.
 */
export async function verifySaasDomain(
  ctx: AppContext,
  domainId: string
): Promise<{ status: string; message: string; domain: SaasDomainRow }> {
  const row = getDomainRow(ctx, domainId);
  const now = nowIso();

  const finish = (
    status: string,
    sslStatus: string,
    message: string,
    failureReason: string | null
  ): { status: string; message: string; domain: SaasDomainRow } => {
    ctx.db
      .prepare(
        `UPDATE saas_domains SET status = ?, ssl_status = ?, failure_reason = ?, last_checked_at = ?,
         verified_at = COALESCE(verified_at, CASE WHEN ? = 'active' THEN ? ELSE NULL END), updated_at = ?
         WHERE id = ?`
      )
      .run(status, sslStatus, failureReason, now, status, now, now, domainId);
    return { status, message, domain: getDomainRow(ctx, domainId) };
  };

  if (row.mode === "own_zone") {
    return finish("active", "active", `${row.hostname} is served from your own Cloudflare zone.`, null);
  }

  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId || !row.cf_custom_hostname_id) {
    return finish("failed", "failed", "Cloudflare custom hostname reference is missing — remove and re-add the domain.", "missing cf_custom_hostname_id");
  }

  const pointing = await dohHasPointingRecord(row.hostname);
  const ch = await cf<CustomHostname>(ctx, `/zones/${zoneId}/custom_hostnames/${row.cf_custom_hostname_id}`);
  const chStatus = (ch.status ?? "").toLowerCase();
  const sslStatus = (ch.ssl?.status ?? "").toLowerCase();

  // Persist ownership TXT details if Cloudflare (re)issued them.
  if (ch.ownership_verification?.value && ch.ownership_verification.value !== row.verification_txt_value) {
    ctx.db
      .prepare("UPDATE saas_domains SET verification_txt_name = ?, verification_txt_value = ?, updated_at = ? WHERE id = ?")
      .run(ch.ownership_verification.name ?? null, ch.ownership_verification.value, now, domainId);
  }

  if (chStatus === "active" && sslStatus === "active") {
    return finish("active", "active", `🎉 ${row.hostname} is verified and active — SSL is live.`, null);
  }

  if (!pointing) {
    return finish(
      "pending_dns",
      "none",
      `No DNS record found for ${row.hostname} yet. Add a CNAME pointing to ${row.cname_target ?? "the provided target"} and try again (propagation can take a while).`,
      `No A/CNAME record detected for ${row.hostname}`
    );
  }

  const sslErrors = (ch.ssl?.validation_errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
  if (sslStatus && !SSL_PENDING.has(sslStatus) && sslStatus !== "active") {
    return finish(
      "failed",
      "failed",
      `Certificate validation failed for ${row.hostname}: ${sslErrors || sslStatus}. Fix the DNS record and verify again.`,
      sslErrors || sslStatus
    );
  }

  if (chStatus === "active") {
    return finish(
      "ssl_issuing",
      "issuing",
      `DNS looks good for ${row.hostname}. The SSL certificate is being issued — check again in a minute.`,
      null
    );
  }

  return finish(
    "dns_verified",
    "issuing",
    `DNS record found for ${row.hostname}. Cloudflare is validating the hostname — check again shortly.`,
    null
  );
}

/** Remove a tenant domain: best-effort Cloudflare cleanup, then local rows + ingress refresh. */
export async function deleteSaasDomain(ctx: AppContext, domainId: string): Promise<{ ok: true }> {
  const row = getDomainRow(ctx, domainId);
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (row.mode === "custom_hostname" && row.cf_custom_hostname_id && zoneId) {
    try {
      await cf(ctx, `/zones/${zoneId}/custom_hostnames/${row.cf_custom_hostname_id}`, { method: "DELETE" });
    } catch {
      /* best effort — the local removal must still proceed */
    }
  }
  if (row.mode === "own_zone" && zoneId) {
    try {
      const records = await cf<DnsRecord[]>(
        ctx,
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(row.hostname)}`
      );
      for (const record of records.filter((r) => r.name === row.hostname && r.type === "CNAME")) {
        await cf(ctx, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
      }
    } catch {
      /* best effort */
    }
  }
  ctx.db.prepare("DELETE FROM saas_domains WHERE id = ?").run(domainId);
  await applyIngress(ctx, row.hostname, null);
  broadcast(ctx, { type: "saas_domains_changed", serviceId: row.service_id });
  return { ok: true };
}

/**
 * Expose the control-plane API itself on a public hostname in the operator's
 * zone, so external machine callers (the hosted app's edge functions) can reach
 * /saas. The hostname gets a proxied CNAME → tunnel and an ingress rule to the
 * API port.
 */
export async function exposeApiHostname(ctx: AppContext, rawHostname: string): Promise<{ apiHostname: string }> {
  const hostname = normalizeHostname(rawHostname);
  if (!HOSTNAME_RE.test(hostname)) {
    throw httpError(`"${rawHostname}" is not a valid hostname`, 400, "BAD_HOSTNAME");
  }
  const zoneName = await resolveZoneName(ctx);
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
    throw httpError(
      `The API hostname must live inside your Cloudflare zone (${zoneName}), e.g. hoster-api.${zoneName}`,
      422,
      "OUT_OF_ZONE"
    );
  }
  await upsertProxiedTunnelCname(ctx, hostname);
  setSetting(ctx, "saas_api_hostname", hostname);
  await applyIngress(ctx, hostname, ctx.config.apiPort);
  broadcast(ctx, { type: "exposure_changed" });
  return { apiHostname: hostname };
}
