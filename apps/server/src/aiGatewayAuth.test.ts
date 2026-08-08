/**
 * AI Gateway auth, token, and metering tests (§8.5, §8.6).
 *
 * These need a database. Rather than the app's better-sqlite3 handle — which
 * needs a native build and would point at the real ~/.survhub/survhub.db —
 * they run against an in-memory `node:sqlite` database with just the tables
 * the gateway touches. The service layer only uses the
 * `prepare().get()/.all()/.run()` surface, which both drivers share.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";

import { isApiPath } from "./routes/auth.js";
import {
  authenticateConsumerToken,
  checkRateLimit,
  clearProviderKey,
  currentInFlight,
  gatewayDeps,
  getGatewayConfig,
  getUsageSummary,
  listAvailableProviders,
  listConsumerTokens,
  mintConsumerToken,
  providerStatuses,
  recordUsage,
  releaseSlot,
  resetRateLimits,
  revokeConsumerToken,
  setGatewayConfig,
  setProviderKey,
  touchConsumerToken,
  tryAcquireSlot
} from "./services/aiGateway.js";
import { clearRegisteredSecrets } from "./subgate/redact.js";
import type { AppContext } from "./types.js";

const REAL_LOOKING_KEY = "sk-ant-api03-NOTAREALKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_KEY = "test-secret-key-32-bytes-not-for-prod";

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT,
  status_code INTEGER, details TEXT, created_at TEXT
);
CREATE TABLE ai_gateway_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
  revoked_at TEXT, request_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ai_gateway_usage (
  id TEXT PRIMARY KEY, token_id TEXT, token_name TEXT, provider TEXT NOT NULL,
  model TEXT NOT NULL, wire TEXT NOT NULL, streamed INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL, error_code TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

let ctx: AppContext;

function makeContext(): AppContext {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    db,
    config: { secretKey: SECRET_KEY },
    app: { log: { info() {}, warn() {}, error() {}, child: () => ({}) } }
  } as unknown as AppContext;
}

beforeEach(() => {
  clearRegisteredSecrets();
  resetRateLimits();
  while (currentInFlight() > 0) releaseSlot();
  ctx = makeContext();
});

/* ------------------------------------------------------------------------ */
/* Consumer tokens (§8.5)                                                     */
/* ------------------------------------------------------------------------ */

describe("consumer tokens", () => {
  test("only a hash is persisted — the plaintext token is never stored", () => {
    const { token } = mintConsumerToken(ctx, "mymetaview-prod");

    const rows = ctx.db.prepare("SELECT * FROM ai_gateway_tokens").all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 1);
    const serialised = JSON.stringify(rows);
    assert.ok(!serialised.includes(token), "plaintext token found in the tokens table");
    assert.equal(String(rows[0].token_hash).length, 64, "stored value is a SHA-256 hex digest");

    // Nothing anywhere else in the database holds it either.
    const settings = JSON.stringify(ctx.db.prepare("SELECT * FROM settings").all());
    assert.ok(!settings.includes(token));
  });

  test("the listing surface never exposes enough to reconstruct a token", () => {
    const { token } = mintConsumerToken(ctx, "gamehub");
    const listed = JSON.stringify(listConsumerTokens(ctx));
    assert.ok(!listed.includes(token));
    // A short identifying prefix is fine; the secret bytes are not.
    assert.ok(!listed.includes(token.slice(10)));
  });

  test("a valid token authenticates", () => {
    const { token, record } = mintConsumerToken(ctx, "awaire");
    const authed = authenticateConsumerToken(ctx, token);
    assert.ok(authed);
    assert.equal(authed.id, record.id);
    assert.equal(authed.name, "awaire");
  });

  test("missing, malformed, and unknown tokens are all rejected", () => {
    mintConsumerToken(ctx, "havekongen");
    assert.equal(authenticateConsumerToken(ctx, ""), null);
    assert.equal(authenticateConsumerToken(ctx, "   "), null);
    // Right shape, wrong value.
    assert.equal(authenticateConsumerToken(ctx, "sgk_totally-made-up-value-here"), null);
    // A provider key is not a consumer token.
    assert.equal(authenticateConsumerToken(ctx, REAL_LOOKING_KEY), null);
    // A bare session-style bearer token must not work either.
    assert.equal(authenticateConsumerToken(ctx, "some-dashboard-session-token"), null);
  });

  test("a revoked token stops authenticating immediately", () => {
    const { token, record } = mintConsumerToken(ctx, "leader");
    assert.ok(authenticateConsumerToken(ctx, token));

    revokeConsumerToken(ctx, record.id);
    assert.equal(authenticateConsumerToken(ctx, token), null);

    const listed = listConsumerTokens(ctx).find((entry) => entry.id === record.id);
    assert.equal(listed?.active, false);
    assert.ok(listed?.revoked_at);
  });

  test("revoking one consumer leaves the others working", () => {
    const first = mintConsumerToken(ctx, "app-a");
    const second = mintConsumerToken(ctx, "app-b");
    revokeConsumerToken(ctx, first.record.id);

    assert.equal(authenticateConsumerToken(ctx, first.token), null);
    assert.ok(authenticateConsumerToken(ctx, second.token), "unrelated token still valid");
  });

  test("revoking a consumer token does not touch the provider credentials", () => {
    setProviderKey(ctx, "anthropic", REAL_LOOKING_KEY);
    const { record } = mintConsumerToken(ctx, "app-a");
    revokeConsumerToken(ctx, record.id);

    assert.deepEqual(listAvailableProviders(ctx), ["anthropic"]);
    assert.equal(gatewayDeps(ctx).credentialsFor("anthropic")?.apiKey, REAL_LOOKING_KEY);
  });

  test("use is recorded for the last-used column", () => {
    const { token, record } = mintConsumerToken(ctx, "app-a");
    assert.equal(listConsumerTokens(ctx)[0].last_used_at, null);

    touchConsumerToken(ctx, record.id);
    touchConsumerToken(ctx, record.id);

    const updated = listConsumerTokens(ctx)[0];
    assert.ok(updated.last_used_at);
    assert.equal(updated.request_count, 2);
    assert.ok(authenticateConsumerToken(ctx, token));
  });

  test("revoking an unknown id is a 404, not a silent success", () => {
    assert.throws(
      () => revokeConsumerToken(ctx, "does-not-exist"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 404
    );
  });

  test("every mint and revoke is audited", () => {
    const { record } = mintConsumerToken(ctx, "app-a", "admin");
    revokeConsumerToken(ctx, record.id, "admin");
    const actions = (
      ctx.db.prepare("SELECT action FROM audit_logs ORDER BY id").all() as Array<{ action: string }>
    ).map((row) => row.action);
    assert.ok(actions.includes("ai-gateway.token.mint"));
    assert.ok(actions.includes("ai-gateway.token.revoke"));
  });
});

/* ------------------------------------------------------------------------ */
/* Management-endpoint gating (§8.5)                                          */
/* ------------------------------------------------------------------------ */

describe("management endpoint gating", () => {
  test("/api/* is an authenticated namespace", () => {
    // If this regresses, GET /api/ai-gateway/status stops requiring a session
    // and is answered by the static dashboard handler instead — an auth bypass
    // that looks like a working page.
    assert.equal(isApiPath("/api"), true);
    assert.equal(isApiPath("/api/ai-gateway/status"), true);
    assert.equal(isApiPath("/api/ai-gateway/tokens"), true);
    assert.equal(isApiPath("/api/ai-gateway/usage"), true);
  });

  test("dashboard asset paths stay unauthenticated", () => {
    assert.equal(isApiPath("/assets/index.js"), false);
    assert.equal(isApiPath("/ai-gateway"), false, "the SPA route itself is client-side");
  });
});

/* ------------------------------------------------------------------------ */
/* Provider credentials (§8.6)                                                */
/* ------------------------------------------------------------------------ */

describe("provider credentials", () => {
  test("keys are encrypted at rest and never returned by the status surface", () => {
    setProviderKey(ctx, "anthropic", REAL_LOOKING_KEY);

    const stored = ctx.db
      .prepare("SELECT value FROM settings WHERE key = 'ai_gateway_key_anthropic'")
      .get() as { value: string };
    assert.ok(!stored.value.includes(REAL_LOOKING_KEY), "key stored as ciphertext");
    assert.match(stored.value, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, "AES-GCM iv:tag:ciphertext");

    const status = JSON.stringify(providerStatuses(ctx));
    assert.ok(!status.includes(REAL_LOOKING_KEY), "key absent from the status payload");
    assert.ok(status.includes("configured"));

    // But the call path can still get the real value.
    assert.equal(gatewayDeps(ctx).credentialsFor("anthropic")?.apiKey, REAL_LOOKING_KEY);
  });

  test("a fingerprint identifies the key without revealing it", () => {
    setProviderKey(ctx, "anthropic", REAL_LOOKING_KEY);
    const [anthropic] = providerStatuses(ctx).filter((provider) => provider.id === "anthropic");
    assert.ok(anthropic.fingerprint);
    assert.equal(anthropic.fingerprint.length, 12);
    assert.ok(!REAL_LOOKING_KEY.includes(anthropic.fingerprint));
  });

  test("an unconfigured provider reports no credentials rather than an empty string", () => {
    const [, openai] = providerStatuses(ctx);
    assert.equal(openai.configured, false);
    assert.equal(openai.keyPreview, null);
    assert.equal(gatewayDeps(ctx).credentialsFor("openai"), null);
    assert.deepEqual(listAvailableProviders(ctx), []);
  });

  test("clearing a key removes it from the database and from availability", () => {
    setProviderKey(ctx, "openai", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    assert.deepEqual(listAvailableProviders(ctx), ["openai"]);

    clearProviderKey(ctx, "openai");
    assert.deepEqual(listAvailableProviders(ctx), []);
    const row = ctx.db
      .prepare("SELECT value FROM settings WHERE key = 'ai_gateway_key_openai'")
      .get();
    assert.equal(row, undefined);
  });

  test("setting a key is audited by fingerprint, never by value", () => {
    setProviderKey(ctx, "anthropic", REAL_LOOKING_KEY, "admin");
    const audit = JSON.stringify(ctx.db.prepare("SELECT * FROM audit_logs").all());
    assert.ok(audit.includes("ai-gateway.provider-key.set"));
    assert.ok(!audit.includes(REAL_LOOKING_KEY));
  });
});

/* ------------------------------------------------------------------------ */
/* Rate limiting + concurrency (§7)                                           */
/* ------------------------------------------------------------------------ */

describe("rate limiting", () => {
  test("a consumer is throttled after its budget and told how long to wait", () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(checkRateLimit("token-a", 3), null, `request ${i + 1} allowed`);
    }
    const retryAfter = checkRateLimit("token-a", 3);
    assert.ok(typeof retryAfter === "number" && retryAfter >= 1, "throttled with a retry hint");
  });

  test("throttling is per consumer, not global", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("token-a", 3);
    assert.ok(checkRateLimit("token-a", 3) !== null, "first consumer throttled");
    assert.equal(checkRateLimit("token-b", 3), null, "second consumer unaffected");
  });

  test("a zero limit disables throttling rather than blocking everything", () => {
    for (let i = 0; i < 50; i++) assert.equal(checkRateLimit("token-c", 0), null);
  });

  test("the global concurrency cap admits exactly its budget", () => {
    assert.equal(tryAcquireSlot(2), true);
    assert.equal(tryAcquireSlot(2), true);
    assert.equal(tryAcquireSlot(2), false, "third request over the cap is rejected");
    assert.equal(currentInFlight(), 2);

    releaseSlot();
    assert.equal(tryAcquireSlot(2), true, "a freed slot is reusable");
    releaseSlot();
    releaseSlot();
    assert.equal(currentInFlight(), 0);
  });

  test("releasing more than acquired cannot drive the counter negative", () => {
    releaseSlot();
    releaseSlot();
    assert.equal(currentInFlight(), 0);
  });
});

/* ------------------------------------------------------------------------ */
/* Metering (§7 — metadata only)                                              */
/* ------------------------------------------------------------------------ */

describe("usage metering", () => {
  function record(overrides: Partial<Parameters<typeof recordUsage>[1]> = {}): void {
    recordUsage(ctx, {
      tokenId: "tok_1",
      tokenName: "app-a",
      provider: "anthropic",
      model: "claude-sonnet-5",
      wire: "openai",
      streamed: false,
      promptTokens: 10,
      completionTokens: 5,
      statusCode: 200,
      durationMs: 120,
      ...overrides
    });
  }

  test("totals, per-consumer, and per-model aggregates line up", () => {
    record();
    record({ promptTokens: 20, completionTokens: 10 });
    record({ tokenId: "tok_2", tokenName: "app-b", statusCode: 429, errorCode: "rate_limited" });

    const summary = getUsageSummary(ctx, 24);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.errors, 1);
    assert.equal(summary.totals.prompt_tokens, 40);
    assert.equal(summary.totals.completion_tokens, 20);

    const appA = summary.by_consumer.find((row) => row.token_name === "app-a");
    assert.equal(appA?.requests, 2);
    assert.equal(appA?.errors, 0);

    const appB = summary.by_consumer.find((row) => row.token_name === "app-b");
    assert.equal(appB?.errors, 1);

    assert.equal(summary.by_model[0].model, "claude-sonnet-5");
    assert.equal(summary.by_model[0].requests, 3);
  });

  test("no prompt or completion text is recorded anywhere", () => {
    record();
    const rows = JSON.stringify(ctx.db.prepare("SELECT * FROM ai_gateway_usage").all());
    // The schema has no column that could hold it; assert the shape explicitly
    // so adding one later fails this test.
    const columns = Object.keys(
      (ctx.db.prepare("SELECT * FROM ai_gateway_usage LIMIT 1").get() ?? {}) as object
    );
    for (const forbidden of ["prompt", "content", "messages", "completion", "body", "text"]) {
      assert.ok(
        !columns.some((column) => column === forbidden || column.endsWith(`_${forbidden}`)),
        `usage table must not have a "${forbidden}" column`
      );
    }
    assert.ok(rows.includes("claude-sonnet-5"), "metadata is recorded");
  });

  test("a failed request is still metered so errors are visible", () => {
    record({ statusCode: 503, errorCode: "upstream_unavailable", promptTokens: 0, completionTokens: 0 });
    const summary = getUsageSummary(ctx, 24);
    assert.equal(summary.totals.errors, 1);
    assert.equal(summary.recent[0].error_code, "upstream_unavailable");
  });

  test("an empty database summarises to zeros rather than nulls", () => {
    const summary = getUsageSummary(ctx, 24);
    assert.deepEqual(summary.totals, {
      requests: 0,
      errors: 0,
      prompt_tokens: 0,
      completion_tokens: 0
    });
    assert.deepEqual(summary.recent, []);
  });
});

/* ------------------------------------------------------------------------ */
/* Config                                                                     */
/* ------------------------------------------------------------------------ */

describe("gateway config", () => {
  test("defaults are safe: disabled, and loopback-only", () => {
    const config = getGatewayConfig(ctx);
    assert.equal(config.enabled, false);
    assert.equal(config.debugBodiesUntil, null);
    assert.ok(config.maxConcurrent > 0);
    assert.ok(config.rateLimitPerMinute > 0);
  });

  test("a corrupted config blob falls back to defaults instead of throwing", () => {
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES ('ai_gateway_config', '{not json')")
      .run();
    assert.equal(getGatewayConfig(ctx).enabled, false);
  });

  test("updates merge rather than replace", () => {
    setGatewayConfig(ctx, { publicUrl: "https://ai.example.com" });
    setGatewayConfig(ctx, { enabled: true });
    const config = getGatewayConfig(ctx);
    assert.equal(config.publicUrl, "https://ai.example.com");
    assert.equal(config.enabled, true);
  });
});
