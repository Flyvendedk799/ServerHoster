/**
 * Stripe keys and setup helpers.
 *
 * - Test and live keys are stored separately, encrypted in `settings`
 *   (stripe_<mode>_secret_key / _publishable_key / _webhook_secret). No function
 *   here returns, logs or audits a full key: callers only ever see a masked
 *   preview and a non-reversible fingerprint.
 * - "Connect" injects the keys into an app as encrypted system env.
 * - Anything that writes to LIVE Stripe, or injects live keys into an app, needs
 *   confirmLive === true.
 * - Setup helpers (product+price, webhook, customer portal) are idempotent:
 *   they look up before creating and never create duplicates on a retry.
 *
 * Stripe's merchant verification, payout details and tax registration cannot be
 * done with an API key; verifyKeys() reports what is still missing.
 */

import crypto from "node:crypto";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { writeAuditLog } from "./audit.js";
import { deleteSetting, getSecretSetting, getSetting, setSecretSetting, setSetting } from "./settings.js";
import { setSecretSystemEnv } from "./aiUsage.js";

export type StripeMode = "test" | "live";
export type KeyPart = "secret_key" | "publishable_key" | "webhook_secret";
export type StripeFetch = typeof fetch;
export type StripeDeps = { fetch?: StripeFetch };

export const MODES: StripeMode[] = ["test", "live"];
const PARTS: KeyPart[] = ["secret_key", "publishable_key", "webhook_secret"];
const ENV = {
  secret: "STRIPE_SECRET_KEY",
  publishable: "STRIPE_PUBLISHABLE_KEY",
  webhook: "STRIPE_WEBHOOK_SECRET",
  mode: "STRIPE_MODE"
} as const;
const MANAGED_ENV = [ENV.secret, ENV.publishable, ENV.webhook, ENV.mode];

/** Default events for a subscription product; the owner can change them per call. */
export const DEFAULT_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed"
];

// ---------------------------------------------------------------------------
// Errors and redaction
// ---------------------------------------------------------------------------

export class StripeError extends Error {
  statusCode: number;
  code: string;
  meta?: Record<string, unknown>;
  constructor(statusCode: number, code: string, message: string, meta?: Record<string, unknown>) {
    super(redact(message));
    this.statusCode = statusCode;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

const KEY_PATTERN = /\b(?:(?:sk|rk|pk)_(?:test|live)_|whsec_)[A-Za-z0-9_]+/g;

/** Last line of defence: nothing that looks like a Stripe credential may leave this module in text. */
export function redact(text: string): string {
  return text.replace(KEY_PATTERN, "[redacted]");
}

function audit(ctx: AppContext, actor: string, action: string, statusCode: number, details?: string): void {
  writeAuditLog(ctx, {
    actor,
    action: `stripe.${action}`,
    resourceType: "stripe",
    statusCode,
    details: details ? redact(details) : undefined
  });
}

// ---------------------------------------------------------------------------
// Key validation, masking, storage
// ---------------------------------------------------------------------------

const settingKey = (mode: StripeMode, part: KeyPart) => `stripe_${mode}_${part}`;

function validateKey(mode: StripeMode, part: KeyPart, raw: unknown): string {
  // Messages are deliberately generic and never echo the value.
  if (typeof raw !== "string") throw new StripeError(400, "invalid_key", `The ${label(part)} must be text`);
  const value = raw.trim();
  if (value.length < 20 || value.length > 400 || /\s/.test(value)) {
    throw new StripeError(400, "invalid_key", `The ${label(part)} does not look like a Stripe key`);
  }
  if (part === "secret_key") {
    const ok = new RegExp(`^(sk|rk)_${mode}_[A-Za-z0-9]+$`).test(value);
    if (!ok) throw new StripeError(400, "wrong_key_type", `A ${mode}-mode secret key must start with sk_${mode}_ or rk_${mode}_`);
  } else if (part === "publishable_key") {
    if (!new RegExp(`^pk_${mode}_[A-Za-z0-9]+$`).test(value)) {
      throw new StripeError(400, "wrong_key_type", `A ${mode}-mode publishable key must start with pk_${mode}_`);
    }
  } else if (!/^whsec_[A-Za-z0-9]+$/.test(value)) {
    throw new StripeError(400, "wrong_key_type", "A webhook signing secret must start with whsec_");
  }
  return value;
}

function label(part: KeyPart): string {
  return part === "secret_key" ? "secret key" : part === "publishable_key" ? "publishable key" : "webhook signing secret";
}

export function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(`serverhoster-stripe:${value}`).digest("hex").slice(0, 12);
}

/** `sk_test_…ab12`: prefix and last four characters only. */
export function preview(value: string): string {
  const m = value.match(/^((?:sk|rk|pk)_(?:test|live)_|whsec_)/);
  return `${m ? m[1] : ""}…${value.slice(-4)}`;
}

function readKey(ctx: AppContext, mode: StripeMode, part: KeyPart): string | null {
  return getSecretSetting(ctx, settingKey(mode, part));
}

function keyInfo(ctx: AppContext, mode: StripeMode, part: KeyPart) {
  const value = readKey(ctx, mode, part);
  return value ? { configured: true, preview: preview(value), fingerprint: fingerprint(value) } : { configured: false, preview: null, fingerprint: null };
}

function requireSecret(ctx: AppContext, mode: StripeMode): string {
  const key = readKey(ctx, mode, "secret_key");
  if (!key) throw new StripeError(400, "secret_key_missing", `No ${mode}-mode secret key is stored. Add one on the Stripe page first.`);
  return key;
}

function parseMode(mode: unknown): StripeMode {
  if (mode === "test" || mode === "live") return mode;
  throw new StripeError(400, "invalid_mode", "mode must be 'test' or 'live'");
}

function requireLive(mode: StripeMode, confirmLive: unknown, what: string): void {
  if (mode === "live" && confirmLive !== true) {
    throw new StripeError(400, "live_confirmation_required", `${what} on LIVE Stripe needs confirmLive: true. Nothing was changed.`);
  }
}

export function saveKeys(
  ctx: AppContext,
  actor: string,
  modeInput: unknown,
  input: { secretKey?: unknown; publishableKey?: unknown; webhookSecret?: unknown }
) {
  const mode = parseMode(modeInput);
  const todo: Array<[KeyPart, string]> = [];
  if (input.secretKey != null && input.secretKey !== "") todo.push(["secret_key", validateKey(mode, "secret_key", input.secretKey)]);
  if (input.publishableKey != null && input.publishableKey !== "") todo.push(["publishable_key", validateKey(mode, "publishable_key", input.publishableKey)]);
  if (input.webhookSecret != null && input.webhookSecret !== "") todo.push(["webhook_secret", validateKey(mode, "webhook_secret", input.webhookSecret)]);
  if (!todo.length) throw new StripeError(400, "nothing_to_save", "Provide at least one key");
  for (const [part, value] of todo) {
    setSecretSetting(ctx, settingKey(mode, part), value);
    if (part === "secret_key") deleteSetting(ctx, `stripe_${mode}_account`); // cached account belongs to the old key
  }
  const synced = syncModeApps(ctx, mode);
  audit(ctx, actor, "keys.save", 200, `mode=${mode} parts=${todo.map(([p, v]) => `${p}:${fingerprint(v)}`).join(",")} appsUpdated=${synced.length}`);
  return { ok: true, mode, apps_updated: synced, restart_needed: synced.length > 0 };
}

export function removeKeys(ctx: AppContext, actor: string, modeInput: unknown, partInput: unknown) {
  const mode = parseMode(modeInput);
  // The part must be named: a bare DELETE never wipes everything by default.
  const parts: KeyPart[] = partInput === "all" ? PARTS : [partInput as KeyPart];
  if (!parts.every((p) => PARTS.includes(p))) throw new StripeError(400, "invalid_part", "part must be secret_key, publishable_key, webhook_secret or all");
  let disconnected: string[] = [];
  for (const part of parts) deleteSetting(ctx, settingKey(mode, part));
  if (parts.includes("secret_key")) {
    deleteSetting(ctx, `stripe_${mode}_account`);
    // An app cannot keep a secret key that no longer exists here.
    disconnected = linkedServices(ctx, mode);
    for (const id of disconnected) removeAppEnv(ctx, id);
  }
  const updated = parts.includes("secret_key") ? [] : syncModeApps(ctx, mode);
  audit(ctx, actor, "keys.remove", 200, `mode=${mode} parts=${parts.join(",")} appsDisconnected=${disconnected.length} appsUpdated=${updated.length}`);
  return { ok: true, mode, apps_disconnected: disconnected, apps_updated: updated, restart_needed: disconnected.length + updated.length > 0 };
}

// ---------------------------------------------------------------------------
// Stripe HTTP
// ---------------------------------------------------------------------------

type Form = Record<string, unknown>;

/** Stripe's nested form encoding: a[b]=c, lists as a[0]=x. */
export function encodeForm(params: Form): string {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value as Form)) walk(`${prefix}[${k}]`, v);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export class StripeApiError extends StripeError {
  stripeType: string;
  stripeCode: string | null;
  status: number;
  constructor(status: number, type: string, code: string | null) {
    // Only Stripe's error type and code are surfaced: Stripe messages can quote parts of a key.
    super(status >= 500 || status === 0 ? 502 : status === 404 ? 404 : 400, "stripe_error", `Stripe responded with ${type}${code ? ` (${code})` : ""}`, {
      stripe_type: type,
      stripe_code: code,
      stripe_status: status
    });
    this.stripeType = type;
    this.stripeCode = code;
    this.status = status;
  }
}

async function stripeCall<T = Record<string, any>>(
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Form | undefined,
  deps: StripeDeps,
  idempotencyKey?: string
): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const body = params ? encodeForm(params) : "";
  const url = `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new StripeApiError(0, "network_error", null);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new StripeApiError(res.status, typeof e.type === "string" ? e.type : "api_error", typeof e.code === "string" ? e.code : null);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export type AccountSummary = {
  id: string;
  name: string | null;
  country: string | null;
  default_currency: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  livemode: boolean;
  currently_due: string[];
  verified_at: string;
};

export async function verifyKeys(ctx: AppContext, actor: string, modeInput: unknown, deps: StripeDeps = {}): Promise<AccountSummary> {
  const mode = parseMode(modeInput);
  const key = requireSecret(ctx, mode);
  let account: any;
  try {
    account = await stripeCall(key, "GET", "/v1/account", undefined, deps);
  } catch (e) {
    audit(ctx, actor, "verify", e instanceof StripeError ? e.statusCode : 500, `mode=${mode} result=${(e as StripeApiError).stripeType ?? "error"}`);
    throw e;
  }
  // The key's prefix decides the mode; if Stripe says otherwise, refuse.
  if (typeof account.livemode === "boolean" && account.livemode !== (mode === "live")) {
    audit(ctx, actor, "verify", 409, `mode=${mode} result=mode_mismatch`);
    throw new StripeError(409, "mode_mismatch", `Stripe reports this key as ${account.livemode ? "live" : "test"} mode, but it is stored in the ${mode} slot.`);
  }
  const summary: AccountSummary = {
    id: String(account.id ?? ""),
    name: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
    country: account.country ?? null,
    default_currency: account.default_currency ?? null,
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
    livemode: mode === "live",
    currently_due: Array.isArray(account.requirements?.currently_due) ? account.requirements.currently_due.slice(0, 12).map(String) : [],
    verified_at: nowIso()
  };
  setSetting(ctx, `stripe_${mode}_account`, JSON.stringify(summary));
  audit(ctx, actor, "verify", 200, `mode=${mode} account=${summary.id} charges=${summary.charges_enabled} payouts=${summary.payouts_enabled}`);
  return summary;
}

function cachedAccount(ctx: AppContext, mode: StripeMode): AccountSummary | null {
  const raw = getSetting(ctx, `stripe_${mode}_account`);
  try {
    return raw ? (JSON.parse(raw) as AccountSummary) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type SetupRecord = {
  prices?: Record<string, { product: string; price: string; unit_amount: number; currency: string; interval: string; tax_behavior: string; at: string }>;
  webhook?: { id: string; url: string; events: string[]; at: string };
  portal?: { id: string; at: string };
};

function readSetup(ctx: AppContext, mode: StripeMode): SetupRecord {
  try {
    return JSON.parse(getSetting(ctx, `stripe_${mode}_setup`) ?? "{}") as SetupRecord;
  } catch {
    return {};
  }
}
function writeSetup(ctx: AppContext, mode: StripeMode, patch: (s: SetupRecord) => void): SetupRecord {
  const s = readSetup(ctx, mode);
  patch(s);
  setSetting(ctx, `stripe_${mode}_setup`, JSON.stringify(s));
  return s;
}

export function getStatus(ctx: AppContext) {
  const modes: Record<string, unknown> = {};
  for (const mode of MODES) {
    modes[mode] = {
      secret_key: keyInfo(ctx, mode, "secret_key"),
      publishable_key: keyInfo(ctx, mode, "publishable_key"),
      webhook_secret: keyInfo(ctx, mode, "webhook_secret"),
      account: cachedAccount(ctx, mode),
      setup: readSetup(ctx, mode)
    };
  }
  return { modes, default_mode: "test" as const, default_webhook_events: DEFAULT_WEBHOOK_EVENTS };
}

// ---------------------------------------------------------------------------
// Connecting apps
// ---------------------------------------------------------------------------

type LinkRow = { service_id: string; mode: StripeMode; connected_at: string; synced_at: string; extra_env_json: string };

function linkedServices(ctx: AppContext, mode: StripeMode): string[] {
  return (ctx.db.prepare("SELECT service_id FROM stripe_app_links WHERE mode = ?").all(mode) as Array<{ service_id: string }>).map((r) => r.service_id);
}

function removeAppEnv(ctx: AppContext, serviceId: string): void {
  const link = ctx.db.prepare("SELECT extra_env_json FROM stripe_app_links WHERE service_id = ?").get(serviceId) as { extra_env_json: string } | undefined;
  let extra: string[] = [];
  try {
    extra = JSON.parse(link?.extra_env_json ?? "[]");
  } catch {
    /* ignore */
  }
  const keys = [...MANAGED_ENV, ...extra];
  const del = ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 1");
  for (const k of keys) del.run(serviceId, k);
  ctx.db.prepare("DELETE FROM stripe_app_links WHERE service_id = ?").run(serviceId);
}

/** Make an app's system env match the stored keys for its mode. Returns the env names that now exist. */
function syncApp(ctx: AppContext, serviceId: string): string[] {
  const link = ctx.db.prepare("SELECT * FROM stripe_app_links WHERE service_id = ?").get(serviceId) as LinkRow | undefined;
  if (!link) return [];
  const mode = link.mode;
  const values: Array<[string, string | null, boolean]> = [
    [ENV.secret, readKey(ctx, mode, "secret_key"), true],
    [ENV.publishable, readKey(ctx, mode, "publishable_key"), true],
    [ENV.webhook, readKey(ctx, mode, "webhook_secret"), true],
    [ENV.mode, mode, false]
  ];
  const present: string[] = [];
  const del = ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 1");
  for (const [name, value, secret] of values) {
    if (value) {
      setSecretSystemEnv(ctx, serviceId, name, value, secret);
      present.push(name);
    } else del.run(serviceId, name);
  }
  ctx.db.prepare("UPDATE stripe_app_links SET synced_at = ? WHERE service_id = ?").run(nowIso(), serviceId);
  return present;
}

/** Push changed keys into every app connected in this mode; returns their service ids. */
function syncModeApps(ctx: AppContext, mode: StripeMode): string[] {
  const ids = linkedServices(ctx, mode);
  for (const id of ids) syncApp(ctx, id);
  return ids;
}

export function listApps(ctx: AppContext) {
  const rows = ctx.db
    .prepare(
      `SELECT s.id AS service_id, s.name, s.type, s.status, s.last_started_at, l.mode, l.connected_at, l.synced_at
       FROM services s LEFT JOIN stripe_app_links l ON l.service_id = s.id
       ORDER BY (l.service_id IS NULL) ASC, s.name COLLATE NOCASE ASC`
    )
    .all() as Array<Record<string, any>>;
  return rows.map((r) => {
    const connected = Boolean(r.mode);
    // The app reads env at start: if it is running and last started before the last sync, it needs a restart.
    const restart_needed = connected && r.status === "running" && (!r.last_started_at || String(r.last_started_at) < String(r.synced_at));
    return {
      service_id: r.service_id,
      name: r.name,
      type: r.type,
      status: r.status,
      connected,
      mode: (r.mode as StripeMode | null) ?? null,
      connected_at: r.connected_at ?? null,
      synced_at: r.synced_at ?? null,
      restart_needed
    };
  });
}

export function connectApp(
  ctx: AppContext,
  actor: string,
  input: { serviceId: string; mode?: unknown; confirmLive?: unknown; takeover?: unknown }
) {
  const mode = parseMode(input.mode ?? "test");
  requireLive(mode, input.confirmLive, "Injecting live Stripe keys into an app");
  const service = ctx.db.prepare("SELECT id, name FROM services WHERE id = ?").get(input.serviceId) as { id: string; name: string } | undefined;
  if (!service) throw new StripeError(404, "service_not_found", "Service not found");
  requireSecret(ctx, mode);

  const conflicts = (
    ctx.db
      .prepare(`SELECT key FROM env_vars WHERE service_id = ? AND COALESCE(system, 0) = 0 AND key IN (${MANAGED_ENV.map(() => "?").join(",")})`)
      .all(service.id, ...MANAGED_ENV) as Array<{ key: string }>
  ).map((r) => r.key);
  if (conflicts.length && input.takeover !== true) {
    throw new StripeError(
      409,
      "env_conflict",
      `${service.name} already defines ${conflicts.join(", ")} itself. Connect again with takeover to replace them.`,
      { conflicts }
    );
  }
  for (const key of conflicts) ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 0").run(service.id, key);

  const now = nowIso();
  const existing = ctx.db.prepare("SELECT extra_env_json FROM stripe_app_links WHERE service_id = ?").get(service.id) as { extra_env_json: string } | undefined;
  ctx.db
    .prepare(
      `INSERT INTO stripe_app_links (service_id, mode, connected_at, synced_at, extra_env_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET mode = excluded.mode, synced_at = excluded.synced_at`
    )
    .run(service.id, mode, now, now, existing?.extra_env_json ?? "[]");
  const env = syncApp(ctx, service.id);
  audit(ctx, actor, "app.connect", 200, `service=${service.id} mode=${mode} env=${env.join(",")} takeover=${conflicts.length}`);
  return { ok: true, service_id: service.id, mode, env, replaced: conflicts, restart_needed: true };
}

export function disconnectApp(ctx: AppContext, actor: string, serviceId: string) {
  const link = ctx.db.prepare("SELECT mode FROM stripe_app_links WHERE service_id = ?").get(serviceId) as { mode: StripeMode } | undefined;
  if (!link) throw new StripeError(404, "not_connected", "This app is not connected to Stripe");
  removeAppEnv(ctx, serviceId);
  audit(ctx, actor, "app.disconnect", 200, `service=${serviceId} mode=${link.mode}`);
  return { ok: true, service_id: serviceId, restart_needed: true };
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/;

/** Add an extra non-secret system env (e.g. STRIPE_PRICE_ID) to a connected app and remember it for Disconnect. */
function injectExtraEnv(ctx: AppContext, serviceId: string, mode: StripeMode, name: string, value: string): boolean {
  const link = ctx.db.prepare("SELECT mode, extra_env_json FROM stripe_app_links WHERE service_id = ?").get(serviceId) as
    | { mode: StripeMode; extra_env_json: string }
    | undefined;
  if (!link) throw new StripeError(409, "not_connected", "Connect the app to Stripe first, so the keys and the price come from the same mode");
  if (link.mode !== mode) throw new StripeError(409, "mode_mismatch", `That app is connected in ${link.mode} mode, not ${mode}`);
  if (!ENV_NAME.test(name) || MANAGED_ENV.includes(name as never)) throw new StripeError(400, "invalid_env_name", "Choose a different environment variable name");
  setSecretSystemEnv(ctx, serviceId, name, value, false);
  let extra: string[] = [];
  try {
    extra = JSON.parse(link.extra_env_json);
  } catch {
    /* ignore */
  }
  if (!extra.includes(name)) extra.push(name);
  ctx.db.prepare("UPDATE stripe_app_links SET extra_env_json = ?, synced_at = ? WHERE service_id = ?").run(JSON.stringify(extra), nowIso(), serviceId);
  return true;
}

// ---------------------------------------------------------------------------
// Setup helpers (idempotent)
// ---------------------------------------------------------------------------

export type PriceInput = {
  mode?: unknown;
  name?: unknown;
  unitAmount?: unknown;
  currency?: unknown;
  interval?: unknown;
  taxBehavior?: unknown;
  lookupKey?: unknown;
  serviceId?: unknown;
  priceEnvName?: unknown;
  confirmLive?: unknown;
};

export async function ensureProductPrice(ctx: AppContext, actor: string, input: PriceInput, deps: StripeDeps = {}) {
  const mode = parseMode(input.mode ?? "test");
  requireLive(mode, input.confirmLive, "Creating a product and price");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const unitAmount = input.unitAmount;
  const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "";
  const interval = input.interval;
  const tax = input.taxBehavior;
  const lookupKey = typeof input.lookupKey === "string" ? input.lookupKey.trim() : "";
  if (!name || name.length > 100) throw new StripeError(400, "invalid_input", "name is required (max 100 characters)");
  if (typeof unitAmount !== "number" || !Number.isInteger(unitAmount) || unitAmount < 1 || unitAmount > 99_999_999)
    throw new StripeError(400, "invalid_input", "unitAmount must be a whole number of the smallest currency unit (for example 900 for 9.00)");
  if (!/^[a-z]{3}$/.test(currency)) throw new StripeError(400, "invalid_input", "currency must be a 3-letter code such as eur");
  if (!["day", "week", "month", "year"].includes(String(interval))) throw new StripeError(400, "invalid_input", "interval must be day, week, month or year");
  if (tax !== "inclusive" && tax !== "exclusive") throw new StripeError(400, "invalid_input", "taxBehavior must be inclusive or exclusive");
  if (!/^[a-z0-9_.-]{3,64}$/.test(lookupKey)) throw new StripeError(400, "invalid_input", "lookupKey must be 3-64 characters of a-z, 0-9, _ . -");
  const priceEnvName = input.priceEnvName == null || input.priceEnvName === "" ? null : String(input.priceEnvName);
  if (priceEnvName && !ENV_NAME.test(priceEnvName)) throw new StripeError(400, "invalid_input", "priceEnvName must look like STRIPE_PRICE_ID");

  const key = requireSecret(ctx, mode);
  const found = await stripeCall<{ data: any[] }>(key, "GET", "/v1/prices", { lookup_keys: [lookupKey], limit: 1 }, deps);
  let price = found.data?.[0];
  let created = false;
  let productId: string;
  if (price) {
    const mismatches: string[] = [];
    if (price.unit_amount !== unitAmount) mismatches.push(`amount is ${price.unit_amount}, not ${unitAmount}`);
    if (price.currency !== currency) mismatches.push(`currency is ${price.currency}, not ${currency}`);
    if (price.recurring?.interval !== interval || (price.recurring?.interval_count ?? 1) !== 1) mismatches.push("billing interval differs");
    if (price.tax_behavior !== tax) mismatches.push(`tax behavior is ${price.tax_behavior}, not ${tax}`);
    if (mismatches.length) {
      audit(ctx, actor, "price.conflict", 409, `mode=${mode} lookup=${lookupKey} price=${price.id}`);
      throw new StripeError(
        409,
        "price_conflict",
        `A price with lookup key ${lookupKey} already exists and differs (${mismatches.join("; ")}). Stripe prices are immutable: use a new lookup key, or archive the old price in Stripe.`,
        { price_id: price.id, mismatches }
      );
    }
    productId = String(price.product);
  } else {
    // Deterministic product id: no search-index lag, so a retry cannot create a second product.
    productId = `sh_${lookupKey.replace(/[^a-z0-9_]/g, "_")}`;
    let product: any = null;
    try {
      product = await stripeCall(key, "GET", `/v1/products/${encodeURIComponent(productId)}`, undefined, deps);
    } catch (e) {
      if (!(e instanceof StripeApiError && e.status === 404)) throw e;
    }
    if (!product) {
      product = await stripeCall(key, "POST", "/v1/products", { id: productId, name, metadata: { serverhoster_lookup_key: lookupKey } }, deps, `sh-product-${mode}-${lookupKey}`);
    } else if (product.name !== name) {
      await stripeCall(key, "POST", `/v1/products/${encodeURIComponent(productId)}`, { name }, deps);
    }
    price = await stripeCall(
      key,
      "POST",
      "/v1/prices",
      {
        product: productId,
        unit_amount: unitAmount,
        currency,
        recurring: { interval },
        tax_behavior: tax,
        lookup_key: lookupKey,
        metadata: { serverhoster_lookup_key: lookupKey }
      },
      deps,
      `sh-price-${mode}-${lookupKey}-${unitAmount}-${currency}-${interval}-${tax}`
    );
    created = true;
  }
  writeSetup(ctx, mode, (s) => {
    s.prices = { ...(s.prices ?? {}), [lookupKey]: { product: productId, price: price.id, unit_amount: unitAmount, currency, interval: String(interval), tax_behavior: String(tax), at: nowIso() } };
  });
  let injected: { service_id: string; env: string } | null = null;
  if (typeof input.serviceId === "string" && input.serviceId && priceEnvName) {
    injectExtraEnv(ctx, input.serviceId, mode, priceEnvName, String(price.id));
    injected = { service_id: input.serviceId, env: priceEnvName };
  }
  audit(ctx, actor, "price.ensure", 200, `mode=${mode} lookup=${lookupKey} product=${productId} price=${price.id} created=${created}${injected ? ` env=${injected.env}@${injected.service_id}` : ""}`);
  return {
    ok: true,
    mode,
    created,
    product: { id: productId, name },
    price: { id: String(price.id), lookup_key: lookupKey, unit_amount: unitAmount, currency, interval: String(interval), tax_behavior: String(tax) },
    injected,
    restart_needed: Boolean(injected)
  };
}

export type WebhookInput = { mode?: unknown; url?: unknown; events?: unknown; confirmLive?: unknown };

function validateEvents(events: unknown): string[] {
  if (events == null) return [...DEFAULT_WEBHOOK_EVENTS].sort(); // always normalised so comparing with Stripe's list is stable
  if (!Array.isArray(events) || events.length < 1 || events.length > 50 || !events.every((e) => typeof e === "string" && /^[a-z_.*]{3,80}$/.test(e)))
    throw new StripeError(400, "invalid_input", "events must be a list of 1-50 Stripe event names such as invoice.paid");
  return [...new Set(events as string[])].sort();
}

export async function ensureWebhook(ctx: AppContext, actor: string, input: WebhookInput, deps: StripeDeps = {}) {
  const mode = parseMode(input.mode ?? "test");
  requireLive(mode, input.confirmLive, "Creating a webhook endpoint");
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new StripeError(400, "invalid_input", "url must be a full https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
    throw new StripeError(400, "invalid_input", "url must be a public https URL without credentials");
  }
  const events = validateEvents(input.events);
  const key = requireSecret(ctx, mode);
  const list = await stripeCall<{ data: any[] }>(key, "GET", "/v1/webhook_endpoints", { limit: 100 }, deps);
  const existing = list.data?.find((e) => e.url === url.toString());
  let endpoint = existing;
  let created = false;
  let updated = false;
  let secretStored = Boolean(readKey(ctx, mode, "webhook_secret"));
  let secretUnavailable = false;
  if (existing) {
    const have = [...(existing.enabled_events ?? [])].sort();
    if (JSON.stringify(have) !== JSON.stringify(events)) {
      endpoint = await stripeCall(key, "POST", `/v1/webhook_endpoints/${encodeURIComponent(existing.id)}`, { enabled_events: events }, deps);
      updated = true;
    }
    // Stripe only reveals the signing secret when the endpoint is created.
    secretUnavailable = !secretStored;
  } else {
    endpoint = await stripeCall(
      key,
      "POST",
      "/v1/webhook_endpoints",
      { url: url.toString(), enabled_events: events, description: "Created by ServerHoster", metadata: { serverhoster: "managed" } },
      deps,
      `sh-webhook-${mode}-${crypto.createHash("sha256").update(url.toString()).digest("hex").slice(0, 16)}`
    );
    created = true;
    if (typeof endpoint.secret === "string" && /^whsec_/.test(endpoint.secret)) {
      setSecretSetting(ctx, settingKey(mode, "webhook_secret"), endpoint.secret);
      secretStored = true;
    }
  }
  const synced = created && secretStored ? syncModeApps(ctx, mode) : [];
  writeSetup(ctx, mode, (s) => {
    s.webhook = { id: String(endpoint.id), url: url.toString(), events, at: nowIso() };
  });
  audit(ctx, actor, "webhook.ensure", 200, `mode=${mode} endpoint=${endpoint.id} created=${created} updated=${updated} secretStored=${secretStored} appsUpdated=${synced.length}`);
  return {
    ok: true,
    mode,
    created,
    updated,
    endpoint: { id: String(endpoint.id), url: url.toString(), events, status: endpoint.status ?? null },
    secret_stored: secretStored,
    secret_unavailable: secretUnavailable,
    note: secretUnavailable
      ? "This endpoint already existed, and Stripe only shows its signing secret at creation. Paste the secret under Keys, or delete the endpoint in Stripe and run this again."
      : undefined,
    apps_updated: synced,
    restart_needed: synced.length > 0
  };
}

export type PortalInput = { mode?: unknown; returnUrl?: unknown; confirmLive?: unknown };

export async function ensurePortal(ctx: AppContext, actor: string, input: PortalInput, deps: StripeDeps = {}) {
  const mode = parseMode(input.mode ?? "test");
  requireLive(mode, input.confirmLive, "Configuring the customer portal");
  let returnUrl: string | undefined;
  if (input.returnUrl != null && input.returnUrl !== "") {
    try {
      const u = new URL(String(input.returnUrl));
      if (u.protocol !== "https:" || u.username || u.password) throw new Error("bad");
      returnUrl = u.toString();
    } catch {
      throw new StripeError(400, "invalid_input", "returnUrl must be an https URL");
    }
  }
  const key = requireSecret(ctx, mode);
  const params: Form = {
    "features[payment_method_update][enabled]": true,
    "features[invoice_history][enabled]": true,
    "features[customer_update][enabled]": true,
    "features[customer_update][allowed_updates]": ["email"],
    "features[subscription_cancel][enabled]": true,
    "features[subscription_cancel][mode]": "at_period_end",
    "metadata[serverhoster]": "default"
  };
  if (returnUrl) params.default_return_url = returnUrl;
  const list = await stripeCall<{ data: any[] }>(key, "GET", "/v1/billing_portal/configurations", { limit: 100 }, deps);
  const existing = list.data?.find((c) => c.metadata?.serverhoster === "default" && c.active !== false);
  let config: any;
  let created = false;
  if (existing) {
    const updateParams = { ...params };
    delete updateParams["metadata[serverhoster]"]; // already tagged
    config = await stripeCall(key, "POST", `/v1/billing_portal/configurations/${encodeURIComponent(existing.id)}`, updateParams, deps);
  } else {
    config = await stripeCall(key, "POST", "/v1/billing_portal/configurations", params, deps, `sh-portal-${mode}`);
    created = true;
  }
  writeSetup(ctx, mode, (s) => {
    s.portal = { id: String(config.id), at: nowIso() };
  });
  audit(ctx, actor, "portal.ensure", 200, `mode=${mode} configuration=${config.id} created=${created}`);
  return { ok: true, mode, created, portal: { id: String(config.id), cancel: "at_period_end", payment_method_update: true, return_url: returnUrl ?? null } };
}
