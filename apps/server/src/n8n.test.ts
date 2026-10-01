/**
 * n8n add-on — container env contract, config validation and the workflow
 * import sanitizer. No Docker or network.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import { buildN8nEnv, getN8nConfig, sanitizeWorkflowForImport, validateN8nConfig } from "./services/n8n.js";
import { setSetting, setSecretSetting } from "./services/settings.js";

let ctx: AppContext;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT, status_code INTEGER NOT NULL, details TEXT, created_at TEXT NOT NULL
    );
  `);
  ctx = {
    db,
    config: { secretKey: "test-secret-key-32-bytes-not-for-prod", serviceDataDir: "/tmp/sd", apiPort: 8787 },
    wsSubscribers: new Set()
  } as unknown as AppContext;
});

function envMap(env: string[]): Map<string, string> {
  return new Map(env.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

describe("n8n env", () => {
  test("defaults: encryption key, loopback webhook, insecure-cookie for http, pruning", () => {
    const env = envMap(buildN8nEnv(ctx));
    assert.ok(env.get("N8N_ENCRYPTION_KEY"));
    assert.equal(env.get("WEBHOOK_URL"), "http://127.0.0.1:5678/");
    assert.equal(env.get("N8N_SECURE_COOKIE"), "false");
    assert.equal(env.get("EXECUTIONS_DATA_PRUNE"), "true");
    assert.equal(env.get("EXECUTIONS_DATA_MAX_AGE"), "336");
    assert.equal(env.get("N8N_RUNNERS_ENABLED"), "true");
    // n8n has no such variable — the Public API key is created in the UI.
    assert.equal(env.has("N8N_API_KEY"), false);
    // Stable across calls (key is persisted, not regenerated).
    assert.equal(envMap(buildN8nEnv(ctx)).get("N8N_ENCRYPTION_KEY"), env.get("N8N_ENCRYPTION_KEY"));
  });

  test("https public URL drives host/protocol/editor URL and keeps secure cookies", () => {
    setSetting(ctx, "n8n_public_url", "https://flows.example.com");
    const env = envMap(buildN8nEnv(ctx));
    assert.equal(env.get("N8N_HOST"), "flows.example.com");
    assert.equal(env.get("N8N_PROTOCOL"), "https");
    assert.equal(env.get("WEBHOOK_URL"), "https://flows.example.com/");
    assert.equal(env.get("N8N_EDITOR_BASE_URL"), "https://flows.example.com/");
    assert.equal(env.get("N8N_PROXY_HOPS"), "1");
    assert.equal(env.has("N8N_SECURE_COOKIE"), false);
  });

  test("config: timezone, shared SMTP and extra env (managed keys protected)", () => {
    setSetting(ctx, "smtp_host", "smtp.example.com");
    setSetting(ctx, "smtp_port", "587");
    setSetting(ctx, "smtp_from", "noreply@example.com");
    setSecretSetting(ctx, "smtp_password", "pw");
    setSetting(
      ctx,
      "n8n_config",
      JSON.stringify({
        timezone: "Europe/Copenhagen",
        useSharedSmtp: true,
        pruneEnabled: false,
        extraEnv: { N8N_LOG_LEVEL: "debug", WEBHOOK_URL: "https://evil", N8N_RUNNERS_ENABLED: "false" }
      })
    );
    const env = envMap(buildN8nEnv(ctx));
    assert.equal(env.get("GENERIC_TIMEZONE"), "Europe/Copenhagen");
    assert.equal(env.get("N8N_EMAIL_MODE"), "smtp");
    assert.equal(env.get("N8N_SMTP_SSL"), "false");
    assert.equal(env.get("N8N_SMTP_PASS"), "pw");
    assert.equal(env.get("EXECUTIONS_DATA_PRUNE"), "false");
    assert.equal(env.has("EXECUTIONS_DATA_MAX_AGE"), false);
    assert.equal(env.get("N8N_LOG_LEVEL"), "debug");
    assert.equal(env.get("WEBHOOK_URL"), "http://127.0.0.1:5678/");
    // Unmanaged defaults can be overridden by the operator.
    assert.equal(env.get("N8N_RUNNERS_ENABLED"), "false");
    assert.equal(buildN8nEnv(ctx).filter((l) => l.startsWith("N8N_RUNNERS_ENABLED=")).length, 1);
  });

  test("config validation", () => {
    assert.throws(() => validateN8nConfig({ timezone: "Mars/Olympus" }), /Unknown timezone/);
    assert.throws(() => validateN8nConfig({ imageTag: "latest; rm -rf" }), /Image tag/);
    assert.throws(() => validateN8nConfig({ extraEnv: { N8N_ENCRYPTION_KEY: "x" } }), /managed/);
    assert.throws(() => validateN8nConfig({ pruneMaxAgeHours: 0 }), /Prune age/);
    assert.deepEqual(validateN8nConfig({ imageTag: " ", timezone: "UTC" }), { imageTag: "latest", timezone: "UTC" });
    assert.equal(getN8nConfig(ctx).imageTag, "latest");
  });
});

describe("workflow import", () => {
  test("strips fields the Public API rejects", () => {
    const out = sanitizeWorkflowForImport({
      id: "42",
      name: "My flow",
      active: true,
      tags: [{ name: "x" }],
      pinData: {},
      versionId: "v",
      nodes: [{ name: "n", type: "n8n-nodes-base.noOp" }],
      connections: {},
      settings: { executionOrder: "v1", callerPolicy: "any", unknownThing: 1, timezone: "UTC" }
    });
    assert.deepEqual(Object.keys(out).sort(), ["connections", "name", "nodes", "settings"]);
    assert.deepEqual(out.settings, { executionOrder: "v1", timezone: "UTC" });
    assert.throws(() => sanitizeWorkflowForImport({ name: "empty", nodes: [] }), /no nodes/);
  });
});
