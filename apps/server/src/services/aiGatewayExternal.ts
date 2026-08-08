/**
 * External-gateway management.
 *
 * The ServerHoster tab can manage a *standalone* SubGate container instead of
 * running its own in-process gateway. That is the right model when the gateway
 * has to be reachable by other containers (e.g. a Dockerised consumer like
 * MyMetaView): the in-process server binds loopback per §7 and a container
 * can't reach host loopback, whereas the standalone container publishes on the
 * Docker bridge.
 *
 * When an external target is configured, `routes/aiGateway.ts` proxies the
 * tab's calls to the container's `/admin` API and adapts the responses into the
 * shapes the existing UI already expects. The container owns the provider key
 * (in its own root-only env file) and the token/usage stores; this module only
 * holds the URL and the admin token needed to talk to it.
 */

import { decryptSecret, encryptSecret } from "../security.js";
import { writeAuditLog } from "./audit.js";
import { GatewayError } from "../subgate/errors.js";
import { forgetSecret, redact, registerSecret } from "../subgate/redact.js";
import { listModels } from "../subgate/models.js";
import type { AppContext } from "../types.js";

const URL_KEY = "ai_gateway_external_url";
const ADMIN_KEY = "ai_gateway_external_admin"; // stored encrypted

export type ExternalTarget = { url: string; adminToken: string };

function readSetting(ctx: AppContext, key: string): string | null {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

/** The configured external gateway, or null when the tab runs in-process. */
export function getExternalTarget(ctx: AppContext): ExternalTarget | null {
  const url = readSetting(ctx, URL_KEY);
  const enc = readSetting(ctx, ADMIN_KEY);
  if (!url || !enc) return null;
  const adminToken = decryptSecret(enc, ctx.config.secretKey);
  if (!adminToken) return null;
  return { url: url.replace(/\/+$/, ""), adminToken };
}

export function isExternalMode(ctx: AppContext): boolean {
  return getExternalTarget(ctx) !== null;
}

export function setExternalTarget(
  ctx: AppContext,
  url: string,
  adminToken: string,
  actor = "system"
): void {
  const cleanUrl = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(cleanUrl)) {
    throw new GatewayError("invalid_request", "External gateway URL must start with http:// or https://.");
  }
  if (!adminToken.trim()) {
    throw new GatewayError("invalid_request", "Admin token is required.");
  }
  // Register the admin token with the redactor before it can hit a log line.
  registerSecret(adminToken.trim());
  ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(URL_KEY, cleanUrl);
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(ADMIN_KEY, encryptSecret(adminToken.trim(), ctx.config.secretKey));
  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.external.set",
    resourceType: "ai-gateway",
    resourceId: "external",
    targetType: "external-gateway",
    statusCode: 200,
    details: `url=${cleanUrl}`
  });
}

export function clearExternalTarget(ctx: AppContext, actor = "system"): void {
  const existing = getExternalTarget(ctx);
  if (existing) forgetSecret(existing.adminToken);
  ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(URL_KEY);
  ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(ADMIN_KEY);
  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.external.clear",
    resourceType: "ai-gateway",
    resourceId: "external",
    targetType: "external-gateway",
    statusCode: 200
  });
}

/** Re-register the stored admin token with the redactor at boot. */
export function primeExternalRedaction(ctx: AppContext): void {
  const target = getExternalTarget(ctx);
  if (target) registerSecret(target.adminToken);
}

/**
 * Call the container's /admin API. The admin token authenticates; errors are
 * mapped to GatewayError so the route layer surfaces a real status, and the
 * body is redacted so a proxied error can never carry the token back.
 */
async function adminFetch<T>(
  ctx: AppContext,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const target = getExternalTarget(ctx);
  if (!target) throw new GatewayError("no_provider_configured", "No external gateway is configured.");

  let res: Response;
  try {
    res = await fetch(`${target.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${target.adminToken}`,
        "content-type": "application/json"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    throw new GatewayError(
      "upstream_unavailable",
      `Could not reach the external gateway at ${target.url}: ${redact(err)}`
    );
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 401) {
      throw new GatewayError(
        "authentication_error",
        "The external gateway rejected the admin token. Re-enter it in the tab."
      );
    }
    throw new GatewayError("upstream_error", `External gateway returned ${res.status}: ${redact(text)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError("upstream_error", "External gateway returned a non-JSON response.");
  }
}

/* ------------------------------------------------------------------------ */
/* Shape adapters — container /admin -> the shapes the existing UI expects   */
/* ------------------------------------------------------------------------ */

type ContainerStatus = {
  providers: string[];
  in_flight: number;
  rate_limit_per_minute: number;
  max_concurrent: number;
  bound: { host: string; port: number };
  token_count: number;
};

export async function externalStatus(ctx: AppContext): Promise<Record<string, unknown>> {
  const target = getExternalTarget(ctx)!;
  const status = await adminFetch<ContainerStatus>(ctx, "/admin/status");
  return {
    enabled: true,
    running: true,
    external: true,
    external_url: target.url,
    bound: status.bound,
    // The public URL is whatever the operator points consumers at; the tab
    // can't know it for an external container, so leave it blank.
    public_url: "",
    openai_base_url: null,
    anthropic_base_url: null,
    rate_limit_per_minute: status.rate_limit_per_minute,
    max_concurrent: status.max_concurrent,
    in_flight: status.in_flight,
    debug_bodies_until: null,
    // Keys live in the container env, so no preview/fingerprint is available.
    providers: status.providers.map((id) => ({
      id,
      configured: true,
      keyPreview: null,
      fingerprint: null,
      baseUrl: null
    })),
    available_providers: status.providers,
    token_count: status.token_count
  };
}

export async function externalProviders(ctx: AppContext): Promise<Record<string, unknown>> {
  const status = await adminFetch<ContainerStatus>(ctx, "/admin/status");
  return {
    providers: status.providers.map((id) => ({
      id,
      configured: true,
      keyPreview: null,
      fingerprint: null,
      baseUrl: null
    })),
    available: status.providers,
    // The model catalogue is static in the core, so it's safe to list locally.
    models: listModels().map((m) => ({
      id: m.id,
      provider: m.provider,
      display_name: m.displayName,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens
    }))
  };
}

export function externalTokens(ctx: AppContext): Promise<{ tokens: unknown[] }> {
  return adminFetch(ctx, "/admin/tokens");
}

export function externalMintToken(ctx: AppContext, name: string): Promise<Record<string, unknown>> {
  return adminFetch(ctx, "/admin/tokens", { method: "POST", body: { name } });
}

export function externalRevokeToken(ctx: AppContext, id: string): Promise<Record<string, unknown>> {
  return adminFetch(ctx, `/admin/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function externalUsage(ctx: AppContext, hours: number): Promise<Record<string, unknown>> {
  const raw = await adminFetch<{ totals: Record<string, number>; recent: unknown[] }>(
    ctx,
    `/admin/usage?hours=${hours}`
  );
  // The container reports totals + recent; the UI also renders by_consumer /
  // by_model but tolerates empty arrays, so fill them rather than 500.
  return { totals: raw.totals, by_consumer: [], by_model: [], recent: raw.recent };
}

export function externalTest(ctx: AppContext): Promise<Record<string, unknown>> {
  return adminFetch(ctx, "/admin/test", { method: "POST", body: {} });
}
