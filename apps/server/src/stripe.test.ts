/**
 * Stripe tab: key validation/storage, verification, app wiring, idempotent setup
 * helpers, REST routes and MCP tools. Stripe's HTTP is replaced by an in-memory
 * fake injected through `deps.fetch`; nothing here can reach the real Stripe API.
 * All "keys" are obviously fake strings built at runtime.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./types.js";
import {
  StripeError,
  connectApp,
  disconnectApp,
  encodeForm,
  ensurePortal,
  ensureProductPrice,
  ensureWebhook,
  getStatus,
  listApps,
  redact,
  removeKeys,
  saveKeys,
  verifyKeys
} from "./services/stripe.js";
import { getServiceEnv } from "./lib/core.js";
import { isApiPath } from "./routes/auth.js";
import { registerStripeRoutes } from "./routes/stripe.js";
import { registerStripeMcpTools } from "./routes/mcpStripe.js";

// ---- fake credentials (never real) ----------------------------------------
const SK_TEST = "sk_test_" + "A1b2C3d4".repeat(4);
const SK_TEST_2 = "sk_test_" + "Q9w8E7r6".repeat(4);
const SK_LIVE = "sk_live_" + "Z9y8X7w6".repeat(4);
const RK_TEST = "rk_test_" + "M5n4B3v2".repeat(4);
const PK_TEST = "pk_test_" + "P1o2I3u4".repeat(4);
const PK_LIVE = "pk_live_" + "L1k2J3h4".repeat(4);
const WHSEC_MANUAL = "whsec_" + "H4n5D6l7".repeat(3);
const WHSEC_CREATED = "whsec_" + "N3w5Ecr3t".repeat(3);
const ALL_KEYS = [SK_TEST, SK_TEST_2, SK_LIVE, RK_TEST, PK_TEST, PK_LIVE, WHSEC_MANUAL, WHSEC_CREATED];

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE services (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, type TEXT, status TEXT, last_started_at TEXT);
CREATE TABLE env_vars (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL,
  resource_id TEXT, status_code INTEGER NOT NULL, details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE stripe_app_links (
  service_id TEXT PRIMARY KEY, mode TEXT NOT NULL, connected_at TEXT NOT NULL, synced_at TEXT NOT NULL,
  extra_env_json TEXT NOT NULL DEFAULT '[]'
);
`;

let ctx: AppContext;

function makeContext(): AppContext {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const add = db.prepare("INSERT INTO services (id, project_id, name, type, status, last_started_at) VALUES (?, 'p1', ?, ?, ?, ?)");
  add.run("svc-coach", "Coach", "docker", "running", "2026-01-01T00:00:00.000Z");
  add.run("svc-web", "Web", "process", "stopped", null);
  return {
    db,
    config: { secretKey: "test-secret-key-32-bytes-not-for-prod", apiPort: 8787, publicUrl: "" },
    wsSubscribers: new Set(),
    app: { log: { info() {}, warn() {}, error() {}, child: () => ({}) } }
  } as unknown as AppContext;
}

beforeEach(() => {
  ctx = makeContext();
});

// ---- fake Stripe -----------------------------------------------------------
type Call = { method: string; path: string; query: URLSearchParams; form: URLSearchParams; auth: string; redirect: unknown; idem: string | null };

function makeStripe(opts: { accountStatus?: number; livemode?: boolean; netFail?: boolean } = {}) {
  const calls: Call[] = [];
  const state = {
    prices: [] as any[],
    products: new Map<string, any>(),
    hooks: [] as any[],
    portals: [] as any[]
  };
  let n = 0;
  const listFrom = (form: URLSearchParams, prefix: string) => {
    const out: string[] = [];
    for (const [k, v] of form) if (k.startsWith(prefix + "[")) out.push(v);
    return out;
  };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.netFail) throw new TypeError("network down");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(String(init?.body ?? ""));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method, path: url.pathname, query: url.searchParams, form, auth: headers.Authorization ?? "", redirect: init?.redirect, idem: headers["Idempotency-Key"] ?? null };
    calls.push(call);
    assert.equal(url.origin, "https://api.stripe.com", "only api.stripe.com is ever contacted");
    const send = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const p = url.pathname;
    if (p === "/v1/account") {
      if (opts.accountStatus && opts.accountStatus !== 200) return send(opts.accountStatus, { error: { type: "invalid_request_error", code: "api_key_expired", message: `Expired key: ${call.auth}` } });
      return send(200, {
        id: "acct_fake123", business_profile: { name: "Fake Aim Co" }, country: "DK", default_currency: "eur",
        charges_enabled: false, payouts_enabled: false, details_submitted: false,
        requirements: { currently_due: ["business_profile.url", "external_account"] },
        ...(opts.livemode === undefined ? {} : { livemode: opts.livemode })
      });
    }
    if (p === "/v1/prices" && method === "GET") {
      const key = call.query.get("lookup_keys[0]");
      return send(200, { data: state.prices.filter((x) => x.lookup_key === key) });
    }
    if (p === "/v1/prices" && method === "POST") {
      const price = {
        id: `price_${++n}`, product: form.get("product"), unit_amount: Number(form.get("unit_amount")), currency: form.get("currency"),
        recurring: { interval: form.get("recurring[interval]"), interval_count: 1 }, tax_behavior: form.get("tax_behavior"), lookup_key: form.get("lookup_key")
      };
      state.prices.push(price);
      return send(200, price);
    }
    const prod = p.match(/^\/v1\/products\/(.+)$/);
    if (prod && method === "GET") {
      const found = state.products.get(decodeURIComponent(prod[1]));
      return found ? send(200, found) : send(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    }
    if (prod && method === "POST") {
      const found = state.products.get(decodeURIComponent(prod[1]));
      found.name = form.get("name");
      return send(200, found);
    }
    if (p === "/v1/products" && method === "POST") {
      const product = { id: form.get("id"), name: form.get("name") };
      state.products.set(String(product.id), product);
      return send(200, product);
    }
    if (p === "/v1/webhook_endpoints" && method === "GET") return send(200, { data: state.hooks });
    if (p === "/v1/webhook_endpoints" && method === "POST") {
      const hook = { id: `we_${++n}`, url: form.get("url"), enabled_events: listFrom(form, "enabled_events"), status: "enabled", secret: WHSEC_CREATED };
      state.hooks.push({ ...hook, secret: undefined }); // Stripe only reveals the secret on creation
      return send(200, hook);
    }
    const hookUpdate = p.match(/^\/v1\/webhook_endpoints\/(.+)$/);
    if (hookUpdate && method === "POST") {
      const hook = state.hooks.find((h) => h.id === hookUpdate[1]);
      hook.enabled_events = listFrom(form, "enabled_events");
      return send(200, hook);
    }
    if (p === "/v1/billing_portal/configurations" && method === "GET") return send(200, { data: state.portals });
    if (p === "/v1/billing_portal/configurations" && method === "POST") {
      const cfg = { id: `bpc_${++n}`, active: true, metadata: { serverhoster: form.get("metadata[serverhoster]") }, default_return_url: form.get("default_return_url") };
      state.portals.push(cfg);
      return send(200, cfg);
    }
    const portalUpdate = p.match(/^\/v1\/billing_portal\/configurations\/(.+)$/);
    if (portalUpdate && method === "POST") return send(200, state.portals.find((c) => c.id === portalUpdate[1]));
    return send(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
  }) as typeof fetch;
  return { fetch: impl, calls, state, writes: () => calls.filter((c) => c.method !== "GET") };
}

// ---- no-leak helpers --------------------------------------------------------
const KEYISH = /\b(?:(?:sk|rk|pk)_(?:test|live)_|whsec_)[A-Za-z0-9_]+/;

function assertNoKeys(value: unknown, label = "value"): void {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  for (const key of ALL_KEYS) {
    assert.ok(!text.includes(key), `${label} contains a full key`);
    // no long fragments either
    assert.ok(!text.includes(key.slice(8, 24)), `${label} contains a key fragment`);
  }
  assert.ok(!KEYISH.test(text), `${label} contains something shaped like a Stripe key`);
}

function assertNoKeysAnywhere(): void {
  assertNoKeys(ctx.db.prepare("SELECT * FROM audit_logs").all(), "audit log");
  assertNoKeys(getStatus(ctx), "status");
  assertNoKeys(listApps(ctx), "apps");
}

const ACTOR = "test-actor";

// ---------------------------------------------------------------------------

describe("key validation and storage", () => {
  test("accepts correct prefixes per mode, including restricted keys", () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST, webhookSecret: WHSEC_MANUAL });
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE, publishableKey: PK_LIVE });
    saveKeys(ctx, ACTOR, "test", { secretKey: RK_TEST });
    const s = getStatus(ctx) as any;
    assert.equal(s.modes.test.secret_key.configured, true);
    assert.equal(s.modes.live.secret_key.configured, true);
    assert.equal(s.modes.live.webhook_secret.configured, false);
  });

  test("rejects a key in the wrong mode slot, a wrong prefix, junk and non-strings", () => {
    const bad: Array<[string, unknown, string]> = [
      ["test", SK_LIVE, "secretKey"],
      ["live", SK_TEST, "secretKey"],
      ["test", PK_TEST, "secretKey"],
      ["test", "not a key at all, with spaces xxxxxxxxxxxx", "secretKey"],
      ["test", "sk_test_short", "secretKey"],
      ["test", 12345, "secretKey"],
      ["live", PK_TEST, "publishableKey"],
      ["test", SK_TEST, "webhookSecret"]
    ];
    for (const [mode, value, field] of bad) {
      assert.throws(
        () => saveKeys(ctx, ACTOR, mode, { [field]: value } as never),
        (e: unknown) => {
          assert.ok(e instanceof StripeError);
          assert.equal((e as StripeError).statusCode, 400);
          assertNoKeys((e as Error).message, "error message");
          return true;
        },
        `${mode}/${field}`
      );
    }
    assert.throws(() => saveKeys(ctx, ACTOR, "banana", { secretKey: SK_TEST }), /mode must be/);
    assert.throws(() => saveKeys(ctx, ACTOR, "test", {}), /at least one/);
    assert.equal((getStatus(ctx) as any).modes.test.secret_key.configured, false, "nothing stored on failure");
  });

  test("keys are encrypted at rest and the status shows only a masked preview and fingerprint", () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST, webhookSecret: WHSEC_MANUAL });
    const rows = ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'stripe_%'").all() as Array<{ key: string; value: string }>;
    assert.ok(rows.length >= 3);
    for (const r of rows) assertNoKeys(r.value, `settings row ${r.key}`);
    const status = getStatus(ctx) as any;
    assert.match(status.modes.test.secret_key.preview, /^sk_test_…[A-Za-z0-9]{4}$/);
    assert.match(status.modes.test.webhook_secret.preview, /^whsec_…/);
    assert.match(status.modes.test.secret_key.fingerprint, /^[0-9a-f]{12}$/);
    assertNoKeysAnywhere();
  });

  test("replace changes the fingerprint; remove clears one part or everything; a part must be named", () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST });
    const before = (getStatus(ctx) as any).modes.test.secret_key.fingerprint;
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST_2 });
    assert.notEqual((getStatus(ctx) as any).modes.test.secret_key.fingerprint, before);
    removeKeys(ctx, ACTOR, "test", "publishable_key");
    assert.equal((getStatus(ctx) as any).modes.test.publishable_key.configured, false);
    assert.equal((getStatus(ctx) as any).modes.test.secret_key.configured, true);
    assert.throws(() => removeKeys(ctx, ACTOR, "test", undefined), /part must be/);
    removeKeys(ctx, ACTOR, "test", "all");
    assert.equal((getStatus(ctx) as any).modes.test.secret_key.configured, false);
    assertNoKeysAnywhere();
  });

  test("redact scrubs anything key-shaped from free text", () => {
    assert.equal(redact(`bad ${SK_TEST} and ${WHSEC_MANUAL} and ${PK_LIVE}`), "bad [redacted] and [redacted] and [redacted]");
  });

  test("form encoding follows Stripe's nested rules", () => {
    assert.equal(
      decodeURIComponent(encodeForm({ a: "1", b: { c: true }, d: ["x", "y"], "e[f]": 5, skip: undefined, nul: null })),
      "a=1&b[c]=true&d[0]=x&d[1]=y&e[f]=5"
    );
  });
});

describe("verify", () => {
  test("returns account state, calls Stripe safely and caches the result", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
    const stripe = makeStripe();
    const account = await verifyKeys(ctx, ACTOR, "test", { fetch: stripe.fetch });
    assert.equal(account.id, "acct_fake123");
    assert.equal(account.name, "Fake Aim Co");
    assert.equal(account.country, "DK");
    assert.equal(account.default_currency, "eur");
    assert.equal(account.charges_enabled, false);
    assert.equal(account.details_submitted, false);
    assert.deepEqual(account.currently_due, ["business_profile.url", "external_account"]);
    assert.equal(account.livemode, false);
    const call = stripe.calls[0];
    assert.equal(call.auth, `Bearer ${SK_TEST}`);
    assert.equal(call.redirect, "error", "redirects are refused");
    assert.equal((getStatus(ctx) as any).modes.test.account.id, "acct_fake123", "cached for the status page");
    assertNoKeysAnywhere();
  });

  test("a mode mismatch reported by Stripe is rejected", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
    await assert.rejects(verifyKeys(ctx, ACTOR, "test", { fetch: makeStripe({ livemode: true }).fetch }), (e: any) => e.code === "mode_mismatch" && e.statusCode === 409);
  });

  test("Stripe failures surface only type and code, never the key, and never as 401", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
    await assert.rejects(
      verifyKeys(ctx, ACTOR, "test", { fetch: makeStripe({ accountStatus: 401 }).fetch }),
      (e: any) => {
        assert.equal(e.code, "stripe_error");
        assert.equal(e.meta.stripe_type, "invalid_request_error");
        assert.equal(e.meta.stripe_code, "api_key_expired");
        assert.notEqual(e.statusCode, 401, "a 401 would log the dashboard user out");
        assertNoKeys(e.message, "error");
        assertNoKeys(e.meta, "error meta");
        return true;
      }
    );
    await assert.rejects(verifyKeys(ctx, ACTOR, "test", { fetch: makeStripe({ netFail: true }).fetch }), (e: any) => e.meta.stripe_type === "network_error" && e.statusCode === 502);
    assertNoKeysAnywhere();
  });

  test("verify without a stored key says so", async () => {
    await assert.rejects(verifyKeys(ctx, ACTOR, "live", { fetch: makeStripe().fetch }), (e: any) => e.code === "secret_key_missing");
  });
});

describe("connecting apps", () => {
  const envOf = (id: string) => getServiceEnv(ctx, id);

  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST, webhookSecret: WHSEC_MANUAL });
  });

  test("injects encrypted system env and STRIPE_MODE; nothing else is touched", () => {
    ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('x','svc-coach','BILLING_ENABLED','false',0,0)").run();
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    assert.deepEqual(r.env.sort(), ["STRIPE_MODE", "STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    assert.equal(r.mode, "test");
    assert.equal(r.restart_needed, true);
    const env = envOf("svc-coach");
    assert.equal(env.STRIPE_SECRET_KEY, SK_TEST);
    assert.equal(env.STRIPE_PUBLISHABLE_KEY, PK_TEST);
    assert.equal(env.STRIPE_WEBHOOK_SECRET, WHSEC_MANUAL);
    assert.equal(env.STRIPE_MODE, "test");
    assert.equal(env.BILLING_ENABLED, "false", "app feature flags are untouched");
    const rows = ctx.db.prepare("SELECT key, value, is_secret, system FROM env_vars WHERE key LIKE 'STRIPE_%'").all() as any[];
    for (const row of rows) {
      assert.equal(row.system, 1);
      if (row.key !== "STRIPE_MODE") {
        assert.equal(row.is_secret, 1);
        assertNoKeys(row.value, `env row ${row.key}`);
      }
    }
    assertNoKeys(r, "connect result");
    assertNoKeysAnywhere();
  });

  test("a service that defines the variables itself needs an explicit takeover", () => {
    ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('p1','svc-coach','STRIPE_SECRET_KEY','placeholder',0,0)").run();
    ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('p2','svc-coach','STRIPE_PRICE_ID','price_keep',0,0)").run();
    assert.throws(() => connectApp(ctx, ACTOR, { serviceId: "svc-coach" }), (e: any) => e.code === "env_conflict" && e.statusCode === 409 && e.meta.conflicts[0] === "STRIPE_SECRET_KEY");
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, "placeholder", "nothing changed on conflict");
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach", takeover: true });
    assert.deepEqual(r.replaced, ["STRIPE_SECRET_KEY"]);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_TEST);
    assert.equal(envOf("svc-coach").STRIPE_PRICE_ID, "price_keep", "only the managed variables are replaced");
  });

  test("live mode needs confirmLive and a stored live key", () => {
    assert.throws(() => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live" }), (e: any) => e.code === "live_confirmation_required");
    assert.throws(() => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: "true" }), (e: any) => e.code === "live_confirmation_required", "only boolean true counts");
    assert.throws(() => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true }), (e: any) => e.code === "secret_key_missing");
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true });
    assert.equal(envOf("svc-coach").STRIPE_MODE, "live");
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_LIVE);
    assert.ok(!r.env.includes("STRIPE_WEBHOOK_SECRET"), "no live webhook secret stored, none injected");
    const liveAudits = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE details LIKE '%mode=live%'").get() as { n: number };
    assert.ok(liveAudits.n >= 1, "live connect is audited");
    assertNoKeysAnywhere();
  });

  test("the default mode is test", () => {
    assert.equal(connectApp(ctx, ACTOR, { serviceId: "svc-web" }).mode, "test");
  });

  test("rotating a key updates connected apps and flags a running app for restart", () => {
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    connectApp(ctx, ACTOR, { serviceId: "svc-web" });
    // simulate the app having started after the connect
    ctx.db.prepare("UPDATE services SET last_started_at = '2999-01-01T00:00:00.000Z' WHERE id = 'svc-coach'").run();
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.restart_needed, false);
    const r = saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST_2 });
    assert.deepEqual(r.apps_updated.sort(), ["svc-coach", "svc-web"]);
    assert.equal(r.restart_needed, true);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_TEST_2);
    assert.equal(envOf("svc-web").STRIPE_SECRET_KEY, SK_TEST_2);
    ctx.db.prepare("UPDATE services SET last_started_at = '1999-01-01T00:00:00.000Z' WHERE id = 'svc-coach'").run();
    const apps = listApps(ctx);
    assert.equal(apps.find((a) => a.service_id === "svc-coach")!.restart_needed, true);
    assert.equal(apps.find((a) => a.service_id === "svc-web")!.restart_needed, false, "a stopped app reads the new env when it starts");
    assertNoKeysAnywhere();
  });

  test("removing the secret key disconnects apps and strips their env; removing the webhook secret only trims it", () => {
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    removeKeys(ctx, ACTOR, "test", "webhook_secret");
    assert.equal(envOf("svc-coach").STRIPE_WEBHOOK_SECRET, undefined);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_TEST);
    const r = removeKeys(ctx, ACTOR, "test", "secret_key");
    assert.deepEqual(r.apps_disconnected, ["svc-coach"]);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, undefined);
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.connected, false);
  });

  test("disconnect removes the injected env, including extra vars, and keeps the owner's own", () => {
    ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('o','svc-coach','OWN_VAR','1',0,0)").run();
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    disconnectApp(ctx, ACTOR, "svc-coach");
    const env = envOf("svc-coach");
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(env.STRIPE_MODE, undefined);
    assert.equal(env.OWN_VAR, "1");
    assert.throws(() => disconnectApp(ctx, ACTOR, "svc-coach"), (e: any) => e.code === "not_connected");
  });

  test("unknown service is a 404", () => {
    assert.throws(() => connectApp(ctx, ACTOR, { serviceId: "nope" }), (e: any) => e.statusCode === 404);
  });
});

describe("product and price", () => {
  const coach = (extra: Record<string, unknown> = {}) => ({
    mode: "test", name: "OpenAim Coach", unitAmount: 900, currency: "EUR", interval: "month", taxBehavior: "inclusive", lookupKey: "openaim_coach_monthly", ...extra
  });
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });

  test("creates a deterministic product and the recurring tax-inclusive price, then is a no-op on retry", async () => {
    const stripe = makeStripe();
    const first = await ensureProductPrice(ctx, ACTOR, coach(), { fetch: stripe.fetch });
    assert.equal(first.created, true);
    assert.equal(first.product.id, "sh_openaim_coach_monthly");
    assert.deepEqual(first.price, { id: "price_1", lookup_key: "openaim_coach_monthly", unit_amount: 900, currency: "eur", interval: "month", tax_behavior: "inclusive" });
    const priceCall = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/prices")!;
    assert.equal(priceCall.form.get("recurring[interval]"), "month");
    assert.equal(priceCall.form.get("tax_behavior"), "inclusive");
    assert.equal(priceCall.form.get("currency"), "eur");
    assert.ok(priceCall.idem && priceCall.idem.startsWith("sh-price-test-"), "an idempotency key guards concurrent retries");
    assert.equal(stripe.writes().length, 2, "one product, one price");

    const second = await ensureProductPrice(ctx, ACTOR, coach(), { fetch: stripe.fetch });
    assert.equal(second.created, false);
    assert.equal(second.price.id, "price_1");
    assert.equal(stripe.writes().length, 2, "no further writes");
    assert.equal((getStatus(ctx) as any).modes.test.setup.prices.openaim_coach_monthly.price, "price_1");
  });

  test("a price that exists with different terms is reported, never silently changed or duplicated", async () => {
    const stripe = makeStripe();
    await ensureProductPrice(ctx, ACTOR, coach(), { fetch: stripe.fetch });
    const writes = stripe.writes().length;
    await assert.rejects(
      ensureProductPrice(ctx, ACTOR, coach({ unitAmount: 1200, taxBehavior: "exclusive" }), { fetch: stripe.fetch }),
      (e: any) => e.code === "price_conflict" && e.statusCode === 409 && e.meta.mismatches.length === 2
    );
    assert.equal(stripe.writes().length, writes);
  });

  test("validates every input before any network call", async () => {
    const stripe = makeStripe();
    const bad: Array<Record<string, unknown>> = [
      { name: "" }, { unitAmount: 9.5 }, { unitAmount: 0 }, { unitAmount: "900" }, { currency: "euro" },
      { interval: "fortnight" }, { taxBehavior: "maybe" }, { taxBehavior: undefined }, { lookupKey: "A B" }, { priceEnvName: "lowercase" }
    ];
    for (const patch of bad) {
      await assert.rejects(ensureProductPrice(ctx, ACTOR, coach(patch), { fetch: stripe.fetch }), (e: any) => e.code === "invalid_input", JSON.stringify(patch));
    }
    assert.equal(stripe.calls.length, 0);
  });

  test("live needs confirmLive and makes no call without it", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const stripe = makeStripe();
    await assert.rejects(ensureProductPrice(ctx, ACTOR, coach({ mode: "live" }), { fetch: stripe.fetch }), (e: any) => e.code === "live_confirmation_required");
    assert.equal(stripe.calls.length, 0, "refused before touching Stripe");
    const ok = await ensureProductPrice(ctx, ACTOR, coach({ mode: "live", confirmLive: true }), { fetch: stripe.fetch });
    assert.equal(ok.mode, "live");
    assert.equal(stripe.calls[0].auth, `Bearer ${SK_LIVE}`);
    assertNoKeysAnywhere();
  });

  test("writes the price id into a connected app under the chosen name, and only in the same mode", async () => {
    const stripe = makeStripe();
    await assert.rejects(ensureProductPrice(ctx, ACTOR, coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" }), { fetch: stripe.fetch }), (e: any) => e.code === "not_connected");
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    const r = await ensureProductPrice(ctx, ACTOR, coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" }), { fetch: stripe.fetch });
    assert.deepEqual(r.injected, { service_id: "svc-coach", env: "STRIPE_PRICE_ID" });
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_PRICE_ID, "price_1");
    await assert.rejects(ensureProductPrice(ctx, ACTOR, coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_SECRET_KEY" }), { fetch: stripe.fetch }), (e: any) => e.code === "invalid_env_name");
    disconnectApp(ctx, ACTOR, "svc-coach");
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_PRICE_ID, undefined, "disconnect removes the price id it added");
  });
});

describe("webhook endpoint", () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });
  const hook = (extra: Record<string, unknown> = {}) => ({ mode: "test", url: "https://coach.example.com/v1/billing/webhook", ...extra });

  test("creates the endpoint, stores the signing secret encrypted, never returns it, and pushes it to connected apps", async () => {
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, undefined);
    const stripe = makeStripe();
    const r = await ensureWebhook(ctx, ACTOR, hook(), { fetch: stripe.fetch });
    assert.equal(r.created, true);
    assert.equal(r.secret_stored, true);
    assert.deepEqual(r.apps_updated, ["svc-coach"]);
    assert.equal(r.restart_needed, true);
    assert.deepEqual(r.endpoint.events, [...new Set(r.endpoint.events)].sort());
    assertNoKeys(r, "webhook result");
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, WHSEC_CREATED);
    const stored = ctx.db.prepare("SELECT value FROM settings WHERE key = 'stripe_test_webhook_secret'").get() as { value: string };
    assertNoKeys(stored.value, "stored webhook secret");
    assertNoKeysAnywhere();
  });

  test("a second call is a no-op; a changed event list updates in place", async () => {
    const stripe = makeStripe();
    await ensureWebhook(ctx, ACTOR, hook(), { fetch: stripe.fetch });
    const writes = stripe.writes().length;
    const same = await ensureWebhook(ctx, ACTOR, hook(), { fetch: stripe.fetch });
    assert.equal(same.created, false);
    assert.equal(same.updated, false);
    assert.equal(same.secret_stored, true);
    assert.equal(stripe.writes().length, writes);
    const changed = await ensureWebhook(ctx, ACTOR, hook({ events: ["invoice.paid"] }), { fetch: stripe.fetch });
    assert.equal(changed.updated, true);
    assert.deepEqual(changed.endpoint.events, ["invoice.paid"]);
    assert.equal(stripe.state.hooks.length, 1, "never a second endpoint for the same URL");
  });

  test("an endpoint that already exists with no stored secret is reported, not guessed", async () => {
    const stripe = makeStripe();
    stripe.state.hooks.push({ id: "we_old", url: "https://coach.example.com/v1/billing/webhook", enabled_events: ["invoice.paid"], status: "enabled" });
    const r = await ensureWebhook(ctx, ACTOR, hook({ events: ["invoice.paid"] }), { fetch: stripe.fetch });
    assert.equal(r.created, false);
    assert.equal(r.secret_stored, false);
    assert.equal(r.secret_unavailable, true);
    assert.match(String(r.note), /only shows its signing secret at creation/);
  });

  test("rejects non-https, credentialed and malformed URLs and bad event names", async () => {
    const stripe = makeStripe();
    for (const url of ["http://coach.example.com/x", "https://user:pw@coach.example.com/x", "https://localhost/x", "nonsense", undefined]) {
      await assert.rejects(ensureWebhook(ctx, ACTOR, hook({ url }), { fetch: stripe.fetch }), (e: any) => e.code === "invalid_input", String(url));
    }
    await assert.rejects(ensureWebhook(ctx, ACTOR, hook({ events: ["Bad Event!"] }), { fetch: stripe.fetch }), (e: any) => e.code === "invalid_input");
    await assert.rejects(ensureWebhook(ctx, ACTOR, hook({ events: [] }), { fetch: stripe.fetch }), (e: any) => e.code === "invalid_input");
    assert.equal(stripe.calls.length, 0);
  });

  test("live needs confirmLive and makes no call without it", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const stripe = makeStripe();
    await assert.rejects(ensureWebhook(ctx, ACTOR, hook({ mode: "live" }), { fetch: stripe.fetch }), (e: any) => e.code === "live_confirmation_required");
    assert.equal(stripe.calls.length, 0);
  });
});

describe("customer portal", () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });

  test("creates a cancel-at-period-end configuration with payment-method updates, then updates it in place", async () => {
    const stripe = makeStripe();
    const first = await ensurePortal(ctx, ACTOR, { mode: "test", returnUrl: "https://coach.example.com/account" }, { fetch: stripe.fetch });
    assert.equal(first.created, true);
    const post = stripe.calls.find((c) => c.method === "POST")!;
    assert.equal(post.form.get("features[subscription_cancel][mode]"), "at_period_end");
    assert.equal(post.form.get("features[subscription_cancel][enabled]"), "true");
    assert.equal(post.form.get("features[payment_method_update][enabled]"), "true");
    assert.equal(post.form.get("default_return_url"), "https://coach.example.com/account");
    const second = await ensurePortal(ctx, ACTOR, { mode: "test" }, { fetch: stripe.fetch });
    assert.equal(second.created, false);
    assert.equal(stripe.state.portals.length, 1, "one managed configuration only");
  });

  test("rejects a non-https return URL and live without confirmation", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const stripe = makeStripe();
    await assert.rejects(ensurePortal(ctx, ACTOR, { mode: "test", returnUrl: "http://x.example.com" }, { fetch: stripe.fetch }), (e: any) => e.code === "invalid_input");
    await assert.rejects(ensurePortal(ctx, ACTOR, { mode: "live" }, { fetch: stripe.fetch }), (e: any) => e.code === "live_confirmation_required");
    assert.equal(stripe.calls.length, 0);
  });
});

describe("REST routes", () => {
  async function app(stripe = makeStripe()) {
    const server = Fastify();
    (ctx as { app: unknown }).app = server;
    registerStripeRoutes(ctx, { fetch: stripe.fetch });
    await server.ready();
    return { server, stripe };
  }

  test("/api/stripe is a gated API path", () => {
    assert.equal(isApiPath("/api/stripe/status"), true);
    assert.equal(isApiPath("/api/stripe/setup/webhook"), true);
  });

  test("full flow over HTTP never returns a key in any response, including errors", async () => {
    const { server, stripe } = await app();
    const bodies: string[] = [];
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await server.inject({ method: method as never, url, payload: payload as never });
      bodies.push(res.body);
      return res;
    };
    let res = await call("PUT", "/api/stripe/keys/test", { secretKey: SK_TEST, publishableKey: PK_TEST });
    assert.equal(res.statusCode, 200);
    res = await call("PUT", "/api/stripe/keys/test", { secretKey: SK_LIVE });
    assert.equal(res.statusCode, 400, "live key in the test slot");
    assert.equal(res.json().code, "wrong_key_type");
    res = await call("PUT", "/api/stripe/keys/test", { secretKey: { nested: SK_TEST } });
    assert.equal(res.statusCode, 400);
    res = await call("GET", "/api/stripe/status");
    assert.equal(res.json().modes.test.secret_key.configured, true);
    res = await call("POST", "/api/stripe/verify/test");
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().account.id, "acct_fake123");
    res = await call("POST", "/api/stripe/apps/svc-coach/connect", { mode: "test" });
    assert.equal(res.statusCode, 200);
    res = await call("POST", "/api/stripe/apps/svc-coach/connect", { mode: "live" });
    assert.equal(res.json().code, "live_confirmation_required");
    res = await call("GET", "/api/stripe/apps");
    assert.equal(res.json().apps.find((a: any) => a.service_id === "svc-coach").connected, true);
    res = await call("POST", "/api/stripe/setup/product-price", { mode: "test", name: "Coach", unitAmount: 900, currency: "eur", interval: "month", taxBehavior: "inclusive", lookupKey: "openaim_coach_monthly", serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" });
    assert.equal(res.statusCode, 200);
    res = await call("POST", "/api/stripe/setup/webhook", { mode: "test", url: "https://coach.example.com/v1/billing/webhook" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().secret_stored, true);
    res = await call("POST", "/api/stripe/setup/portal", { mode: "test" });
    assert.equal(res.statusCode, 200);
    res = await call("DELETE", "/api/stripe/keys/test");
    assert.equal(res.statusCode, 400, "a bare DELETE names no part and removes nothing");
    assert.equal(stripe.writes().length > 0, true);
    for (const b of bodies) assertNoKeys(b, "HTTP response body");
    assertNoKeysAnywhere();
    await server.close();
  });

  test("malformed bodies and unknown modes are client errors", async () => {
    const { server } = await app();
    assert.equal((await server.inject({ method: "PUT", url: "/api/stripe/keys/test", payload: [] as never })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: "/api/stripe/verify/staging" })).statusCode, 400);
    await server.close();
  });
});

describe("MCP tools", () => {
  async function connect() {
    const stripe = makeStripe();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerStripeMcpTools(ctx, server, "session:abc", { fetch: stripe.fetch });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(clientT);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(r.isError), text: r.content[0].text };
    };
    return { client, call, stripe, close: async () => { await client.close(); await server.close(); } };
  }

  test("exposes exactly the intended tools and none that accept key material", async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["stripe_connect_app", "stripe_disconnect_app", "stripe_ensure_portal", "stripe_ensure_product_price", "stripe_ensure_webhook", "stripe_list_apps", "stripe_status", "stripe_verify"]
    );
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props) assert.ok(!/key$|secret|token|password/i.test(p) || p === "lookupKey", `${t.name} must not accept ${p}`);
    }
    await close();
  });

  test("status, verify, connect and setup work and never return a key", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST });
    const { call, close } = await connect();
    const outputs: string[] = [];
    for (const [name, args] of [
      ["stripe_status", {}],
      ["stripe_verify", {}],
      ["stripe_connect_app", { service: "Coach" }],
      ["stripe_list_apps", {}],
      ["stripe_ensure_product_price", { name: "Coach", unitAmount: 900, currency: "eur", interval: "month", taxBehavior: "inclusive", lookupKey: "openaim_coach_monthly", service: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" }],
      ["stripe_ensure_webhook", { url: "https://coach.example.com/v1/billing/webhook" }],
      ["stripe_ensure_portal", {}],
      ["stripe_disconnect_app", { service: "svc-coach" }]
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
      outputs.push(r.text);
    }
    for (const o of outputs) assertNoKeys(o, "MCP output");
    assertNoKeysAnywhere();
    await close();
  });

  test("live writes need confirmLive and the audit trail names the MCP actor", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const { call, stripe, close } = await connect();
    const denied = await call("stripe_ensure_webhook", { mode: "live", url: "https://coach.example.com/hook" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /confirmLive/);
    assert.equal((await call("stripe_connect_app", { service: "Coach", mode: "live" })).isError, true);
    assert.equal(stripe.calls.length, 0, "no Stripe call and no env change without confirmation");
    const ok = await call("stripe_ensure_portal", { mode: "live", confirmLive: true });
    assert.equal(ok.isError, false);
    const actors = ctx.db.prepare("SELECT DISTINCT actor FROM audit_logs").all() as Array<{ actor: string }>;
    assert.ok(actors.some((a) => a.actor === "mcp:session:abc"));
    await close();
  });

  test("an unknown service is reported without leaking anything", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
    const { call, close } = await connect();
    const r = await call("stripe_connect_app", { service: "does-not-exist" });
    assert.equal(r.isError, true);
    assertNoKeys(r.text);
    await close();
  });
});
