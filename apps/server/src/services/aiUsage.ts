/**
 * AI API usage reported by hosted apps.
 *
 * Apps post one event per model call (tokens, model, status, latency) to
 * POST /api/ai-usage/report with a per-service token that ServerHoster injects
 * as SURVHUB_AI_USAGE_TOKEN. Cost is computed here from a price table
 * (overridable in Settings) so the number is the same for every app; a model
 * with no known price is recorded as 'unpriced' (cost NULL) instead of being
 * counted as free.
 *
 * Only metadata is stored. Prompts and completions never reach this module.
 *
 * Token semantics follow Anthropic: input_tokens EXCLUDES cache reads/writes,
 * which are reported separately.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { encryptSecret } from "../security.js";
import { getSetting, setSetting } from "./settings.js";
import { createNotification } from "./notifications.js";

// ---------------------------------------------------------------------------
// Prices (USD per million tokens == micro-USD per token)
// ---------------------------------------------------------------------------

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * Anthropic list prices as published in the Claude API reference (checked
 * 2026-09). Cache writes are ASSUMED to be 1.25x input (5-minute cache) and
 * cache reads 10% of input unless the published figure differs; override any
 * entry in Settings. OpenAI models are intentionally absent: no price here is
 * better than an unverified one, and they show as "unpriced" until set.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
};

const PRICE_SETTING = "ai_usage_prices";
const BUDGET_SETTING = "ai_usage_budgets";
const ALERT_STATE_SETTING = "ai_usage_alert_state";

function readJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function validPrice(p: unknown): p is Price {
  if (!p || typeof p !== "object") return false;
  const v = p as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (k) => typeof v[k] === "number" && Number.isFinite(v[k] as number) && (v[k] as number) >= 0 && (v[k] as number) < 10000
  );
}

export function getPriceOverrides(ctx: AppContext): Record<string, Price> {
  const raw = readJson<Record<string, unknown>>(getSetting(ctx, PRICE_SETTING), {});
  const out: Record<string, Price> = {};
  for (const [model, price] of Object.entries(raw)) if (validPrice(price)) out[model] = price;
  return out;
}

export function setPriceOverrides(ctx: AppContext, overrides: Record<string, Price>): void {
  const clean: Record<string, Price> = {};
  for (const [model, price] of Object.entries(overrides)) {
    if (!model || model.length > 120) throw badRequest("Model name is empty or too long");
    if (!validPrice(price)) throw badRequest(`Invalid price for ${model}`);
    clean[model] = price;
  }
  setSetting(ctx, PRICE_SETTING, JSON.stringify(clean));
}

/** Exact match, then the model id with a trailing date or @version removed. */
export function priceFor(ctx: AppContext, model: string): { price: Price; custom: boolean } | null {
  const overrides = getPriceOverrides(ctx);
  const candidates = [model, model.replace(/[@-]\d{8}$/, "")];
  for (const c of candidates) {
    if (overrides[c]) return { price: overrides[c], custom: true };
    if (DEFAULT_PRICES[c]) return { price: DEFAULT_PRICES[c], custom: false };
  }
  return null;
}

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function computeCostMicro(price: Price, t: Tokens): number {
  return Math.round(t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite);
}

// ---------------------------------------------------------------------------
// Errors / small helpers
// ---------------------------------------------------------------------------

type HttpError = Error & { statusCode?: number };
function badRequest(message: string, statusCode = 400): HttpError {
  const e = new Error(message) as HttpError;
  e.statusCode = statusCode;
  return e;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const USAGE_URL_KEY = "SURVHUB_AI_USAGE_URL";
const USAGE_TOKEN_KEY = "SURVHUB_AI_USAGE_TOKEN";

// ---------------------------------------------------------------------------
// Connecting an app (token + env injection)
// ---------------------------------------------------------------------------

function setSecretSystemEnv(ctx: AppContext, serviceId: string, key: string, value: string, secret: boolean): void {
  const stored = secret ? encryptSecret(value, ctx.config.secretKey) : value;
  const existing = ctx.db
    .prepare("SELECT id FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 1")
    .get(serviceId, key) as { id?: string } | undefined;
  if (existing?.id) {
    ctx.db.prepare("UPDATE env_vars SET value = ?, is_secret = ? WHERE id = ?").run(stored, secret ? 1 : 0, existing.id);
  } else {
    ctx.db
      .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES (?, ?, ?, ?, ?, 1)")
      .run(nanoid(), serviceId, key, stored, secret ? 1 : 0);
  }
}

function reportUrlFor(ctx: AppContext, serviceType: string | undefined): string {
  const host = serviceType === "docker" || serviceType === "compose" ? "host.docker.internal" : "127.0.0.1";
  return `http://${host}:${ctx.config.apiPort}/api/ai-usage/report`;
}

/** Mint (or rotate) the service's token and inject it into the app's env. */
export function connectService(ctx: AppContext, serviceId: string): { token_prefix: string; restart_required: true } {
  const service = ctx.db.prepare("SELECT id, type FROM services WHERE id = ?").get(serviceId) as
    | { id: string; type?: string }
    | undefined;
  if (!service) throw badRequest("Service not found", 404);
  const token = `sau_${crypto.randomBytes(24).toString("base64url")}`;
  ctx.db.prepare("DELETE FROM ai_usage_tokens WHERE service_id = ?").run(serviceId);
  ctx.db
    .prepare(
      "INSERT INTO ai_usage_tokens (id, service_id, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(nanoid(), serviceId, sha256(token), token.slice(0, 8), nowIso());
  setSecretSystemEnv(ctx, serviceId, USAGE_URL_KEY, reportUrlFor(ctx, service.type), false);
  setSecretSystemEnv(ctx, serviceId, USAGE_TOKEN_KEY, token, true);
  return { token_prefix: token.slice(0, 8), restart_required: true };
}

export function disconnectService(ctx: AppContext, serviceId: string): void {
  ctx.db.prepare("DELETE FROM ai_usage_tokens WHERE service_id = ?").run(serviceId);
  ctx.db
    .prepare("DELETE FROM env_vars WHERE service_id = ? AND key IN (?, ?) AND COALESCE(system, 0) = 1")
    .run(serviceId, USAGE_URL_KEY, USAGE_TOKEN_KEY);
}

export function serviceForToken(ctx: AppContext, token: string): { service_id: string } | null {
  if (!token || !token.startsWith("sau_") || token.length > 100) return null;
  const row = ctx.db
    .prepare("SELECT service_id, last_used_at FROM ai_usage_tokens WHERE token_hash = ?")
    .get(sha256(token)) as { service_id: string; last_used_at: string | null } | undefined;
  if (!row) return null;
  // Touch at most once a minute: reporting is hot and this is only for display.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
    ctx.db.prepare("UPDATE ai_usage_tokens SET last_used_at = ? WHERE service_id = ?").run(nowIso(), row.service_id);
  }
  return { service_id: row.service_id };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export type UsageReport = {
  provider: string;
  model: string;
  feature?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  status: "ok" | "error";
  error_code?: string | null;
  duration_ms?: number;
  request_ref?: string | null;
  /** Optional: overrides the computed cost (micro-USD) when the app knows better. */
  cost_micro_usd?: number | null;
};

let lastPrune = 0;
const RETENTION_DAYS = 400;

export function recordUsage(ctx: AppContext, serviceId: string, report: UsageReport): { recorded: boolean; cost_micro_usd: number | null } {
  const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as { name: string } | undefined;
  if (!service) throw badRequest("Service not found", 404);

  const tokens: Tokens = {
    input: report.input_tokens,
    output: report.output_tokens,
    cacheRead: report.cache_read_tokens ?? 0,
    cacheWrite: report.cache_write_tokens ?? 0
  };
  let cost: number | null;
  let source: "reported" | "computed" | "unpriced";
  if (typeof report.cost_micro_usd === "number") {
    cost = Math.round(report.cost_micro_usd);
    source = "reported";
  } else {
    const found = priceFor(ctx, report.model);
    if (found) {
      cost = computeCostMicro(found.price, tokens);
      source = "computed";
    } else if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) {
      cost = 0;
      source = "computed";
    } else {
      cost = null;
      source = "unpriced";
    }
  }

  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO ai_usage_events
        (id, service_id, app_name, provider, model, feature, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_micro_usd, cost_source, status, error_code, duration_ms, request_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(),
      serviceId,
      service.name,
      report.provider,
      report.model,
      report.feature ?? null,
      tokens.input,
      tokens.output,
      tokens.cacheRead,
      tokens.cacheWrite,
      cost,
      source,
      report.status,
      report.error_code ?? null,
      report.duration_ms ?? 0,
      report.request_ref ?? null,
      nowIso()
    );
  const recorded = Number((res as { changes?: number | bigint }).changes ?? 0) > 0;
  if (recorded) {
    if (cost) checkBudgets(ctx, serviceId, service.name);
    if (Date.now() - lastPrune > 24 * 3600 * 1000) {
      lastPrune = Date.now();
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
      ctx.db.prepare("DELETE FROM ai_usage_events WHERE created_at < ?").run(cutoff);
    }
  }
  return { recorded, cost_micro_usd: cost };
}

// ---------------------------------------------------------------------------
// Budgets and alerts
// ---------------------------------------------------------------------------

export type Budgets = {
  global_daily_usd: number | null;
  per_service: Record<string, { daily_usd: number | null; monthly_usd: number | null }>;
};

export function getBudgets(ctx: AppContext): Budgets {
  const raw = readJson<Partial<Budgets>>(getSetting(ctx, BUDGET_SETTING), {});
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const per: Budgets["per_service"] = {};
  for (const [id, b] of Object.entries(raw.per_service ?? {})) {
    const entry = b as { daily_usd?: unknown; monthly_usd?: unknown };
    const daily = num(entry?.daily_usd);
    const monthly = num(entry?.monthly_usd);
    if (daily || monthly) per[id] = { daily_usd: daily, monthly_usd: monthly };
  }
  return { global_daily_usd: num(raw.global_daily_usd), per_service: per };
}

export function setBudgets(ctx: AppContext, budgets: Budgets): void {
  const check = (v: number | null, label: string) => {
    if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 1_000_000)) throw badRequest(`${label} must be a positive amount`);
  };
  check(budgets.global_daily_usd, "Global daily budget");
  for (const [id, b] of Object.entries(budgets.per_service)) {
    check(b.daily_usd, `Daily budget for ${id}`);
    check(b.monthly_usd, `Monthly budget for ${id}`);
  }
  setSetting(ctx, BUDGET_SETTING, JSON.stringify(budgets));
}

function startOfUtcDay(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
function startOfUtcMonth(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function spendSince(ctx: AppContext, since: string, serviceId?: string): number {
  const row = serviceId
    ? (ctx.db
        .prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM ai_usage_events WHERE created_at >= ? AND service_id = ?")
        .get(since, serviceId) as { s: number })
    : (ctx.db.prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM ai_usage_events WHERE created_at >= ?").get(since) as {
        s: number;
      });
  return Number(row.s);
}

function alertOnce(ctx: AppContext, key: string, periodKey: string, fire: () => void): void {
  const state = readJson<Record<string, string>>(getSetting(ctx, ALERT_STATE_SETTING), {});
  if (state[key] === periodKey) return;
  state[key] = periodKey;
  setSetting(ctx, ALERT_STATE_SETTING, JSON.stringify(state));
  fire();
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro >= 1_000_000 ? 2 : 4)}`;

function checkBudgets(ctx: AppContext, serviceId: string, appName: string): void {
  try {
    const budgets = getBudgets(ctx);
    const today = startOfUtcDay();
    const month = startOfUtcMonth();
    const checks: Array<{ key: string; period: string; label: string; spent: number; limit: number; serviceId?: string }> = [];
    const per = budgets.per_service[serviceId];
    if (per?.daily_usd) checks.push({ key: `svc:${serviceId}:daily`, period: today.slice(0, 10), label: `${appName} daily`, spent: spendSince(ctx, today, serviceId), limit: per.daily_usd * 1e6, serviceId });
    if (per?.monthly_usd) checks.push({ key: `svc:${serviceId}:monthly`, period: month.slice(0, 7), label: `${appName} monthly`, spent: spendSince(ctx, month, serviceId), limit: per.monthly_usd * 1e6, serviceId });
    if (budgets.global_daily_usd) checks.push({ key: "global:daily", period: today.slice(0, 10), label: "All apps daily", spent: spendSince(ctx, today), limit: budgets.global_daily_usd * 1e6 });
    for (const c of checks) {
      for (const level of [100, 80]) {
        if (c.spent >= (c.limit * level) / 100) {
          alertOnce(ctx, `${c.key}:${level}`, c.period, () =>
            createNotification(ctx, {
              kind: "system",
              severity: level >= 100 ? "error" : "warning",
              title: `AI spend at ${level}% of budget: ${c.label}`,
              body: `${usd(c.spent)} of ${usd(c.limit)} used.`,
              serviceId: c.serviceId
            })
          );
          break; // 100 supersedes 80 for the same period
        }
      }
    }
  } catch {
    /* alerting must never fail a usage report */
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type RangeKey = "24h" | "7d" | "30d" | "month";

export function rangeBounds(range: RangeKey, now = new Date()): { from: string; bucket: "hour" | "day" } {
  switch (range) {
    case "24h":
      return { from: new Date(now.getTime() - 24 * 3600_000).toISOString(), bucket: "hour" };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), bucket: "day" };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), bucket: "day" };
    case "month":
      return { from: startOfUtcMonth(now), bucket: "day" };
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

type TotalsRow = {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro_usd: number;
  unpriced_requests: number;
};

export function usageSummary(ctx: AppContext, range: RangeKey, serviceId?: string) {
  const { from, bucket } = rangeBounds(range);
  const where = serviceId ? "created_at >= ? AND service_id = ?" : "created_at >= ?";
  const args: unknown[] = serviceId ? [from, serviceId] : [from];

  const totals = ctx.db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(status = 'error'), 0) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
              COALESCE(SUM(cost_source = 'unpriced'), 0) AS unpriced_requests
       FROM ai_usage_events WHERE ${where}`
    )
    .get(...args) as TotalsRow;

  const byService = ctx.db
    .prepare(
      `SELECT service_id, app_name, COUNT(*) AS requests, COALESCE(SUM(status = 'error'), 0) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
              COALESCE(SUM(cost_source = 'unpriced'), 0) AS unpriced_requests,
              COALESCE(AVG(duration_ms), 0) AS avg_duration_ms, MAX(created_at) AS last_at
       FROM ai_usage_events WHERE ${where} GROUP BY service_id ORDER BY cost_micro_usd DESC, requests DESC`
    )
    .all(...args);

  const byModel = ctx.db
    .prepare(
      `SELECT provider, model, COUNT(*) AS requests, COALESCE(SUM(status = 'error'), 0) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
              COALESCE(SUM(cost_source = 'unpriced'), 0) AS unpriced_requests
       FROM ai_usage_events WHERE ${where} GROUP BY provider, model ORDER BY cost_micro_usd DESC, requests DESC`
    )
    .all(...args);

  const cut = bucket === "hour" ? 13 : 10;
  const series = ctx.db
    .prepare(
      `SELECT substr(created_at, 1, ${cut}) AS bucket, service_id, app_name, COUNT(*) AS requests,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
       FROM ai_usage_events WHERE ${where} GROUP BY bucket, service_id ORDER BY bucket ASC`
    )
    .all(...args);

  const durations = (
    ctx.db
      .prepare(`SELECT duration_ms FROM ai_usage_events WHERE ${where} AND status = 'ok' AND duration_ms > 0 ORDER BY duration_ms ASC LIMIT 100000`)
      .all(...args) as Array<{ duration_ms: number }>
  ).map((r) => r.duration_ms);

  const errorCodes = ctx.db
    .prepare(
      `SELECT COALESCE(error_code, 'unknown') AS error_code, COUNT(*) AS n FROM ai_usage_events
       WHERE ${where} AND status = 'error' GROUP BY error_code ORDER BY n DESC LIMIT 8`
    )
    .all(...args) as Array<{ error_code: string; n: number }>;

  const cacheBase = totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;

  // Pre-existing AI Gateway (subscription inference) traffic, tokens only.
  let gateway: Record<string, number> | null = null;
  try {
    gateway = ctx.db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(status_code >= 400), 0) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM ai_gateway_usage WHERE created_at >= ?`
      )
      .get(from) as Record<string, number>;
  } catch {
    gateway = null; // table absent (older databases / tests)
  }

  const today = startOfUtcDay();
  const month = startOfUtcMonth();
  return {
    range,
    from,
    bucket,
    totals: {
      ...totals,
      avg_cost_micro_usd: totals.requests ? totals.cost_micro_usd / totals.requests : 0,
      error_rate: totals.requests ? totals.errors / totals.requests : 0,
      cache_hit_rate: cacheBase ? totals.cache_read_tokens / cacheBase : 0,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95)
    },
    by_service: byService,
    by_model: byModel,
    series,
    error_codes: errorCodes,
    gateway,
    spend: {
      today_micro_usd: spendSince(ctx, today),
      month_micro_usd: spendSince(ctx, month),
      per_service_today: Object.fromEntries(
        (ctx.db
          .prepare("SELECT service_id, COALESCE(SUM(cost_micro_usd), 0) AS s FROM ai_usage_events WHERE created_at >= ? GROUP BY service_id")
          .all(today) as Array<{ service_id: string; s: number }>).map((r) => [r.service_id, Number(r.s)])
      ),
      per_service_month: Object.fromEntries(
        (ctx.db
          .prepare("SELECT service_id, COALESCE(SUM(cost_micro_usd), 0) AS s FROM ai_usage_events WHERE created_at >= ? GROUP BY service_id")
          .all(month) as Array<{ service_id: string; s: number }>).map((r) => [r.service_id, Number(r.s)])
      )
    },
    budgets: getBudgets(ctx)
  };
}

export function recentEvents(ctx: AppContext, limit: number, serviceId?: string) {
  const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  return serviceId
    ? ctx.db.prepare("SELECT * FROM ai_usage_events WHERE service_id = ? ORDER BY created_at DESC LIMIT ?").all(serviceId, n)
    : ctx.db.prepare("SELECT * FROM ai_usage_events ORDER BY created_at DESC LIMIT ?").all(n);
}

/** Every service with its connection state, so the page can offer "Connect". */
export function listApps(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT s.id AS service_id, s.name, s.type, t.token_prefix, t.created_at AS connected_at, t.last_used_at,
              (SELECT COUNT(*) FROM ai_usage_events e WHERE e.service_id = s.id) AS total_events
       FROM services s LEFT JOIN ai_usage_tokens t ON t.service_id = s.id
       ORDER BY (t.service_id IS NULL) ASC, s.name COLLATE NOCASE ASC`
    )
    .all()
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, connected: Boolean(row.token_prefix) };
    });
}

export function modelPrices(ctx: AppContext) {
  const overrides = getPriceOverrides(ctx);
  const models = new Set([...Object.keys(DEFAULT_PRICES), ...Object.keys(overrides)]);
  const seen = ctx.db.prepare("SELECT DISTINCT model FROM ai_usage_events").all() as Array<{ model: string }>;
  for (const r of seen) models.add(r.model);
  return [...models].sort().map((model) => {
    const found = priceFor(ctx, model);
    return { model, price: found?.price ?? null, custom: found?.custom ?? false, priced: Boolean(found) };
  });
}
