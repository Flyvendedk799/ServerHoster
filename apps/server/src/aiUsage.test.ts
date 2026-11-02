/**
 * AI Usage — pricing, per-service tokens, idempotent recording, summaries and
 * budget alerts. No network; an in-memory SQLite database.
 */

import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import {
  computeCostMicro,
  connectService,
  disconnectService,
  listApps,
  modelPrices,
  priceFor,
  recentEvents,
  recordUsage,
  serviceForToken,
  setBudgets,
  setPriceOverrides,
  usageSummary,
  DEFAULT_PRICES
} from "./services/aiUsage.js";
import { getServiceEnv } from "./lib/core.js";
import { isApiPath } from "./routes/auth.js";

// node:sqlite needs Node 22.5+. CI still runs Node 20, where these tests skip instead of failing to load.
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  /* not available on this Node version */
}
const skip = sqlite ? false : "node:sqlite is not available on this Node version (needs 22.5+)";

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE services (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, type TEXT);
CREATE TABLE env_vars (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  service_id TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE ai_usage_tokens (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, app_name TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, feature TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_micro_usd INTEGER, cost_source TEXT NOT NULL,
  status TEXT NOT NULL, error_code TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, request_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ai_usage_events_ref ON ai_usage_events(service_id, request_ref) WHERE request_ref IS NOT NULL;
`;

let ctx: AppContext;

function makeContext(): AppContext {
  const db = new sqlite!.DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO services (id, project_id, name, type) VALUES (?, ?, ?, ?)").run(
    "svc-coach",
    "p1",
    "Coach",
    "docker"
  );
  db.prepare("INSERT INTO services (id, project_id, name, type) VALUES (?, ?, ?, ?)").run(
    "svc-web",
    "p1",
    "Web",
    "process"
  );
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

const sonnet = (extra: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  input_tokens: 1000,
  output_tokens: 100,
  status: "ok" as const,
  duration_ms: 2500,
  ...extra
});

describe("pricing", { skip }, () => {
  test("cost is tokens x USD-per-million, including cache tokens", () => {
    // 1000 in * $2 + 100 out * $10 = 2000 + 1000 micro-USD
    assert.equal(
      computeCostMicro(DEFAULT_PRICES["claude-sonnet-5-5"], {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0
      }),
      3000
    );
    assert.equal(
      computeCostMicro(DEFAULT_PRICES["claude-sonnet-5-5"], {
        input: 0,
        output: 0,
        cacheRead: 10_000,
        cacheWrite: 1000
      }),
      2000 + 2500
    );
  });

  test("dated ids resolve, unknown models do not, overrides win", () => {
    assert.ok(priceFor(ctx, "claude-haiku-4-5-20251001"));
    assert.equal(priceFor(ctx, "gpt-5-mini"), null);
    setPriceOverrides(ctx, { "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 } });
    assert.equal(priceFor(ctx, "gpt-5-mini")?.custom, true);
    setPriceOverrides(ctx, { "claude-sonnet-5-5": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    assert.equal(priceFor(ctx, "claude-sonnet-5-5")?.price.input, 1);
  });

  test("invalid overrides are rejected", () => {
    assert.throws(
      () => setPriceOverrides(ctx, { x: { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 } }),
      /Invalid price/
    );
  });

  test("model list marks unpriced models seen in events", () => {
    recordUsage(ctx, "svc-coach", sonnet({ model: "mystery-model" }));
    const m = modelPrices(ctx).find((x) => x.model === "mystery-model");
    assert.equal(m?.priced, false);
  });
});

describe("connecting an app", { skip }, () => {
  test("mints a token, stores only its hash, and injects encrypted env", () => {
    const r = connectService(ctx, "svc-coach");
    assert.match(r.token_prefix, /^sau_/);
    const env = getServiceEnv(ctx, "svc-coach");
    assert.equal(env.SURVHUB_AI_USAGE_URL, "http://host.docker.internal:8787/api/ai-usage/report");
    assert.match(env.SURVHUB_AI_USAGE_TOKEN, /^sau_/);
    const raw = ctx.db
      .prepare("SELECT value, is_secret, system FROM env_vars WHERE key = 'SURVHUB_AI_USAGE_TOKEN'")
      .get() as {
      value: string;
      is_secret: number;
      system: number;
    };
    assert.equal(raw.is_secret, 1);
    assert.equal(raw.system, 1);
    assert.ok(!raw.value.includes(env.SURVHUB_AI_USAGE_TOKEN), "token is encrypted at rest");
    const stored = ctx.db
      .prepare("SELECT token_hash FROM ai_usage_tokens WHERE service_id = 'svc-coach'")
      .get() as { token_hash: string };
    assert.ok(!stored.token_hash.includes(env.SURVHUB_AI_USAGE_TOKEN));
    assert.deepEqual(serviceForToken(ctx, env.SURVHUB_AI_USAGE_TOKEN), { service_id: "svc-coach" });
  });

  test("process services get a loopback URL; rotation invalidates the old token", () => {
    connectService(ctx, "svc-web");
    assert.equal(
      getServiceEnv(ctx, "svc-web").SURVHUB_AI_USAGE_URL,
      "http://127.0.0.1:8787/api/ai-usage/report"
    );
    const first = getServiceEnv(ctx, "svc-web").SURVHUB_AI_USAGE_TOKEN;
    connectService(ctx, "svc-web");
    const second = getServiceEnv(ctx, "svc-web").SURVHUB_AI_USAGE_TOKEN;
    assert.notEqual(first, second);
    assert.equal(serviceForToken(ctx, first), null);
    assert.ok(serviceForToken(ctx, second));
  });

  test("a token never resolves to another service and junk is refused", () => {
    connectService(ctx, "svc-coach");
    connectService(ctx, "svc-web");
    const web = getServiceEnv(ctx, "svc-web").SURVHUB_AI_USAGE_TOKEN;
    assert.equal(serviceForToken(ctx, web)?.service_id, "svc-web");
    for (const bad of ["", "nope", "sau_" + "x".repeat(200), "emk_whatever"])
      assert.equal(serviceForToken(ctx, bad), null);
  });

  test("disconnect revokes the token and removes the env", () => {
    connectService(ctx, "svc-coach");
    const token = getServiceEnv(ctx, "svc-coach").SURVHUB_AI_USAGE_TOKEN;
    disconnectService(ctx, "svc-coach");
    assert.equal(serviceForToken(ctx, token), null);
    assert.equal(getServiceEnv(ctx, "svc-coach").SURVHUB_AI_USAGE_TOKEN, undefined);
  });

  test("unknown service is a 404", () => {
    assert.throws(
      () => connectService(ctx, "nope"),
      (e: Error & { statusCode?: number }) => e.statusCode === 404
    );
  });

  test("listApps shows connection state", () => {
    connectService(ctx, "svc-coach");
    const apps = listApps(ctx) as Array<{ service_id: string; connected: boolean }>;
    assert.equal(apps.find((a) => a.service_id === "svc-coach")?.connected, true);
    assert.equal(apps.find((a) => a.service_id === "svc-web")?.connected, false);
  });
});

describe("recording", { skip }, () => {
  test("computes cost, stores metadata, and is idempotent per request_ref", () => {
    const a = recordUsage(ctx, "svc-coach", sonnet({ request_ref: "req-1" }));
    assert.deepEqual(a, { recorded: true, cost_micro_usd: 3000 });
    const b = recordUsage(ctx, "svc-coach", sonnet({ request_ref: "req-1" }));
    assert.equal(b.recorded, false);
    assert.equal(usageSummary(ctx, "24h").totals.requests, 1);
    // the same ref from a different service is a different request
    assert.equal(recordUsage(ctx, "svc-web", sonnet({ request_ref: "req-1" })).recorded, true);
  });

  test("unpriced models are recorded with NULL cost and flagged, never as free", () => {
    const r = recordUsage(ctx, "svc-coach", sonnet({ model: "gpt-5-mini", provider: "openai" }));
    assert.equal(r.cost_micro_usd, null);
    const s = usageSummary(ctx, "24h");
    assert.equal(s.totals.unpriced_requests, 1);
    assert.equal(s.totals.cost_micro_usd, 0);
  });

  test("a reported cost overrides the computed one", () => {
    assert.equal(recordUsage(ctx, "svc-coach", sonnet({ cost_micro_usd: 12345 })).cost_micro_usd, 12345);
  });

  test("no prompt or completion text is stored anywhere", () => {
    recordUsage(ctx, "svc-coach", sonnet({ prompt: "SECRET PROMPT", completion: "SECRET REPLY" } as never));
    const dump = JSON.stringify(recentEvents(ctx, 10));
    assert.ok(!dump.includes("SECRET"));
  });
});

describe("summary", { skip }, () => {
  test("aggregates totals, per app, per model, latency, errors and cache hits", () => {
    recordUsage(ctx, "svc-coach", sonnet({ duration_ms: 1000 }));
    recordUsage(ctx, "svc-coach", sonnet({ duration_ms: 3000, cache_read_tokens: 3000 }));
    recordUsage(
      ctx,
      "svc-coach",
      sonnet({
        status: "error",
        error_code: "provider_unavailable",
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0
      })
    );
    recordUsage(ctx, "svc-web", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      input_tokens: 500,
      output_tokens: 50,
      status: "ok",
      duration_ms: 500
    });
    const s = usageSummary(ctx, "7d");
    assert.equal(s.totals.requests, 4);
    assert.equal(s.totals.errors, 1);
    assert.equal(s.totals.error_rate, 0.25);
    assert.equal(s.by_service.length, 2);
    assert.equal((s.by_service[0] as { app_name: string }).app_name, "Coach");
    assert.equal(s.by_model.length, 2);
    assert.equal(s.error_codes[0].error_code, "provider_unavailable");
    assert.equal(s.totals.p50_ms, 1000);
    assert.equal(s.totals.p95_ms, 3000);
    assert.ok(Math.abs(s.totals.cache_hit_rate - 3000 / 5500) < 1e-9); // reads / (uncached input + reads + writes)
    // 3000 + (3000 + 600 cache read) + 0 + (500*1 + 50*5 = 750)
    assert.equal(s.totals.cost_micro_usd, 3000 + 3000 + 600 + 750);
    assert.equal(usageSummary(ctx, "7d", "svc-web").totals.requests, 1);
    assert.equal(s.series.length >= 1, true);
    assert.equal(s.gateway, null);
  });
});

describe("budgets and alerts", { skip }, () => {
  const notifications = () =>
    ctx.db.prepare("SELECT severity, title FROM notifications ORDER BY created_at").all() as Array<{
      severity: string;
      title: string;
    }>;

  test("alerts once at 80% and once at 100%, not on every call", () => {
    // each call costs $0.003; daily budget $0.01 -> 80% at 3 calls (0.009 >= 0.008), 100% at 4 (0.012)
    setBudgets(ctx, {
      global_daily_usd: null,
      per_service: { "svc-coach": { daily_usd: 0.01, monthly_usd: null } }
    });
    recordUsage(ctx, "svc-coach", sonnet());
    recordUsage(ctx, "svc-coach", sonnet());
    assert.equal(notifications().length, 0);
    recordUsage(ctx, "svc-coach", sonnet());
    assert.equal(notifications().length, 1);
    assert.equal(notifications()[0].severity, "warning");
    recordUsage(ctx, "svc-coach", sonnet());
    assert.equal(notifications().length, 2);
    assert.equal(notifications()[1].severity, "error");
    recordUsage(ctx, "svc-coach", sonnet());
    recordUsage(ctx, "svc-coach", sonnet());
    assert.equal(notifications().length, 2, "no repeats within the same day");
  });

  test("a global daily budget covers all apps", () => {
    setBudgets(ctx, { global_daily_usd: 0.005, per_service: {} });
    recordUsage(ctx, "svc-coach", sonnet());
    recordUsage(ctx, "svc-web", sonnet());
    assert.ok(notifications().some((n) => n.title.includes("All apps")));
  });

  test("invalid budgets are rejected", () => {
    assert.throws(() => setBudgets(ctx, { global_daily_usd: -1, per_service: {} }), /positive/);
  });
});

describe("routing", { skip }, () => {
  test("/api/ai-usage is an API path (gated) so only the explicit exemption is public", () => {
    assert.equal(isApiPath("/api/ai-usage/summary"), true);
    assert.equal(isApiPath("/api/ai-usage/connect/x"), true);
  });
});
