/**
 * AI Gateway (SubGate) — state, credentials, consumer tokens, and metering.
 *
 * This is the ServerHoster-shaped half. Everything protocol-related lives in
 * `../subgate/`, which imports nothing from this app; the split is what makes
 * the standalone repo (§5) an extraction rather than a second implementation.
 *
 * Credential handling follows §7:
 *   - Provider API keys are stored through `encryptSecret` and are decrypted
 *     only inside `credentialsFor()`, at call time.
 *   - They are registered with the core's redactor at load, so any path that
 *     stringifies one — a log, an error body, a crash report — masks it.
 *   - Consumer tokens are stored as SHA-256 hashes and returned exactly once.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { nowIso } from "../lib/core.js";
import { decryptSecret, encryptSecret } from "../security.js";
import { writeAuditLog } from "./audit.js";
import type { AppContext } from "../types.js";
import { GatewayError } from "../subgate/errors.js";
import { registerSecret, forgetSecret, maskCredential } from "../subgate/redact.js";
import { availableProviders, type GatewayDeps } from "../subgate/gateway.js";
import type { ProviderCredentials, ProviderId } from "../subgate/types.js";

const PROVIDERS: ProviderId[] = ["anthropic", "openai"];

const SETTINGS_CONFIG_KEY = "ai_gateway_config";
const settingsKeyFor = (provider: ProviderId): string => `ai_gateway_key_${provider}`;
const settingsBaseUrlFor = (provider: ProviderId): string => `ai_gateway_base_url_${provider}`;

/** Token prefix. Distinctive so a leaked value is greppable in logs and repos. */
const TOKEN_PREFIX = "sgk_";

export type AiGatewayConfig = {
  enabled: boolean;
  /** Loopback port for the inference server. Never bound to 0.0.0.0 (§7). */
  port: number;
  /** Public https URL the reverse proxy maps to this gateway. Display only. */
  publicUrl: string;
  /** Requests per minute per consumer token. */
  rateLimitPerMinute: number;
  /** Global in-flight cap across all consumers — one account, five apps (§7). */
  maxConcurrent: number;
  /**
   * Opt-in, time-boxed request-body logging for debugging (§7). Stores an ISO
   * timestamp; body logging is active only while it is in the future.
   */
  debugBodiesUntil: string | null;
};

export const DEFAULT_CONFIG: AiGatewayConfig = {
  enabled: false,
  port: 8788,
  publicUrl: "",
  rateLimitPerMinute: 120,
  maxConcurrent: 8,
  debugBodiesUntil: null
};

/* ------------------------------------------------------------------------ */
/* Config                                                                     */
/* ------------------------------------------------------------------------ */

export function getGatewayConfig(ctx: AppContext): AiGatewayConfig {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_CONFIG_KEY) as
    | { value?: string }
    | undefined;
  if (!row?.value) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(row.value) as Partial<AiGatewayConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // A corrupted blob should not take the dashboard down with it.
    return { ...DEFAULT_CONFIG };
  }
}

export function setGatewayConfig(
  ctx: AppContext,
  patch: Partial<AiGatewayConfig>,
  actor = "system"
): AiGatewayConfig {
  const next = { ...getGatewayConfig(ctx), ...patch };
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(SETTINGS_CONFIG_KEY, JSON.stringify(next));
  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.config.update",
    resourceType: "ai-gateway",
    resourceId: "config",
    targetType: "ai-gateway-config",
    statusCode: 200,
    // Config values are not secret; the keys live in their own settings rows.
    details: `keys=${Object.keys(patch).join(",")}`
  });
  return next;
}

/* ------------------------------------------------------------------------ */
/* Provider credentials                                                       */
/* ------------------------------------------------------------------------ */

export function setProviderKey(
  ctx: AppContext,
  provider: ProviderId,
  apiKey: string,
  actor = "system"
): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new GatewayError("invalid_request", "API key must not be empty.");

  // Drop the previous value from the redactor so a rotated-out key does not
  // keep masking unrelated text forever.
  const previous = readProviderKey(ctx, provider);
  if (previous) forgetSecret(previous);

  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(settingsKeyFor(provider), encryptSecret(trimmed, ctx.config.secretKey));
  registerSecret(trimmed);

  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.provider-key.set",
    resourceType: "ai-gateway",
    resourceId: provider,
    targetType: "provider-credential",
    targetId: provider,
    statusCode: 200,
    details: `fingerprint=${keyFingerprint(trimmed)}`
  });
}

export function clearProviderKey(ctx: AppContext, provider: ProviderId, actor = "system"): void {
  const previous = readProviderKey(ctx, provider);
  if (previous) forgetSecret(previous);
  ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(settingsKeyFor(provider));
  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.provider-key.clear",
    resourceType: "ai-gateway",
    resourceId: provider,
    targetType: "provider-credential",
    targetId: provider,
    statusCode: 200
  });
}

export function setProviderBaseUrl(ctx: AppContext, provider: ProviderId, baseUrl: string): void {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(settingsBaseUrlFor(provider));
    return;
  }
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(settingsBaseUrlFor(provider), trimmed);
}

/**
 * Read and decrypt a provider key. Private on purpose — nothing outside this
 * module should hold a plaintext key, and `credentialsFor()` is the only
 * consumer.
 */
function readProviderKey(ctx: AppContext, provider: ProviderId): string | null {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(settingsKeyFor(provider)) as
    | { value?: string }
    | undefined;
  if (!row?.value) return null;
  const decrypted = decryptSecret(row.value, ctx.config.secretKey);
  return decrypted || null;
}

function readProviderBaseUrl(ctx: AppContext, provider: ProviderId): string | undefined {
  const row = ctx.db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(settingsBaseUrlFor(provider)) as { value?: string } | undefined;
  return row?.value || undefined;
}

/**
 * Re-register every stored key with the redactor. Called at boot so masking is
 * active before the first request, not after the first key read.
 */
export function primeCredentialRedaction(ctx: AppContext): void {
  for (const provider of PROVIDERS) {
    const key = readProviderKey(ctx, provider);
    if (key) registerSecret(key);
  }
}

/** The core's credential seam. The only place a plaintext key is handed out. */
export function gatewayDeps(ctx: AppContext): GatewayDeps {
  return {
    credentialsFor(provider: ProviderId): ProviderCredentials | null {
      const apiKey = readProviderKey(ctx, provider);
      if (!apiKey) return null;
      return { provider, apiKey, baseUrl: readProviderBaseUrl(ctx, provider) };
    }
  };
}

export type ProviderStatus = {
  id: ProviderId;
  configured: boolean;
  /** Masked for display. Never the real value. */
  keyPreview: string | null;
  fingerprint: string | null;
  baseUrl: string | null;
};

export function providerStatuses(ctx: AppContext): ProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const key = readProviderKey(ctx, provider);
    return {
      id: provider,
      configured: Boolean(key),
      keyPreview: key ? maskCredential(key) : null,
      fingerprint: key ? keyFingerprint(key) : null,
      baseUrl: readProviderBaseUrl(ctx, provider) ?? null
    };
  });
}

export function listAvailableProviders(ctx: AppContext): ProviderId[] {
  return availableProviders(gatewayDeps(ctx));
}

/**
 * A short, stable, non-reversible identifier for a key. Lets the operator
 * confirm "the key on the VPS is the one I pasted" without either side ever
 * displaying the key.
 */
function keyFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------------ */
/* Consumer tokens                                                            */
/* ------------------------------------------------------------------------ */

export type ConsumerTokenRow = {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  request_count: number;
};

export type ConsumerTokenView = {
  id: string;
  name: string;
  preview: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  request_count: number;
  active: boolean;
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a consumer token. The plaintext is returned once and never persisted —
 * the caller shows it to the operator and forgets it.
 */
export function mintConsumerToken(
  ctx: AppContext,
  name: string,
  actor = "system"
): { token: string; record: ConsumerTokenView } {
  const label = name.trim() || "unnamed";
  // 32 bytes of CSPRNG output, base64url — 256 bits, URL-safe, no padding.
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const id = nanoid();
  const createdAt = nowIso();

  ctx.db
    .prepare(
      `INSERT INTO ai_gateway_tokens (id, name, token_hash, token_prefix, created_at, request_count)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(id, label, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), createdAt);

  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.token.mint",
    resourceType: "ai-gateway",
    resourceId: id,
    targetType: "consumer-token",
    targetId: id,
    statusCode: 201,
    details: `name=${label}`
  });

  const row = ctx.db.prepare("SELECT * FROM ai_gateway_tokens WHERE id = ?").get(id) as ConsumerTokenRow;
  return { token, record: toTokenView(row) };
}

export function listConsumerTokens(ctx: AppContext): ConsumerTokenView[] {
  const rows = ctx.db
    .prepare("SELECT * FROM ai_gateway_tokens ORDER BY created_at DESC")
    .all() as ConsumerTokenRow[];
  return rows.map(toTokenView);
}

export function revokeConsumerToken(ctx: AppContext, id: string, actor = "system"): ConsumerTokenView {
  const row = ctx.db.prepare("SELECT * FROM ai_gateway_tokens WHERE id = ?").get(id) as
    | ConsumerTokenRow
    | undefined;
  if (!row) {
    const err = new Error("Token not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  if (!row.revoked_at) {
    ctx.db.prepare("UPDATE ai_gateway_tokens SET revoked_at = ? WHERE id = ?").run(nowIso(), id);
  }
  // Drop any cached rate-limit state so a re-minted name starts clean.
  rateLimitBuckets.delete(id);

  writeAuditLog(ctx, {
    actor,
    action: "ai-gateway.token.revoke",
    resourceType: "ai-gateway",
    resourceId: id,
    targetType: "consumer-token",
    targetId: id,
    statusCode: 200,
    details: `name=${row.name}`
  });

  const updated = ctx.db.prepare("SELECT * FROM ai_gateway_tokens WHERE id = ?").get(id) as ConsumerTokenRow;
  return toTokenView(updated);
}

/**
 * Authenticate a presented bearer token.
 *
 * Lookup is by hash, so a timing side-channel would leak at most whether a
 * hash exists — the token itself is never compared byte-by-byte against a
 * stored plaintext, because no plaintext is stored.
 */
export function authenticateConsumerToken(ctx: AppContext, presented: string): ConsumerTokenRow | null {
  const token = presented.trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = ctx.db
    .prepare("SELECT * FROM ai_gateway_tokens WHERE token_hash = ?")
    .get(hashToken(token)) as ConsumerTokenRow | undefined;
  if (!row || row.revoked_at) return null;
  return row;
}

/** Record that a token was used. Batched to one UPDATE per request. */
export function touchConsumerToken(ctx: AppContext, id: string): void {
  ctx.db
    .prepare("UPDATE ai_gateway_tokens SET last_used_at = ?, request_count = request_count + 1 WHERE id = ?")
    .run(nowIso(), id);
}

function toTokenView(row: ConsumerTokenRow): ConsumerTokenView {
  return {
    id: row.id,
    name: row.name,
    // The stored prefix plus an elision — enough for the operator to tell two
    // tokens apart, not enough to reconstruct one.
    preview: `${row.token_prefix}…`,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    request_count: row.request_count,
    active: !row.revoked_at
  };
}

/* ------------------------------------------------------------------------ */
/* Rate limiting + concurrency                                                */
/* ------------------------------------------------------------------------ */

type Bucket = { tokens: number; lastRefill: number };
const rateLimitBuckets = new Map<string, Bucket>();

/**
 * Token-bucket per consumer. Returns null when allowed, or the seconds to wait
 * when throttled — the caller turns that into a 429 with `Retry-After` (§7:
 * never surface throttling as a 500).
 */
export function checkRateLimit(tokenId: string, perMinute: number): number | null {
  if (perMinute <= 0) return null;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(tokenId) ?? { tokens: perMinute, lastRefill: now };
  const elapsedMinutes = (now - bucket.lastRefill) / 60000;
  bucket.tokens = Math.min(perMinute, bucket.tokens + elapsedMinutes * perMinute);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    rateLimitBuckets.set(tokenId, bucket);
    // Seconds until one whole token is available again.
    const secondsPerToken = 60 / perMinute;
    return Math.max(1, Math.ceil((1 - bucket.tokens) * secondsPerToken));
  }

  bucket.tokens -= 1;
  rateLimitBuckets.set(tokenId, bucket);
  return null;
}

/** Test seam — resets throttling state between cases. */
export function resetRateLimits(): void {
  rateLimitBuckets.clear();
}

let inFlight = 0;

export function tryAcquireSlot(max: number): boolean {
  if (max > 0 && inFlight >= max) return false;
  inFlight += 1;
  return true;
}

export function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function currentInFlight(): number {
  return inFlight;
}

/* ------------------------------------------------------------------------ */
/* Usage metering                                                             */
/* ------------------------------------------------------------------------ */

export type UsageRecord = {
  tokenId: string | null;
  tokenName: string | null;
  provider: string;
  model: string;
  wire: "openai" | "anthropic";
  streamed: boolean;
  promptTokens: number;
  completionTokens: number;
  statusCode: number;
  errorCode?: string | null;
  durationMs: number;
};

export function recordUsage(ctx: AppContext, record: UsageRecord): void {
  ctx.db
    .prepare(
      `INSERT INTO ai_gateway_usage
       (id, token_id, token_name, provider, model, wire, streamed, prompt_tokens, completion_tokens,
        status_code, error_code, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(),
      record.tokenId,
      record.tokenName,
      record.provider,
      record.model,
      record.wire,
      record.streamed ? 1 : 0,
      record.promptTokens,
      record.completionTokens,
      record.statusCode,
      record.errorCode ?? null,
      record.durationMs,
      nowIso()
    );
}

export type UsageSummary = {
  totals: {
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
  by_consumer: Array<{
    token_id: string | null;
    token_name: string | null;
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    last_used_at: string | null;
  }>;
  by_model: Array<{ model: string; provider: string; requests: number; total_tokens: number }>;
  recent: Array<{
    id: string;
    token_name: string | null;
    provider: string;
    model: string;
    wire: string;
    streamed: boolean;
    status_code: number;
    error_code: string | null;
    duration_ms: number;
    total_tokens: number;
    created_at: string;
  }>;
};

/** Usage over a trailing window. `sinceHours` defaults to 24. */
export function getUsageSummary(ctx: AppContext, sinceHours = 24): UsageSummary {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const totals = ctx.db
    .prepare(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM ai_gateway_usage WHERE created_at >= ?`
    )
    .get(since) as { requests: number; errors: number | null; prompt_tokens: number; completion_tokens: number };

  const byConsumer = ctx.db
    .prepare(
      `SELECT u.token_id, u.token_name,
              COUNT(*) AS requests,
              SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
              MAX(u.created_at) AS last_used_at
       FROM ai_gateway_usage u
       WHERE u.created_at >= ?
       GROUP BY u.token_id, u.token_name
       ORDER BY requests DESC`
    )
    .all(since) as UsageSummary["by_consumer"];

  const byModel = ctx.db
    .prepare(
      `SELECT model, provider, COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens
       FROM ai_gateway_usage WHERE created_at >= ?
       GROUP BY model, provider ORDER BY requests DESC`
    )
    .all(since) as UsageSummary["by_model"];

  const recent = ctx.db
    .prepare(
      `SELECT id, token_name, provider, model, wire, streamed, status_code, error_code,
              duration_ms, (prompt_tokens + completion_tokens) AS total_tokens, created_at
       FROM ai_gateway_usage ORDER BY created_at DESC LIMIT 50`
    )
    .all() as Array<Omit<UsageSummary["recent"][number], "streamed"> & { streamed: number }>;

  return {
    totals: {
      requests: totals.requests ?? 0,
      errors: totals.errors ?? 0,
      prompt_tokens: totals.prompt_tokens ?? 0,
      completion_tokens: totals.completion_tokens ?? 0
    },
    by_consumer: byConsumer,
    by_model: byModel,
    recent: recent.map((row) => ({ ...row, streamed: Boolean(row.streamed) }))
  };
}

/** True while opt-in body logging is inside its time box (§7). */
export function bodyLoggingActive(config: AiGatewayConfig): boolean {
  if (!config.debugBodiesUntil) return false;
  const until = Date.parse(config.debugBodiesUntil);
  return Number.isFinite(until) && until > Date.now();
}
