/**
 * Stripe tab: key validation/storage, verification, app wiring, idempotent setup
 * helpers, REST routes and MCP tools. Stripe's HTTP is replaced by an in-memory
 * fake injected through `deps.fetch`; nothing here can reach the real Stripe API.
 * All "keys" are obviously fake strings built at runtime.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { beforeEach, describe } from "node:test";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./types.js";
import {
  DEFAULT_ORG_API_VERSION,
  ORG_KEY_PERMISSIONS,
  StripeError,
  connectApp,
  disconnectApp,
  encodeForm,
  ensurePortal,
  ensureProductPrice,
  ensureWebhook,
  getStatus,
  listApps,
  orgApiVersion,
  redact,
  removeKeys,
  saveKeys,
  setAppAccount,
  verifyKeys,
  verifyOrgKey
} from "./services/stripe.js";
import { getServiceEnv } from "./lib/core.js";
import { isApiPath } from "./routes/auth.js";
import { registerStripeRoutes } from "./routes/stripe.js";
import { registerStripeMcpTools } from "./routes/mcpStripe.js";

// node:sqlite needs Node 22.5+. CI still runs Node 20, where these tests skip instead of failing to load.
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  /* not available on this Node version */
}
const skip = sqlite ? false : "node:sqlite is not available on this Node version (needs 22.5+)";

// ---- fake credentials (never real) ----------------------------------------
const SK_TEST = "sk_test_" + "A1b2C3d4".repeat(4);
const SK_TEST_2 = "sk_test_" + "Q9w8E7r6".repeat(4);
const SK_LIVE = "sk_live_" + "Z9y8X7w6".repeat(4);
const RK_TEST = "rk_test_" + "M5n4B3v2".repeat(4);
const PK_TEST = "pk_test_" + "P1o2I3u4".repeat(4);
const PK_LIVE = "pk_live_" + "L1k2J3h4".repeat(4);
const WHSEC_MANUAL = "whsec_" + "H4n5D6l7".repeat(3);
const WHSEC_CREATED = "whsec_" + "N3w5Ecr3t".repeat(3);
const WHSEC_CREATED_2 = "whsec_" + "Sec0nd5ecr3t".repeat(2);
const SK_ORG = "sk_org_" + "O7r6G5k4".repeat(4);
const SK_ORG_2 = "sk_org_" + "V3t2B1n0".repeat(4);
const ALL_KEYS = [
  SK_TEST,
  SK_TEST_2,
  SK_LIVE,
  RK_TEST,
  PK_TEST,
  PK_LIVE,
  WHSEC_MANUAL,
  WHSEC_CREATED,
  WHSEC_CREATED_2,
  SK_ORG,
  SK_ORG_2
];

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
  extra_env_json TEXT NOT NULL DEFAULT '[]',
  stripe_account_id TEXT, webhook_secret TEXT, verify_json TEXT, setup_json TEXT
);
`;

let ctx: AppContext;

function makeContext(schema: string = SCHEMA): AppContext {
  const db = new sqlite!.DatabaseSync(":memory:");
  db.exec(schema);
  const add = db.prepare(
    "INSERT INTO services (id, project_id, name, type, status, last_started_at) VALUES (?, 'p1', ?, ?, ?, ?)"
  );
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
  if (sqlite) ctx = makeContext();
});

// ---- fake Stripe -----------------------------------------------------------
type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  auth: string;
  redirect: unknown;
  idem: string | null;
  version: string | null;
  context: string | null;
};

type FakeAccount = { prices: any[]; products: Map<string, any>; hooks: any[]; portals: any[] };
const newAccount = (): FakeAccount => ({
  prices: [],
  products: new Map<string, any>(),
  hooks: [],
  portals: []
});

type StripeOpts = {
  accountStatus?: number; // errors for the key's own account (no Stripe-Context)
  livemode?: boolean; // livemode reported for the key's own account
  netFail?: boolean;
  orgStatus?: number; // errors for /v1/account addressed with Stripe-Context
  orgLivemode?: boolean; // livemode reported for a member account
  writeLivemode?: boolean; // livemode stamped on objects created through the org key
  wrongAccount?: boolean; // answer for a different account than the one asked for
};

function makeStripe(opts: StripeOpts = {}) {
  const calls: Call[] = [];
  // `state` is the key's own account (no context); `accounts[acct]` are member accounts reached with Stripe-Context.
  const state = newAccount();
  const accounts: Record<string, FakeAccount> = {};
  let n = 0;
  let hooksCreated = 0;
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
    const context = headers["Stripe-Context"] ?? null;
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      form,
      auth: headers.Authorization ?? "",
      redirect: init?.redirect,
      idem: headers["Idempotency-Key"] ?? null,
      version: headers["Stripe-Version"] ?? null,
      context
    };
    calls.push(call);
    assert.equal(url.origin, "https://api.stripe.com", "only api.stripe.com is ever contacted");
    const send = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const st = context ? (accounts[context] ??= newAccount()) : state;
    const lm = () => (context && opts.writeLivemode !== undefined ? { livemode: opts.writeLivemode } : {});
    const p = url.pathname;
    if (p === "/v1/account") {
      if (context && opts.orgStatus && opts.orgStatus !== 200) {
        return send(opts.orgStatus, {
          error: {
            type: "invalid_request_error",
            code: opts.orgStatus === 401 ? "api_key_invalid" : "forbidden",
            message: `Denied for ${call.auth}`
          }
        });
      }
      if (!context && opts.accountStatus && opts.accountStatus !== 200) {
        return send(opts.accountStatus, {
          error: {
            type: "invalid_request_error",
            code: "api_key_expired",
            message: `Expired key: ${call.auth}`
          }
        });
      }
      const live = context ? opts.orgLivemode : opts.livemode;
      return send(200, {
        id: context ? (opts.wrongAccount ? "acct_someoneelse" : context) : "acct_fake123",
        business_profile: { name: context ? `Fake ${context}` : "Fake Aim Co" },
        country: "DK",
        default_currency: "eur",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: { currently_due: ["business_profile.url", "external_account"] },
        ...(live === undefined ? {} : { livemode: live })
      });
    }
    if (p === "/v1/prices" && method === "GET") {
      const key = call.query.get("lookup_keys[0]");
      return send(200, { data: st.prices.filter((x) => x.lookup_key === key) });
    }
    if (p === "/v1/prices" && method === "POST") {
      const price = {
        id: `price_${++n}`,
        product: form.get("product"),
        unit_amount: Number(form.get("unit_amount")),
        currency: form.get("currency"),
        recurring: { interval: form.get("recurring[interval]"), interval_count: 1 },
        tax_behavior: form.get("tax_behavior"),
        lookup_key: form.get("lookup_key"),
        ...lm()
      };
      st.prices.push(price);
      return send(200, price);
    }
    const prod = p.match(/^\/v1\/products\/(.+)$/);
    if (prod && method === "GET") {
      const found = st.products.get(decodeURIComponent(prod[1]));
      return found
        ? send(200, found)
        : send(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    }
    if (prod && method === "POST") {
      const found = st.products.get(decodeURIComponent(prod[1]));
      found.name = form.get("name");
      return send(200, found);
    }
    if (p === "/v1/products" && method === "POST") {
      const product = { id: form.get("id"), name: form.get("name"), ...lm() };
      st.products.set(String(product.id), product);
      return send(200, product);
    }
    if (p === "/v1/webhook_endpoints" && method === "GET") return send(200, { data: st.hooks });
    if (p === "/v1/webhook_endpoints" && method === "POST") {
      const secret = ++hooksCreated === 1 ? WHSEC_CREATED : WHSEC_CREATED_2;
      const hook = {
        id: `we_${++n}`,
        url: form.get("url"),
        enabled_events: listFrom(form, "enabled_events"),
        status: "enabled",
        secret,
        ...lm()
      };
      st.hooks.push({ ...hook, secret: undefined }); // Stripe only reveals the secret on creation
      return send(200, hook);
    }
    const hookUpdate = p.match(/^\/v1\/webhook_endpoints\/(.+)$/);
    if (hookUpdate && method === "POST") {
      const hook = st.hooks.find((h) => h.id === hookUpdate[1]);
      hook.enabled_events = listFrom(form, "enabled_events");
      return send(200, hook);
    }
    if (p === "/v1/billing_portal/configurations" && method === "GET") return send(200, { data: st.portals });
    if (p === "/v1/billing_portal/configurations" && method === "POST") {
      const cfg = {
        id: `bpc_${++n}`,
        active: true,
        metadata: { serverhoster: form.get("metadata[serverhoster]") },
        default_return_url: form.get("default_return_url"),
        ...lm()
      };
      st.portals.push(cfg);
      return send(200, cfg);
    }
    const portalUpdate = p.match(/^\/v1\/billing_portal\/configurations\/(.+)$/);
    if (portalUpdate && method === "POST")
      return send(
        200,
        st.portals.find((c) => c.id === portalUpdate[1])
      );
    return send(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
  }) as typeof fetch;
  return { fetch: impl, calls, state, accounts, writes: () => calls.filter((c) => c.method !== "GET") };
}

// ---- no-leak helpers --------------------------------------------------------
const KEYISH = /\b(?:(?:sk|rk|pk)_(?:test|live)_|(?:sk|rk)_org_|whsec_)[A-Za-z0-9_]+/;

function assertNoKeys(value: unknown, label = "value"): void {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
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
  // The link rows hold the per-app webhook secret (encrypted) and verification results: no key shapes either.
  assertNoKeys(ctx.db.prepare("SELECT * FROM stripe_app_links").all(), "stripe_app_links");
  assertNoKeys(
    ctx.db.prepare("SELECT key, value FROM env_vars WHERE system = 1 AND is_secret = 1").all(),
    "encrypted env rows"
  );
}

const ACTOR = "test-actor";

// ---------------------------------------------------------------------------

describe("key validation and storage", { skip }, () => {
  test("accepts correct prefixes per mode, including restricted keys", () => {
    saveKeys(ctx, ACTOR, "test", {
      secretKey: SK_TEST,
      publishableKey: PK_TEST,
      webhookSecret: WHSEC_MANUAL
    });
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
    assert.equal(
      (getStatus(ctx) as any).modes.test.secret_key.configured,
      false,
      "nothing stored on failure"
    );
  });

  test("keys are encrypted at rest and the status shows only a masked preview and fingerprint", () => {
    saveKeys(ctx, ACTOR, "test", {
      secretKey: SK_TEST,
      publishableKey: PK_TEST,
      webhookSecret: WHSEC_MANUAL
    });
    const rows = ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'stripe_%'").all() as Array<{
      key: string;
      value: string;
    }>;
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
    assert.equal(
      redact(`bad ${SK_TEST} and ${WHSEC_MANUAL} and ${PK_LIVE}`),
      "bad [redacted] and [redacted] and [redacted]"
    );
  });

  test("form encoding follows Stripe's nested rules", () => {
    assert.equal(
      decodeURIComponent(
        encodeForm({ a: "1", b: { c: true }, d: ["x", "y"], "e[f]": 5, skip: undefined, nul: null })
      ),
      "a=1&b[c]=true&d[0]=x&d[1]=y&e[f]=5"
    );
  });
});

describe("verify", { skip }, () => {
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
    await assert.rejects(
      verifyKeys(ctx, ACTOR, "test", { fetch: makeStripe({ livemode: true }).fetch }),
      (e: any) => e.code === "mode_mismatch" && e.statusCode === 409
    );
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
    await assert.rejects(
      verifyKeys(ctx, ACTOR, "test", { fetch: makeStripe({ netFail: true }).fetch }),
      (e: any) => e.meta.stripe_type === "network_error" && e.statusCode === 502
    );
    assertNoKeysAnywhere();
  });

  test("verify without a stored key says so", async () => {
    await assert.rejects(
      verifyKeys(ctx, ACTOR, "live", { fetch: makeStripe().fetch }),
      (e: any) => e.code === "secret_key_missing"
    );
  });
});

describe("connecting apps", { skip }, () => {
  const envOf = (id: string) => getServiceEnv(ctx, id);

  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", {
      secretKey: SK_TEST,
      publishableKey: PK_TEST,
      webhookSecret: WHSEC_MANUAL
    });
  });

  test("injects encrypted system env and STRIPE_MODE; nothing else is touched", () => {
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('x','svc-coach','BILLING_ENABLED','false',0,0)"
      )
      .run();
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    assert.deepEqual(r.env.sort(), [
      "STRIPE_MODE",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET"
    ]);
    assert.equal(r.mode, "test");
    assert.equal(r.restart_needed, true);
    const env = envOf("svc-coach");
    assert.equal(env.STRIPE_SECRET_KEY, SK_TEST);
    assert.equal(env.STRIPE_PUBLISHABLE_KEY, PK_TEST);
    assert.equal(env.STRIPE_WEBHOOK_SECRET, WHSEC_MANUAL);
    assert.equal(env.STRIPE_MODE, "test");
    assert.equal(env.BILLING_ENABLED, "false", "app feature flags are untouched");
    const rows = ctx.db
      .prepare("SELECT key, value, is_secret, system FROM env_vars WHERE key LIKE 'STRIPE_%'")
      .all() as any[];
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
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('p1','svc-coach','STRIPE_SECRET_KEY','placeholder',0,0)"
      )
      .run();
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('p2','svc-coach','STRIPE_PRICE_ID','price_keep',0,0)"
      )
      .run();
    assert.throws(
      () => connectApp(ctx, ACTOR, { serviceId: "svc-coach" }),
      (e: any) =>
        e.code === "env_conflict" && e.statusCode === 409 && e.meta.conflicts[0] === "STRIPE_SECRET_KEY"
    );
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, "placeholder", "nothing changed on conflict");
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach", takeover: true });
    assert.deepEqual(r.replaced, ["STRIPE_SECRET_KEY"]);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_TEST);
    assert.equal(envOf("svc-coach").STRIPE_PRICE_ID, "price_keep", "only the managed variables are replaced");
  });

  test("live mode needs confirmLive and a stored live key", () => {
    assert.throws(
      () => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live" }),
      (e: any) => e.code === "live_confirmation_required"
    );
    assert.throws(
      () => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: "true" }),
      (e: any) => e.code === "live_confirmation_required",
      "only boolean true counts"
    );
    assert.throws(
      () => connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true }),
      (e: any) => e.code === "secret_key_missing"
    );
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const r = connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true });
    assert.equal(envOf("svc-coach").STRIPE_MODE, "live");
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_LIVE);
    assert.ok(!r.env.includes("STRIPE_WEBHOOK_SECRET"), "no live webhook secret stored, none injected");
    const liveAudits = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE details LIKE '%mode=live%'")
      .get() as { n: number };
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
    ctx.db
      .prepare("UPDATE services SET last_started_at = '2999-01-01T00:00:00.000Z' WHERE id = 'svc-coach'")
      .run();
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.restart_needed, false);
    const r = saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST_2 });
    assert.deepEqual(r.apps_updated.sort(), ["svc-coach", "svc-web"]);
    assert.equal(r.restart_needed, true);
    assert.equal(envOf("svc-coach").STRIPE_SECRET_KEY, SK_TEST_2);
    assert.equal(envOf("svc-web").STRIPE_SECRET_KEY, SK_TEST_2);
    ctx.db
      .prepare("UPDATE services SET last_started_at = '1999-01-01T00:00:00.000Z' WHERE id = 'svc-coach'")
      .run();
    const apps = listApps(ctx);
    assert.equal(apps.find((a) => a.service_id === "svc-coach")!.restart_needed, true);
    assert.equal(
      apps.find((a) => a.service_id === "svc-web")!.restart_needed,
      false,
      "a stopped app reads the new env when it starts"
    );
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
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('o','svc-coach','OWN_VAR','1',0,0)"
      )
      .run();
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    disconnectApp(ctx, ACTOR, "svc-coach");
    const env = envOf("svc-coach");
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(env.STRIPE_MODE, undefined);
    assert.equal(env.OWN_VAR, "1");
    assert.throws(
      () => disconnectApp(ctx, ACTOR, "svc-coach"),
      (e: any) => e.code === "not_connected"
    );
  });

  test("unknown service is a 404", () => {
    assert.throws(
      () => connectApp(ctx, ACTOR, { serviceId: "nope" }),
      (e: any) => e.statusCode === 404
    );
  });
});

describe("product and price", { skip }, () => {
  const coach = (extra: Record<string, unknown> = {}) => ({
    mode: "test",
    name: "OpenAim Coach",
    unitAmount: 900,
    currency: "EUR",
    interval: "month",
    taxBehavior: "inclusive",
    lookupKey: "openaim_coach_monthly",
    ...extra
  });
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });

  test("creates a deterministic product and the recurring tax-inclusive price, then is a no-op on retry", async () => {
    const stripe = makeStripe();
    const first = await ensureProductPrice(ctx, ACTOR, coach(), { fetch: stripe.fetch });
    assert.equal(first.created, true);
    assert.equal(first.product.id, "sh_openaim_coach_monthly");
    assert.deepEqual(first.price, {
      id: "price_1",
      lookup_key: "openaim_coach_monthly",
      unit_amount: 900,
      currency: "eur",
      interval: "month",
      tax_behavior: "inclusive"
    });
    const priceCall = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/prices")!;
    assert.equal(priceCall.form.get("recurring[interval]"), "month");
    assert.equal(priceCall.form.get("tax_behavior"), "inclusive");
    assert.equal(priceCall.form.get("currency"), "eur");
    assert.ok(
      priceCall.idem && priceCall.idem.startsWith("sh-price-test-"),
      "an idempotency key guards concurrent retries"
    );
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
      ensureProductPrice(ctx, ACTOR, coach({ unitAmount: 1200, taxBehavior: "exclusive" }), {
        fetch: stripe.fetch
      }),
      (e: any) => e.code === "price_conflict" && e.statusCode === 409 && e.meta.mismatches.length === 2
    );
    assert.equal(stripe.writes().length, writes);
  });

  test("validates every input before any network call", async () => {
    const stripe = makeStripe();
    const bad: Array<Record<string, unknown>> = [
      { name: "" },
      { unitAmount: 9.5 },
      { unitAmount: 0 },
      { unitAmount: "900" },
      { currency: "euro" },
      { interval: "fortnight" },
      { taxBehavior: "maybe" },
      { taxBehavior: undefined },
      { lookupKey: "A B" },
      { priceEnvName: "lowercase" }
    ];
    for (const patch of bad) {
      await assert.rejects(
        ensureProductPrice(ctx, ACTOR, coach(patch), { fetch: stripe.fetch }),
        (e: any) => e.code === "invalid_input",
        JSON.stringify(patch)
      );
    }
    assert.equal(stripe.calls.length, 0);
  });

  test("live needs confirmLive and makes no call without it", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const stripe = makeStripe();
    await assert.rejects(
      ensureProductPrice(ctx, ACTOR, coach({ mode: "live" }), { fetch: stripe.fetch }),
      (e: any) => e.code === "live_confirmation_required"
    );
    assert.equal(stripe.calls.length, 0, "refused before touching Stripe");
    const ok = await ensureProductPrice(ctx, ACTOR, coach({ mode: "live", confirmLive: true }), {
      fetch: stripe.fetch
    });
    assert.equal(ok.mode, "live");
    assert.equal(stripe.calls[0].auth, `Bearer ${SK_LIVE}`);
    assertNoKeysAnywhere();
  });

  test("writes the price id into a connected app under the chosen name, and only in the same mode", async () => {
    const stripe = makeStripe();
    await assert.rejects(
      ensureProductPrice(ctx, ACTOR, coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" }), {
        fetch: stripe.fetch
      }),
      (e: any) => e.code === "not_connected"
    );
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    const r = await ensureProductPrice(
      ctx,
      ACTOR,
      coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" }),
      { fetch: stripe.fetch }
    );
    assert.deepEqual(r.injected, { service_id: "svc-coach", env: "STRIPE_PRICE_ID" });
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_PRICE_ID, "price_1");
    await assert.rejects(
      ensureProductPrice(ctx, ACTOR, coach({ serviceId: "svc-coach", priceEnvName: "STRIPE_SECRET_KEY" }), {
        fetch: stripe.fetch
      }),
      (e: any) => e.code === "invalid_env_name"
    );
    disconnectApp(ctx, ACTOR, "svc-coach");
    assert.equal(
      getServiceEnv(ctx, "svc-coach").STRIPE_PRICE_ID,
      undefined,
      "disconnect removes the price id it added"
    );
  });
});

describe("webhook endpoint", { skip }, () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });
  const hook = (extra: Record<string, unknown> = {}) => ({
    mode: "test",
    url: "https://coach.example.com/v1/billing/webhook",
    ...extra
  });

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
    const stored = ctx.db
      .prepare("SELECT value FROM settings WHERE key = 'stripe_test_webhook_secret'")
      .get() as { value: string };
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
    const changed = await ensureWebhook(ctx, ACTOR, hook({ events: ["invoice.paid"] }), {
      fetch: stripe.fetch
    });
    assert.equal(changed.updated, true);
    assert.deepEqual(changed.endpoint.events, ["invoice.paid"]);
    assert.equal(stripe.state.hooks.length, 1, "never a second endpoint for the same URL");
  });

  test("an endpoint that already exists with no stored secret is reported, not guessed", async () => {
    const stripe = makeStripe();
    stripe.state.hooks.push({
      id: "we_old",
      url: "https://coach.example.com/v1/billing/webhook",
      enabled_events: ["invoice.paid"],
      status: "enabled"
    });
    const r = await ensureWebhook(ctx, ACTOR, hook({ events: ["invoice.paid"] }), { fetch: stripe.fetch });
    assert.equal(r.created, false);
    assert.equal(r.secret_stored, false);
    assert.equal(r.secret_unavailable, true);
    assert.match(String(r.note), /only shows its signing secret at creation/);
  });

  test("rejects non-https, credentialed and malformed URLs and bad event names", async () => {
    const stripe = makeStripe();
    for (const url of [
      "http://coach.example.com/x",
      "https://user:pw@coach.example.com/x",
      "https://localhost/x",
      "nonsense",
      undefined
    ]) {
      await assert.rejects(
        ensureWebhook(ctx, ACTOR, hook({ url }), { fetch: stripe.fetch }),
        (e: any) => e.code === "invalid_input",
        String(url)
      );
    }
    await assert.rejects(
      ensureWebhook(ctx, ACTOR, hook({ events: ["Bad Event!"] }), { fetch: stripe.fetch }),
      (e: any) => e.code === "invalid_input"
    );
    await assert.rejects(
      ensureWebhook(ctx, ACTOR, hook({ events: [] }), { fetch: stripe.fetch }),
      (e: any) => e.code === "invalid_input"
    );
    assert.equal(stripe.calls.length, 0);
  });

  test("live needs confirmLive and makes no call without it", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    const stripe = makeStripe();
    await assert.rejects(
      ensureWebhook(ctx, ACTOR, hook({ mode: "live" }), { fetch: stripe.fetch }),
      (e: any) => e.code === "live_confirmation_required"
    );
    assert.equal(stripe.calls.length, 0);
  });
});

describe("customer portal", { skip }, () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });

  test("creates a cancel-at-period-end configuration with payment-method updates, then updates it in place", async () => {
    const stripe = makeStripe();
    const first = await ensurePortal(
      ctx,
      ACTOR,
      { mode: "test", returnUrl: "https://coach.example.com/account" },
      { fetch: stripe.fetch }
    );
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
    await assert.rejects(
      ensurePortal(ctx, ACTOR, { mode: "test", returnUrl: "http://x.example.com" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "invalid_input"
    );
    await assert.rejects(
      ensurePortal(ctx, ACTOR, { mode: "live" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "live_confirmation_required"
    );
    assert.equal(stripe.calls.length, 0);
  });
});

describe("REST routes", { skip }, () => {
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
    res = await call("POST", "/api/stripe/setup/product-price", {
      mode: "test",
      name: "Coach",
      unitAmount: 900,
      currency: "eur",
      interval: "month",
      taxBehavior: "inclusive",
      lookupKey: "openaim_coach_monthly",
      serviceId: "svc-coach",
      priceEnvName: "STRIPE_PRICE_ID"
    });
    assert.equal(res.statusCode, 200);
    res = await call("POST", "/api/stripe/setup/webhook", {
      mode: "test",
      url: "https://coach.example.com/v1/billing/webhook"
    });
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
    assert.equal(
      (await server.inject({ method: "PUT", url: "/api/stripe/keys/test", payload: [] as never })).statusCode,
      400
    );
    assert.equal(
      (await server.inject({ method: "POST", url: "/api/stripe/verify/staging" })).statusCode,
      400
    );
    await server.close();
  });
});

describe("MCP tools", { skip }, () => {
  async function connect() {
    const stripe = makeStripe();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerStripeMcpTools(ctx, server, "session:abc", { fetch: stripe.fetch });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(clientT);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: Boolean(r.isError), text: r.content[0].text };
    };
    return {
      client,
      call,
      stripe,
      close: async () => {
        await client.close();
        await server.close();
      }
    };
  }

  test("exposes exactly the intended tools and none that accept key material", async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "stripe_connect_app",
      "stripe_disconnect_app",
      "stripe_ensure_portal",
      "stripe_ensure_product_price",
      "stripe_ensure_webhook",
      "stripe_list_apps",
      "stripe_set_app_account",
      "stripe_status",
      "stripe_verify",
      "stripe_verify_org"
    ]);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props)
        assert.ok(
          !/key$|secret|token|password/i.test(p) || p === "lookupKey",
          `${t.name} must not accept ${p}`
        );
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
      [
        "stripe_ensure_product_price",
        {
          name: "Coach",
          unitAmount: 900,
          currency: "eur",
          interval: "month",
          taxBehavior: "inclusive",
          lookupKey: "openaim_coach_monthly",
          service: "svc-coach",
          priceEnvName: "STRIPE_PRICE_ID"
        }
      ],
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
    const denied = await call("stripe_ensure_webhook", {
      mode: "live",
      url: "https://coach.example.com/hook"
    });
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

// ===========================================================================
// Organization master key
// ===========================================================================

const ACCT_A = "acct_1AaAaAaAaAaA"; // the Coach app's member account
const ACCT_B = "acct_1BbBbBbBbBbB"; // the Web app's member account
const PRICE = {
  name: "OpenAim Coach",
  unitAmount: 900,
  currency: "eur",
  interval: "month",
  taxBehavior: "inclusive",
  lookupKey: "openaim_coach_monthly"
};
const HOOK_A = "https://coach.example.com/v1/billing/webhook";
const HOOK_B = "https://web.example.com/stripe/webhook";
const covers = (allowed: readonly string[], path: string) =>
  allowed.some((a) => path === a || path.startsWith(a + "/"));

/** Test-slot org key + account keys, both apps connected, each in its own member account. */
function orgSetup() {
  saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST, orgKey: SK_ORG });
  connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
  connectApp(ctx, ACTOR, { serviceId: "svc-web" });
  setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A);
  setAppAccount(ctx, ACTOR, "svc-web", ACCT_B);
}
const verifyOrg = (stripe: ReturnType<typeof makeStripe>, account = ACCT_A, mode = "test") =>
  verifyOrgKey(ctx, ACTOR, mode, { accountId: account }, { fetch: stripe.fetch });

describe("organization key: storage", { skip }, () => {
  test("accepts sk_org in either slot and shows only a masked preview, a fingerprint and the pinned API version", () => {
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG });
    saveKeys(ctx, ACTOR, "live", { orgKey: SK_ORG_2 });
    const s = getStatus(ctx) as any;
    for (const mode of ["test", "live"]) {
      assert.equal(s.modes[mode].org_key.configured, true);
      assert.match(s.modes[mode].org_key.preview, /^sk_org_…[A-Za-z0-9]{4}$/);
      assert.match(s.modes[mode].org_key.fingerprint, /^[0-9a-f]{12}$/);
      assert.equal(s.modes[mode].org_key.verified, false, "stored but not yet verified");
    }
    assert.equal(s.org.api_version, DEFAULT_ORG_API_VERSION);
    assert.equal(DEFAULT_ORG_API_VERSION, "2026-10-28.endive");
    assert.ok(s.org.permissions.length >= 5);
    assertNoKeys(s, "status");
  });

  test("rejects anything that is not an sk_org key, and org keys in the account-key fields, without echoing the value", () => {
    const bad: Array<[string, unknown]> = [
      ["orgKey", SK_TEST],
      ["orgKey", SK_LIVE],
      ["orgKey", RK_TEST],
      ["orgKey", PK_TEST],
      ["orgKey", WHSEC_MANUAL],
      ["orgKey", "sk_org_short"],
      ["orgKey", "sk_org_has spaces in it xxxxxxxxxxxx"],
      ["orgKey", "sk_org_" + "a".repeat(500)],
      ["orgKey", 12345],
      ["secretKey", SK_ORG],
      ["publishableKey", SK_ORG],
      ["webhookSecret", SK_ORG]
    ];
    for (const [field, value] of bad) {
      assert.throws(
        () => saveKeys(ctx, ACTOR, "test", { [field]: value } as never),
        (e: unknown) => {
          assert.ok(e instanceof StripeError);
          assert.equal((e as StripeError).statusCode, 400);
          assertNoKeys((e as Error).message, "error message");
          return true;
        },
        `${field}`
      );
    }
    assert.equal((getStatus(ctx) as any).modes.test.org_key.configured, false, "nothing stored on failure");
  });

  test("is encrypted at rest and never leaks into audit, status or app lists", () => {
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG });
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'stripe_test_org_key'").get() as {
      value: string;
    };
    assertNoKeys(row.value, "stored org key");
    assert.ok(!row.value.includes("sk_org"));
    assertNoKeysAnywhere();
  });

  test("redact scrubs org keys too", () => {
    assert.equal(redact(`bad ${SK_ORG} and ${SK_ORG_2}`), "bad [redacted] and [redacted]");
  });

  test("saving or removing only the org key never touches an app", () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST });
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    const before = JSON.stringify(getServiceEnv(ctx, "svc-coach"));
    const saved = saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG });
    assert.deepEqual(saved.apps_updated, []);
    assert.equal(saved.restart_needed, false);
    const removed = removeKeys(ctx, ACTOR, "test", "org_key");
    assert.deepEqual(removed.apps_disconnected, []);
    assert.deepEqual(removed.apps_updated, []);
    assert.equal(removed.restart_needed, false);
    assert.equal(JSON.stringify(getServiceEnv(ctx, "svc-coach")), before);
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.connected, true);
  });

  test("'all' removes the org key together with the account keys", () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, orgKey: SK_ORG });
    removeKeys(ctx, ACTOR, "test", "all");
    const s = getStatus(ctx) as any;
    assert.equal(s.modes.test.org_key.configured, false);
    assert.equal(s.modes.test.secret_key.configured, false);
  });
});

describe("organization key: assigning an app to a member account", { skip }, () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST });
  });

  test("needs a connected app and a plain acct_ id; the slash form is refused with a clear message", () => {
    assert.throws(
      () => setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A),
      (e: any) => e.code === "not_connected" && e.statusCode === 409
    );
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    assert.throws(
      () => setAppAccount(ctx, ACTOR, "svc-coach", `${ACCT_A}/${ACCT_B}`),
      (e: any) => e.code === "invalid_account" && /not supported yet/.test(e.message)
    );
    for (const bad of [
      "acct_",
      "acct_ with space",
      "ACCT_1abc",
      "cus_123",
      "acct_1abc-def",
      42,
      {},
      "a".repeat(200)
    ]) {
      assert.throws(
        () => setAppAccount(ctx, ACTOR, "svc-coach", bad),
        (e: any) => e.code === "invalid_account",
        String(bad)
      );
    }
    assert.equal(
      listApps(ctx).find((a) => a.service_id === "svc-coach")!.account_id,
      null,
      "nothing stored on failure"
    );
    const ok = setAppAccount(ctx, ACTOR, "svc-coach", `  ${ACCT_A}  `);
    assert.equal(ok.account_id, ACCT_A);
    assert.equal(ok.changed, true);
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.account_id, ACCT_A);
    assert.equal(setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A).changed, false, "same value is a no-op");
  });

  test("clearing the account sends the app back to the account-level key", () => {
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG });
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A);
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.credential_path, "org-key");
    setAppAccount(ctx, ACTOR, "svc-coach", null);
    const app = listApps(ctx).find((a) => a.service_id === "svc-coach")!;
    assert.equal(app.account_id, null);
    assert.equal(app.credential_path, "account-key");
    assert.equal(
      listApps(ctx).find((a) => a.service_id === "svc-web")!.credential_path,
      null,
      "an unconnected app has no path"
    );
  });

  test("the change is audited without any key", () => {
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A);
    const rows = ctx.db
      .prepare("SELECT details FROM audit_logs WHERE action = 'stripe.app.account'")
      .all() as Array<{ details: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0].details, new RegExp(ACCT_A));
    assertNoKeysAnywhere();
  });
});

describe("organization key: verify", { skip }, () => {
  beforeEach(() => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, orgKey: SK_ORG });
  });

  test("calls Stripe with the org key, a pinned API version and the account context, and records the result", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    const r = await verifyOrg(stripe);
    assert.equal(stripe.calls.length, 1);
    const call = stripe.calls[0];
    assert.equal(call.path, "/v1/account");
    assert.equal(call.method, "GET");
    assert.equal(call.auth, `Bearer ${SK_ORG}`);
    assert.equal(call.version, "2026-10-28.endive");
    assert.equal(call.context, ACCT_A);
    assert.equal(call.redirect, "error");
    assert.equal(r.credential_path, "org-key");
    assert.equal(r.account.id, ACCT_A);
    assert.equal(r.account.name, `Fake ${ACCT_A}`);
    assert.equal(r.account.charges_enabled, false);
    assert.deepEqual(r.account.currently_due, ["business_profile.url", "external_account"]);
    const status = (getStatus(ctx) as any).modes.test.org_key;
    assert.equal(status.verified, true);
    assert.equal(status.check.account.id, ACCT_A);
    assertNoKeys(r, "verify result");
    assertNoKeysAnywhere();
  });

  test("needs an app (with an account) or an explicit acct_ id, and checks it before any network call", async () => {
    const stripe = makeStripe();
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "test", {}, { fetch: stripe.fetch }),
      (e: any) => e.code === "account_required"
    );
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "test", { accountId: "nonsense" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "invalid_account"
    );
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "test", { accountId: `${ACCT_A}/${ACCT_B}` }, { fetch: stripe.fetch }),
      (e: any) => e.code === "invalid_account"
    );
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "test", { serviceId: "svc-coach" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "not_connected"
    );
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "test", { serviceId: "svc-coach" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "account_required"
    );
    assert.equal(stripe.calls.length, 0);
  });

  test("without a stored org key it says so and makes no call", async () => {
    const stripe = makeStripe();
    await assert.rejects(
      verifyOrgKey(ctx, ACTOR, "live", { accountId: ACCT_A }, { fetch: stripe.fetch }),
      (e: any) => e.code === "org_key_missing"
    );
    assert.equal(stripe.calls.length, 0);
  });

  test("tells an invalid key apart from a valid key that is restricted too tightly, and never leaks Stripe's text", async () => {
    await assert.rejects(verifyOrg(makeStripe({ orgStatus: 401 })), (e: any) => {
      assert.equal(e.code, "org_key_invalid");
      assert.notEqual(e.statusCode, 401, "a 401 would log the dashboard user out");
      assertNoKeys(e.message, "error");
      assertNoKeys(e.meta, "error meta");
      return true;
    });
    await assert.rejects(verifyOrg(makeStripe({ orgStatus: 403 })), (e: any) => {
      assert.equal(e.code, "org_key_permission");
      assert.match(e.message, /Account \(read\)/);
      assert.match(e.message, /valid/, "says the key itself is fine");
      assert.notEqual(e.statusCode, 401);
      assertNoKeys(e.message, "error");
      return true;
    });
    await assert.rejects(
      verifyOrg(makeStripe({ netFail: true })),
      (e: any) => e.meta.stripe_type === "network_error" && e.statusCode === 502
    );
    assert.equal(
      (getStatus(ctx) as any).modes.test.org_key.verified,
      false,
      "failures never mark the key verified"
    );
    assertNoKeysAnywhere();
  });

  test("a key whose mode Stripe reports differently from its slot is refused and stays unverified", async () => {
    await assert.rejects(
      verifyOrg(makeStripe({ orgLivemode: true })),
      (e: any) => e.code === "mode_mismatch" && e.statusCode === 409
    );
    assert.equal((getStatus(ctx) as any).modes.test.org_key.verified, false);
  });

  test("an answer for a different account than the one asked for is refused", async () => {
    await assert.rejects(
      verifyOrg(makeStripe({ wrongAccount: true })),
      (e: any) => e.code === "account_mismatch"
    );
    assert.equal((getStatus(ctx) as any).modes.test.org_key.verified, false);
  });

  test("an app's result is stored with the app, and replacing or removing the key clears every verification", async () => {
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A);
    const stripe = makeStripe({ orgLivemode: false });
    const r = await verifyOrgKey(ctx, ACTOR, "test", { serviceId: "svc-coach" }, { fetch: stripe.fetch });
    assert.equal(r.service_id, "svc-coach");
    const app = listApps(ctx).find((a) => a.service_id === "svc-coach")!;
    assert.equal(app.verify?.account.id, ACCT_A);
    assert.equal(app.verify?.path, "org-key");
    assert.equal(app.org_key_verified, true);
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG_2 });
    assert.equal(
      (getStatus(ctx) as any).modes.test.org_key.verified,
      false,
      "a new key must be verified again"
    );
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.verify, null);
    await verifyOrgKey(ctx, ACTOR, "test", { serviceId: "svc-coach" }, { fetch: stripe.fetch });
    removeKeys(ctx, ACTOR, "test", "org_key");
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-coach")!.verify, null);
    assert.equal(
      listApps(ctx).find((a) => a.service_id === "svc-coach")!.credential_path,
      "account-key",
      "without an org key the account-level key is used"
    );
  });

  test("the API version can be overridden by a setting, and an invalid value is ignored", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES ('stripe_org_api_version', '2026-09-30.endive')")
      .run();
    await verifyOrg(stripe);
    assert.equal(stripe.calls[0].version, "2026-09-30.endive");
    assert.equal(orgApiVersion(ctx), "2026-09-30.endive");
    ctx.db
      .prepare("UPDATE settings SET value = 'latest; DROP TABLE x' WHERE key = 'stripe_org_api_version'")
      .run();
    assert.equal(orgApiVersion(ctx), DEFAULT_ORG_API_VERSION);
  });
});

describe("organization key: setup runs in the app's own account", { skip }, () => {
  beforeEach(() => {
    orgSetup();
  });

  test("refuses to write until the key was verified, and makes no network call", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    const unverified = (e: any) => e.code === "org_key_unverified" && e.statusCode === 409;
    await assert.rejects(
      ensureProductPrice(
        ctx,
        ACTOR,
        { ...PRICE, mode: "test", serviceId: "svc-coach" },
        { fetch: stripe.fetch }
      ),
      unverified
    );
    await assert.rejects(
      ensureWebhook(
        ctx,
        ACTOR,
        { mode: "test", url: HOOK_A, serviceId: "svc-coach" },
        { fetch: stripe.fetch }
      ),
      unverified
    );
    await assert.rejects(
      ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch }),
      unverified
    );
    assert.equal(stripe.calls.length, 0);
  });

  test("after verification every call carries the org key, the pinned version and the account context, and the result says so", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    stripe.calls.length = 0;
    const price = await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    const hook = await ensureWebhook(
      ctx,
      ACTOR,
      { mode: "test", url: HOOK_A, serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    const portal = await ensurePortal(
      ctx,
      ACTOR,
      { mode: "test", serviceId: "svc-coach", returnUrl: "https://coach.example.com/account" },
      { fetch: stripe.fetch }
    );
    for (const r of [price, hook, portal]) {
      assert.equal(r.credential_path, "org-key");
      assert.equal(r.account, ACCT_A);
      assertNoKeys(r, "setup result");
    }
    assert.ok(stripe.calls.length >= 6);
    for (const c of stripe.calls) {
      assert.equal(c.auth, `Bearer ${SK_ORG}`, `${c.method} ${c.path} uses the org key`);
      assert.equal(c.version, "2026-10-28.endive");
      assert.equal(c.context, ACCT_A);
      if (c.idem) assert.ok(c.idem.endsWith(`-${ACCT_A}`), "idempotency keys are scoped to the account");
    }
    const a = stripe.accounts[ACCT_A];
    assert.equal(a.prices.length, 1);
    assert.equal(a.hooks.length, 1);
    assert.equal(a.portals.length, 1);
    assert.equal(
      stripe.state.prices.length + stripe.state.hooks.length + stripe.state.portals.length,
      0,
      "nothing is created in the key's own account"
    );
    assertNoKeysAnywhere();
  });

  test("two apps in two accounts get their own objects, and a retry is a no-op in each", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    const one = await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    const two = await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-web" },
      { fetch: stripe.fetch }
    );
    assert.equal(one.created, true);
    assert.equal(two.created, true, "the same lookup key in another account is a different price");
    assert.notEqual(one.price.id, two.price.id);
    const writes = stripe.writes().length;
    assert.equal(
      (
        await ensureProductPrice(
          ctx,
          ACTOR,
          { ...PRICE, mode: "test", serviceId: "svc-coach" },
          { fetch: stripe.fetch }
        )
      ).created,
      false
    );
    assert.equal(
      (
        await ensureProductPrice(
          ctx,
          ACTOR,
          { ...PRICE, mode: "test", serviceId: "svc-web" },
          { fetch: stripe.fetch }
        )
      ).created,
      false
    );
    assert.equal(stripe.writes().length, writes);
    assert.equal(stripe.accounts[ACCT_A].prices.length, 1);
    assert.equal(stripe.accounts[ACCT_B].prices.length, 1);
  });

  test("results are recorded per app, not in the shared mode record", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    await ensureWebhook(
      ctx,
      ACTOR,
      { mode: "test", url: HOOK_A, serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    await ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch });
    const app = listApps(ctx).find((a) => a.service_id === "svc-coach")!;
    assert.ok(app.setup?.prices?.openaim_coach_monthly);
    assert.ok(app.setup?.webhook?.id);
    assert.ok(app.setup?.portal?.id);
    assert.deepEqual((getStatus(ctx) as any).modes.test.setup, {});
    assert.equal(listApps(ctx).find((a) => a.service_id === "svc-web")!.setup, null);
  });

  test("falls back to the account-level key exactly as before: no account id, no org key, or no app", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    // 1. an app with no account id
    setAppAccount(ctx, ACTOR, "svc-web", null);
    stripe.calls.length = 0;
    const noAccount = await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-web", lookupKey: "web_plan" },
      { fetch: stripe.fetch }
    );
    assert.equal(noAccount.credential_path, "account-key");
    assert.equal(noAccount.account, null);
    // 2. no service at all
    const noApp = await ensurePortal(ctx, ACTOR, { mode: "test" }, { fetch: stripe.fetch });
    assert.equal(noApp.credential_path, "account-key");
    // 3. an account id but no org key
    removeKeys(ctx, ACTOR, "test", "org_key");
    const noOrg = await ensureWebhook(
      ctx,
      ACTOR,
      { mode: "test", url: HOOK_B, serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    assert.equal(noOrg.credential_path, "account-key");
    for (const c of stripe.calls) {
      assert.equal(c.auth, `Bearer ${SK_TEST}`);
      assert.equal(c.version, null, "no Stripe-Version where the account default applies");
      assert.equal(c.context, null, "no Stripe-Context where it is inappropriate");
    }
    assert.ok(
      (getStatus(ctx) as any).modes.test.setup.prices.web_plan,
      "account-path results still go in the mode record"
    );
  });

  test("live writes still need confirmLive on the org path, before any network call", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE, orgKey: SK_ORG_2 });
    connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true });
    assert.equal(
      listApps(ctx).find((a) => a.service_id === "svc-coach")!.account_id,
      ACCT_A,
      "the account survives a mode change"
    );
    const stripe = makeStripe({ orgLivemode: true });
    await verifyOrg(stripe, ACCT_A, "live");
    stripe.calls.length = 0;
    for (const run of [
      () =>
        ensureProductPrice(
          ctx,
          ACTOR,
          { ...PRICE, mode: "live", serviceId: "svc-coach" },
          { fetch: stripe.fetch }
        ),
      () =>
        ensureWebhook(
          ctx,
          ACTOR,
          { mode: "live", url: HOOK_A, serviceId: "svc-coach" },
          { fetch: stripe.fetch }
        ),
      () => ensurePortal(ctx, ACTOR, { mode: "live", serviceId: "svc-coach" }, { fetch: stripe.fetch })
    ]) {
      await assert.rejects(run(), (e: any) => e.code === "live_confirmation_required");
    }
    assert.equal(stripe.calls.length, 0, "refused before touching Stripe");
    const ok = await ensurePortal(
      ctx,
      ACTOR,
      { mode: "live", serviceId: "svc-coach", confirmLive: true },
      { fetch: stripe.fetch }
    );
    assert.equal(ok.credential_path, "org-key");
    assert.equal(stripe.calls[0].auth, `Bearer ${SK_ORG_2}`);
    assert.equal(stripe.calls[0].context, ACCT_A);
  });

  test("an app connected in one mode cannot be written to in the other", async () => {
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE, orgKey: SK_ORG_2 });
    const stripe = makeStripe({ orgLivemode: true });
    await verifyOrg(stripe, ACCT_A, "live");
    stripe.calls.length = 0;
    await assert.rejects(
      ensureProductPrice(
        ctx,
        ACTOR,
        { ...PRICE, mode: "live", serviceId: "svc-coach", confirmLive: true },
        { fetch: stripe.fetch }
      ),
      (e: any) => e.code === "mode_mismatch" && e.statusCode === 409
    );
    assert.equal(stripe.calls.length, 0);
  });

  test("a live org key sitting in the test slot can never be used for writes", async () => {
    const stripe = makeStripe({ orgLivemode: true }); // Stripe says: this key is LIVE
    await assert.rejects(verifyOrg(stripe), (e: any) => e.code === "mode_mismatch");
    stripe.calls.length = 0;
    await assert.rejects(
      ensureProductPrice(
        ctx,
        ACTOR,
        { ...PRICE, mode: "test", serviceId: "svc-coach" },
        { fetch: stripe.fetch }
      ),
      (e: any) => e.code === "org_key_unverified"
    );
    assert.equal(stripe.calls.length, 0);
    assert.equal(stripe.writes().length, 0);
  });

  test("defence in depth: a write response that reports the wrong mode is refused", async () => {
    const stripe = makeStripe({ orgLivemode: false, writeLivemode: true });
    await verifyOrg(stripe);
    await assert.rejects(
      ensureProductPrice(
        ctx,
        ACTOR,
        { ...PRICE, mode: "test", serviceId: "svc-coach" },
        { fetch: stripe.fetch }
      ),
      (e: any) => e.code === "mode_mismatch"
    );
  });

  test("replacing the org key invalidates the verification, so writes stop until it is verified again", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG_2 });
    stripe.calls.length = 0;
    await assert.rejects(
      ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch }),
      (e: any) => e.code === "org_key_unverified"
    );
    assert.equal(stripe.calls.length, 0);
    await verifyOrg(stripe);
    assert.equal(
      (await ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch }))
        .credential_path,
      "org-key"
    );
    assert.equal(stripe.calls.at(-1)!.auth, `Bearer ${SK_ORG_2}`);
  });

  test("the audit trail records the path and account but no key", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    const row = ctx.db
      .prepare("SELECT details FROM audit_logs WHERE action = 'stripe.price.ensure'")
      .get() as { details: string };
    assert.match(row.details, /path=org-key/);
    assert.match(row.details, new RegExp(`account=${ACCT_A}`));
    assertNoKeysAnywhere();
  });
});

describe("organization key: per-app webhook secret", { skip }, () => {
  beforeEach(() => {
    orgSetup();
  });
  const hookFor = (
    stripe: ReturnType<typeof makeStripe>,
    serviceId: string,
    url: string,
    extra: Record<string, unknown> = {}
  ) => ensureWebhook(ctx, ACTOR, { mode: "test", url, serviceId, ...extra }, { fetch: stripe.fetch });

  test("each app gets the secret of its own endpoint: stored encrypted per app, injected only there, never returned", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    const a = await hookFor(stripe, "svc-coach", HOOK_A);
    assert.equal(a.created, true);
    assert.equal(a.secret_stored, true);
    assert.equal(a.secret_source, "app");
    assert.deepEqual(a.apps_updated, ["svc-coach"]);
    assert.equal(a.restart_needed, true);
    assertNoKeys(a, "webhook result");
    const b = await hookFor(stripe, "svc-web", HOOK_B);
    assert.deepEqual(b.apps_updated, ["svc-web"]);
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, WHSEC_CREATED);
    assert.equal(getServiceEnv(ctx, "svc-web").STRIPE_WEBHOOK_SECRET, WHSEC_CREATED_2);
    const rows = ctx.db.prepare("SELECT service_id, webhook_secret FROM stripe_app_links").all() as Array<{
      service_id: string;
      webhook_secret: string;
    }>;
    for (const row of rows) {
      assert.ok(row.webhook_secret, "stored");
      assertNoKeys(row.webhook_secret, `stored secret for ${row.service_id}`);
    }
    assert.equal(
      (getStatus(ctx) as any).modes.test.webhook_secret.configured,
      false,
      "the shared per-mode secret is untouched"
    );
    const apps = listApps(ctx);
    assert.deepEqual(apps.find((x) => x.service_id === "svc-coach")!.webhook_secret, {
      configured: true,
      source: "app"
    });
    assertNoKeys(apps, "apps");
    assertNoKeysAnywhere();
  });

  test("a per-app secret wins over the shared one; the shared one is the fallback and the result says so", async () => {
    saveKeys(ctx, ACTOR, "test", { webhookSecret: WHSEC_MANUAL });
    assert.equal(
      getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET,
      WHSEC_MANUAL,
      "fallback until the app has its own"
    );
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    stripe.accounts[ACCT_B] = {
      prices: [],
      products: new Map(),
      portals: [],
      hooks: [{ id: "we_old", url: HOOK_B, enabled_events: ["invoice.paid"], status: "enabled" }]
    };
    const existing = await hookFor(stripe, "svc-web", HOOK_B, { events: ["invoice.paid"] });
    assert.equal(existing.created, false);
    assert.equal(existing.secret_source, "mode");
    assert.equal(existing.secret_unavailable, false);
    assert.match(String(existing.note), /shared per-mode secret/);
    assert.equal(getServiceEnv(ctx, "svc-web").STRIPE_WEBHOOK_SECRET, WHSEC_MANUAL);
    await hookFor(stripe, "svc-coach", HOOK_A);
    assert.equal(
      getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET,
      WHSEC_CREATED,
      "its own secret replaces the shared one"
    );
    assert.equal(
      getServiceEnv(ctx, "svc-web").STRIPE_WEBHOOK_SECRET,
      WHSEC_MANUAL,
      "the other app is unaffected"
    );
  });

  test("an endpoint that already exists with no secret anywhere is reported as unavailable, not guessed", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    stripe.accounts[ACCT_A] = {
      prices: [],
      products: new Map(),
      portals: [],
      hooks: [{ id: "we_old", url: HOOK_A, enabled_events: ["invoice.paid"], status: "enabled" }]
    };
    const r = await hookFor(stripe, "svc-coach", HOOK_A, { events: ["invoice.paid"] });
    assert.equal(r.secret_stored, false);
    assert.equal(r.secret_unavailable, true);
    assert.equal(r.secret_source, null);
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, undefined);
  });

  test("changing the app's account drops the secret that belonged to the old account", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    await hookFor(stripe, "svc-coach", HOOK_A);
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, WHSEC_CREATED);
    const r = setAppAccount(ctx, ACTOR, "svc-coach", ACCT_B);
    assert.equal(r.restart_needed, true);
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, undefined);
    const link = ctx.db
      .prepare(
        "SELECT webhook_secret, verify_json, setup_json FROM stripe_app_links WHERE service_id = 'svc-coach'"
      )
      .get() as any;
    assert.equal(link.webhook_secret, null);
    assert.equal(link.setup_json, null);
  });

  test("reconnecting in another mode drops what belonged to the old mode; disconnect removes it all", async () => {
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    await hookFor(stripe, "svc-coach", HOOK_A);
    saveKeys(ctx, ACTOR, "live", { secretKey: SK_LIVE });
    connectApp(ctx, ACTOR, { serviceId: "svc-coach", mode: "live", confirmLive: true });
    const link = ctx.db
      .prepare("SELECT webhook_secret, setup_json FROM stripe_app_links WHERE service_id = 'svc-coach'")
      .get() as any;
    assert.equal(link.webhook_secret, null);
    assert.equal(link.setup_json, null);
    assert.notEqual(getServiceEnv(ctx, "svc-coach").STRIPE_WEBHOOK_SECRET, WHSEC_CREATED);
    disconnectApp(ctx, ACTOR, "svc-coach");
    assert.equal(
      (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM stripe_app_links WHERE service_id = 'svc-coach'").get() as {
          n: number;
        }
      ).n,
      0
    );
  });
});

describe("organization key: it never reaches an app", { skip }, () => {
  test("no connect, takeover, rotation, price injection or webhook step ever puts the org key into any app's env", async () => {
    orgSetup();
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES ('p1','svc-coach','STRIPE_SECRET_KEY','placeholder',0,0)"
      )
      .run();
    connectApp(ctx, ACTOR, { serviceId: "svc-coach", takeover: true });
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    await ensureProductPrice(
      ctx,
      ACTOR,
      { ...PRICE, mode: "test", serviceId: "svc-coach", priceEnvName: "STRIPE_PRICE_ID" },
      { fetch: stripe.fetch }
    );
    await ensureWebhook(
      ctx,
      ACTOR,
      { mode: "test", url: HOOK_A, serviceId: "svc-coach" },
      { fetch: stripe.fetch }
    );
    await ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch });
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST_2, orgKey: SK_ORG_2 });
    saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG });
    const sensitive = [SK_ORG, SK_ORG_2];
    for (const id of ["svc-coach", "svc-web"]) {
      const env = getServiceEnv(ctx, id);
      for (const [name, value] of Object.entries(env)) {
        assert.ok(!/ORG/i.test(name), `${id}: no org-named variable (${name})`);
        for (const k of sensitive)
          assert.ok(!value.includes(k) && !value.includes(k.slice(8, 24)), `${id}.${name} holds an org key`);
      }
    }
    const raw = ctx.db.prepare("SELECT key, value FROM env_vars").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const r of raw) for (const k of sensitive) assert.ok(!r.value.includes(k), `raw env row ${r.key}`);
    const names = new Set(raw.map((r) => r.key));
    for (const n of names) assert.ok(!/ORG/i.test(n));
    assert.equal(
      getServiceEnv(ctx, "svc-coach").STRIPE_SECRET_KEY,
      SK_TEST_2,
      "the account-level key is what the app gets"
    );
  });

  test("rotating only the org key leaves every app's env and restart state untouched", () => {
    orgSetup();
    const before = JSON.stringify([getServiceEnv(ctx, "svc-coach"), getServiceEnv(ctx, "svc-web")]);
    const syncedBefore = listApps(ctx).map((a) => a.synced_at);
    const r = saveKeys(ctx, ACTOR, "test", { orgKey: SK_ORG_2 });
    assert.deepEqual(r.apps_updated, []);
    assert.equal(JSON.stringify([getServiceEnv(ctx, "svc-coach"), getServiceEnv(ctx, "svc-web")]), before);
    assert.deepEqual(
      listApps(ctx).map((a) => a.synced_at),
      syncedBefore
    );
  });
});

describe("organization key: REST routes", { skip }, () => {
  async function app(stripe = makeStripe({ orgLivemode: false })) {
    const server = Fastify();
    (ctx as { app: unknown }).app = server;
    registerStripeRoutes(ctx, { fetch: stripe.fetch });
    await server.ready();
    return { server, stripe };
  }

  test("the whole master-key flow over HTTP never returns a key", async () => {
    const { server, stripe } = await app();
    const bodies: string[] = [];
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await server.inject({ method: method as never, url, payload: payload as never });
      bodies.push(res.body);
      return res;
    };
    let res = await call("PUT", "/api/stripe/keys/test", {
      secretKey: SK_TEST,
      publishableKey: PK_TEST,
      orgKey: SK_ORG
    });
    assert.equal(res.statusCode, 200);
    res = await call("PUT", "/api/stripe/keys/test", { orgKey: SK_TEST });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "wrong_key_type");
    res = await call("PUT", "/api/stripe/keys/test", { orgKey: { nested: SK_ORG } });
    assert.equal(res.statusCode, 400);
    res = await call("GET", "/api/stripe/status");
    assert.equal(res.json().modes.test.org_key.configured, true);
    assert.equal(res.json().org.api_version, "2026-10-28.endive");
    res = await call("POST", "/api/stripe/verify/test");
    assert.equal(res.json().credential_path, "account-key");
    res = await call("POST", "/api/stripe/apps/svc-coach/connect", { mode: "test" });
    assert.equal(res.statusCode, 200);
    res = await call("PUT", "/api/stripe/apps/svc-coach/account", { accountId: `${ACCT_A}/${ACCT_B}` });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "invalid_account");
    res = await call("PUT", "/api/stripe/apps/svc-coach/account", { accountId: ACCT_A });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().account_id, ACCT_A);
    res = await call("POST", "/api/stripe/org/verify/test", {});
    assert.equal(res.json().code, "account_required");
    res = await call("POST", "/api/stripe/setup/webhook", {
      mode: "test",
      url: HOOK_A,
      serviceId: "svc-coach"
    });
    assert.equal(res.json().code, "org_key_unverified", "writes wait for verification");
    res = await call("POST", "/api/stripe/org/verify/test", { serviceId: "svc-coach" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().credential_path, "org-key");
    assert.equal(res.json().account.id, ACCT_A);
    res = await call("POST", "/api/stripe/setup/webhook", {
      mode: "test",
      url: HOOK_A,
      serviceId: "svc-coach"
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().credential_path, "org-key");
    assert.equal(res.json().secret_source, "app");
    res = await call("POST", "/api/stripe/setup/portal", { mode: "test", serviceId: "svc-coach" });
    assert.equal(res.json().credential_path, "org-key");
    res = await call("GET", "/api/stripe/apps");
    const coach = res.json().apps.find((a: any) => a.service_id === "svc-coach");
    assert.equal(coach.credential_path, "org-key");
    assert.equal(coach.account_id, ACCT_A);
    assert.deepEqual(coach.webhook_secret, { configured: true, source: "app" });
    res = await call("DELETE", "/api/stripe/keys/test?part=org_key");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().apps_disconnected, []);
    res = await call("POST", "/api/stripe/org/verify/test", { accountId: ACCT_A });
    assert.equal(res.json().code, "org_key_missing");
    assert.ok(stripe.writes().length > 0);
    for (const b of bodies) assertNoKeys(b, "HTTP response body");
    assertNoKeysAnywhere();
    await server.close();
  });
});

describe("organization key: MCP tools", { skip }, () => {
  async function connect() {
    const stripe = makeStripe({ orgLivemode: false });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerStripeMcpTools(ctx, server, "session:abc", { fetch: stripe.fetch });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(clientT);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: Boolean(r.isError), text: r.content[0].text };
    };
    return {
      client,
      call,
      stripe,
      close: async () => {
        await client.close();
        await server.close();
      }
    };
  }

  test("the new tools accept no key material and return none", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, publishableKey: PK_TEST, orgKey: SK_ORG });
    const { client, call, close } = await connect();
    const tools = (await client.listTools()).tools;
    for (const name of ["stripe_set_app_account", "stripe_verify_org"])
      assert.ok(
        tools.some((t) => t.name === name),
        name
      );
    const outputs: string[] = [];
    const run = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
      outputs.push(r.text);
      return JSON.parse(r.text);
    };
    await run("stripe_connect_app", { service: "Coach" });
    const set = await run("stripe_set_app_account", { service: "Coach", accountId: ACCT_A });
    assert.equal(set.account_id, ACCT_A);
    const verified = await run("stripe_verify_org", { service: "Coach" });
    assert.equal(verified.credential_path, "org-key");
    assert.equal(verified.account.id, ACCT_A);
    const price = await run("stripe_ensure_product_price", {
      ...PRICE,
      service: "svc-coach",
      priceEnvName: "STRIPE_PRICE_ID"
    });
    assert.equal(price.credential_path, "org-key");
    const hook = await run("stripe_ensure_webhook", { url: HOOK_A, service: "Coach" });
    assert.equal(hook.credential_path, "org-key");
    assert.equal(hook.secret_source, "app");
    const portal = await run("stripe_ensure_portal", { service: "Coach" });
    assert.equal(portal.credential_path, "org-key");
    const acct = await run("stripe_verify", {});
    assert.equal(acct.credential_path, "account-key");
    const apps = await run("stripe_list_apps", {});
    assert.equal(apps.apps.find((a: any) => a.service_id === "svc-coach").credential_path, "org-key");
    const status = await run("stripe_status", {});
    assert.equal(status.modes.test.org_key.verified, true);
    for (const o of outputs) assertNoKeys(o, "MCP output");
    assertNoKeysAnywhere();
    const actors = ctx.db
      .prepare("SELECT DISTINCT actor FROM audit_logs WHERE action = 'stripe.app.account'")
      .all() as Array<{ actor: string }>;
    assert.deepEqual(
      actors.map((a) => a.actor),
      ["mcp:session:abc"]
    );
    await close();
  });

  test("live org-path writes need confirmLive through MCP too, and an unverified key makes no call", async () => {
    saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST, orgKey: SK_ORG });
    connectApp(ctx, ACTOR, { serviceId: "svc-coach" });
    setAppAccount(ctx, ACTOR, "svc-coach", ACCT_A);
    const { call, stripe, close } = await connect();
    const live = await call("stripe_ensure_webhook", { mode: "live", url: HOOK_A, service: "Coach" });
    assert.equal(live.isError, true);
    assert.match(live.text, /confirmLive/);
    const unverified = await call("stripe_ensure_portal", { service: "Coach" });
    assert.equal(unverified.isError, true);
    assert.match(unverified.text, /Verify the test-slot organization key first/);
    assert.equal(stripe.calls.length, 0);
    const bad = await call("stripe_set_app_account", { service: "Coach", accountId: `${ACCT_A}/${ACCT_B}` });
    assert.equal(bad.isError, true);
    assertNoKeys(bad.text);
    await close();
  });
});

describe("organization key: permission list and schema", { skip }, () => {
  test("the listed permissions are exactly what the helpers call: nothing missing, nothing extra, reads stay reads", async () => {
    orgSetup();
    const stripe = makeStripe({ orgLivemode: false });
    await verifyOrg(stripe);
    const serviceId = "svc-coach";
    await ensureProductPrice(ctx, ACTOR, { ...PRICE, mode: "test", serviceId }, { fetch: stripe.fetch });
    await ensureWebhook(ctx, ACTOR, { mode: "test", url: HOOK_A, serviceId }, { fetch: stripe.fetch });
    await ensureWebhook(
      ctx,
      ACTOR,
      { mode: "test", url: HOOK_A, serviceId, events: ["invoice.paid"] },
      { fetch: stripe.fetch }
    ); // update path
    await ensurePortal(ctx, ACTOR, { mode: "test", serviceId }, { fetch: stripe.fetch });
    await ensurePortal(ctx, ACTOR, { mode: "test", serviceId }, { fetch: stripe.fetch }); // update path
    const orgCalls = stripe.calls.filter((c) => c.context === ACCT_A);
    assert.ok(orgCalls.length > 8);
    const allowed = ORG_KEY_PERMISSIONS.flatMap((p) => p.paths);
    const used = new Set(orgCalls.map((c) => c.path));
    for (const path of used)
      assert.ok(covers(allowed, path), `${path} is called but not in ORG_KEY_PERMISSIONS`);
    for (const a of allowed)
      assert.ok(
        [...used].some((u) => covers([a], u)),
        `${a} is listed but never called`
      );
    for (const p of ORG_KEY_PERMISSIONS) {
      const mine = orgCalls.filter((c) => covers(p.paths, c.path));
      const writes = mine.some((c) => c.method !== "GET");
      assert.equal(writes, p.access === "write", `${p.resource} is listed as ${p.access}`);
    }
  });

  test("the schema change is additive: pre-existing links keep working, and applying it twice is harmless", async () => {
    const source = await readFile(new URL("./db.js", import.meta.url), "utf8");
    const alters = [...source.matchAll(/"(ALTER TABLE stripe_app_links ADD COLUMN [^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(
      alters.map((a) => a.split(" ").at(-2)),
      ["stripe_account_id", "webhook_secret", "verify_json", "setup_json"]
    );
    const old = makeContext(
      SCHEMA.replace(
        /CREATE TABLE stripe_app_links \([\s\S]*?\);/,
        `CREATE TABLE stripe_app_links (
  service_id TEXT PRIMARY KEY, mode TEXT NOT NULL, connected_at TEXT NOT NULL, synced_at TEXT NOT NULL,
  extra_env_json TEXT NOT NULL DEFAULT '[]'
);`
      )
    );
    ctx = old;
    saveKeys(ctx, ACTOR, "test", {
      secretKey: SK_TEST,
      publishableKey: PK_TEST,
      webhookSecret: WHSEC_MANUAL
    });
    ctx.db
      .prepare(
        "INSERT INTO stripe_app_links (service_id, mode, connected_at, synced_at) VALUES ('svc-coach', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
      )
      .run();
    for (let round = 0; round < 2; round++) {
      for (const sql of alters) {
        try {
          ctx.db.exec(sql);
        } catch {
          /* already applied, exactly as db.ts does */
        }
      }
    }
    const apps = listApps(ctx);
    const coach = apps.find((a) => a.service_id === "svc-coach")!;
    assert.equal(coach.connected, true);
    assert.equal(coach.account_id, null);
    assert.equal(coach.credential_path, "account-key");
    assert.deepEqual(coach.webhook_secret, { configured: true, source: "mode" });
    const r = saveKeys(ctx, ACTOR, "test", { secretKey: SK_TEST_2 });
    assert.deepEqual(r.apps_updated, ["svc-coach"]);
    assert.equal(getServiceEnv(ctx, "svc-coach").STRIPE_SECRET_KEY, SK_TEST_2);
    const stripe = makeStripe();
    assert.equal(
      (await ensurePortal(ctx, ACTOR, { mode: "test", serviceId: "svc-coach" }, { fetch: stripe.fetch }))
        .credential_path,
      "account-key"
    );
  });
});
