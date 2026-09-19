import test from "node:test";
import assert from "node:assert";
import Fastify from "fastify";
import Database from "better-sqlite3";
import type { AppContext } from "./types.js";
import { collectSystemHealth } from "./services/health.js";
import { setSetting, setSecretSetting, getSetting, getSecretSetting } from "./services/settings.js";
import { registerSettingsRoutes } from "./routes/settings.js";

function setupTestCtx(): AppContext {
  const dbPath = `:memory:`;
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify({ logger: false });
  const ctx: AppContext = {
    db,
    app,
    config: {
      nodeEnv: "test",
      apiPort: 8787,
      host: "localhost",
      webSocketPath: "/ws",
      dataRoot: "/tmp/test",
      dbPath: dbPath,
      logsDir: "/tmp/test/logs",
      projectsDir: "/tmp/test/projects",
      serviceDataDir: "/tmp/test/service-data",
      certsDir: "/tmp/test/certs",
      scriptsDir: "/tmp/test/scripts",
      agentHomeDir: "/tmp/test/agents",
      backupsDir: "/tmp/test/backups",
      authToken: "test-token",
      secretKey: "test-secret-key-at-least-32-chars-long!!!",
      webhookSecret: "",
      webhookInsecure: false,
      webhookMaxSkewSeconds: 300,
      sessionTtlMs: 1000 * 60 * 60 * 12,
      secureCookies: false,
      trustedOrigins: [],
      defaultDevOrigins: [],
      adminResetToken: "",
      enableHttps: false,
      trustProxy: false,
      publicUrl: "",
      companionAppUrl: "",
      certPath: "",
      keyPath: "",
      healthcheckIntervalMs: 15000,
      gitPollIntervalMs: 60000,
      proxyPort: 80,
      terminalsEnabled: true,
      terminalMaxSessions: 24,
      terminalIdleTimeoutMs: 1000 * 60 * 45,
      mcpBaseUrl: ""
    },
    docker: {} as any,
    proxy: {} as any,
    wsSubscribers: new Set(),
    transferSubscribers: new Map(),
    terminalSubscribers: new Map(),
    terminalSessions: new Map(),
    runtimeProcesses: new Map(),
    actionLocks: new Set(),
    activeDeploys: new Set(),
    manuallyStopped: new Set(),
    shutdownTasks: []
  };
  return ctx;
}

test("memory alert settings: stores and retrieves config", async () => {
  const ctx = setupTestCtx();
  registerSettingsRoutes(ctx);
  await ctx.app.ready();

  const config = {
    enabled: true,
    threshold: 85,
    webhookUrl: "https://webhook.example.com/alerts",
    webhookAuth: "Bearer secret-token-123"
  };

  const putRes = await ctx.app.inject({
    method: "PUT",
    url: "/settings/alerts/memory",
    payload: config
  });

  assert.equal(putRes.statusCode, 200);
  assert.equal(getSetting(ctx, "host_memory_alert_enabled"), "1");
  assert.equal(getSetting(ctx, "host_memory_alert_threshold"), "85");
  assert.equal(getSecretSetting(ctx, "host_memory_alert_webhook_url"), config.webhookUrl);
  assert.equal(getSecretSetting(ctx, "host_memory_alert_webhook_auth"), config.webhookAuth);

  const getRes = await ctx.app.inject({
    method: "GET",
    url: "/settings/alerts/memory"
  });

  assert.equal(getRes.statusCode, 200);
  const body = JSON.parse(getRes.body);
  assert.equal(body.enabled, true);
  assert.equal(body.threshold, 85);
  assert.equal(body.webhookConfigured, true);
  assert.equal(body.authConfigured, true);
});

test("memory alert settings: delete removes all config", async () => {
  const ctx = setupTestCtx();
  registerSettingsRoutes(ctx);
  await ctx.app.ready();

  setSetting(ctx, "host_memory_alert_enabled", "1");
  setSetting(ctx, "host_memory_alert_threshold", "90");
  setSecretSetting(ctx, "host_memory_alert_webhook_url", "https://webhook.example.com");
  setSecretSetting(ctx, "host_memory_alert_webhook_auth", "Bearer token");

  const deleteRes = await ctx.app.inject({
    method: "DELETE",
    url: "/settings/alerts/memory"
  });

  assert.equal(deleteRes.statusCode, 200);
  assert.equal(getSetting(ctx, "host_memory_alert_enabled"), null);
  assert.equal(getSetting(ctx, "host_memory_alert_threshold"), null);
  assert.equal(getSecretSetting(ctx, "host_memory_alert_webhook_url"), null);
  assert.equal(getSecretSetting(ctx, "host_memory_alert_webhook_auth"), null);
});

test("memory alert settings: validates threshold range", async () => {
  const ctx = setupTestCtx();
  registerSettingsRoutes(ctx);
  await ctx.app.ready();

  const invalidConfig = {
    enabled: true,
    threshold: 150,
    webhookUrl: "https://webhook.example.com/alerts"
  };

  const putRes = await ctx.app.inject({
    method: "PUT",
    url: "/settings/alerts/memory",
    payload: invalidConfig
  });

  assert.ok(putRes.statusCode >= 400);
});

test("memory alert settings: webhook URL must be valid", async () => {
  const ctx = setupTestCtx();
  registerSettingsRoutes(ctx);
  await ctx.app.ready();

  const invalidConfig = {
    enabled: true,
    threshold: 80,
    webhookUrl: "not-a-valid-url"
  };

  const putRes = await ctx.app.inject({
    method: "PUT",
    url: "/settings/alerts/memory",
    payload: invalidConfig
  });

  assert.ok(putRes.statusCode >= 400);
});

test("collectSystemHealth: returns memory percentage", async () => {
  const ctx = setupTestCtx();
  ctx.docker.ping = async () => {};
  
  const health = await collectSystemHealth(ctx);
  
  assert.ok(typeof health.memoryUsedPercent === "number");
  assert.ok(health.memoryUsedPercent >= 0);
  assert.ok(health.memoryUsedPercent <= 100);
  assert.ok(health.checkedAt);
  assert.ok(typeof health.loadAvg1m === "number");
});
