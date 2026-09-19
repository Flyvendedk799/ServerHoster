import test from "node:test";
import assert from "node:assert";
import Fastify from "fastify";
import { AppContext } from "./types.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerAuthRoutes } from "./routes/auth.js";
import Database from "better-sqlite3";
import { getDurableApiToken } from "./services/settings.js";

function setupTestCtx(): AppContext {
  const dbPath = `test-global-mcp-${Date.now()}.db`;
  const db = new Database(dbPath);
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  git_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  command TEXT,
  working_dir TEXT,
  docker_image TEXT,
  dockerfile TEXT,
  port INTEGER,
  status TEXT NOT NULL,
  auto_restart INTEGER NOT NULL DEFAULT 1,
  restart_count INTEGER NOT NULL DEFAULT 0,
  max_restarts INTEGER NOT NULL DEFAULT 5,
  stop_with_hoster INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_vars (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  port INTEGER NOT NULL,
  container_id TEXT,
  connection_string TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  commit_hash TEXT,
  status TEXT NOT NULL,
  build_log TEXT NOT NULL,
  artifact_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_routes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status_code INTEGER NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  shell_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  provider TEXT,
  profile_id TEXT,
  allow_mutations INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 24,
  cols INTEGER NOT NULL DEFAULT 80,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  install_status TEXT NOT NULL DEFAULT 'not_installed',
  auth_mode TEXT NOT NULL DEFAULT 'cli',
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  isolated_home TEXT NOT NULL,
  version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, provider, name)
);

CREATE TABLE IF NOT EXISTS agent_secrets (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, key)
);

CREATE TABLE IF NOT EXISTS mcp_session_tokens (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  terminal_session_id TEXT,
  token_hash TEXT NOT NULL,
  allow_mutations INTEGER NOT NULL DEFAULT 0,
  tool_policy TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_group_members (
  group_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, service_id)
);

CREATE TABLE IF NOT EXISTS saas_domains (
  id TEXT PRIMARY KEY,
  hostname TEXT,
  service_id TEXT
);

CREATE TABLE IF NOT EXISTS service_resource_links (id TEXT PRIMARY KEY, service_id TEXT, resource_id TEXT, resource_type TEXT, active INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS managed_resources (id TEXT PRIMARY KEY, profile TEXT, ports_json TEXT, config_json TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, count INTEGER);
`);
  
  try { db.exec("ALTER TABLE services ADD COLUMN ssl_status TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE services ADD COLUMN github_repo_url TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE services ADD COLUMN github_branch TEXT;"); } catch (e) {}
  db.exec("INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('test', 'test', 'hash', 'admin', 'now', 'now')");
  const app = Fastify();
  return {
    db,
    app,
    config: {
      port: 0,
      host: "localhost",
      dataDir: ".",
      projectsDir: ".",
      exposeCaddy: false
    } as any,
    activeDeploys: new Set(),
    docker: {} as any,
    proxy: {} as any,
    wsSubscribers: new Set(),
    transferSubscribers: new Map(),
    ...({} as any)
  };
}

test("Global MCP rejects unauthenticated requests", async () => {
  const ctx = setupTestCtx();
  ctx.app.decorate("ctx", ctx);
  registerAuthRoutes(ctx);
  registerMcpRoutes(ctx);
  
  try {
    const start = Date.now();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });
    const elapsed = Date.now() - start;
    
    assert.strictEqual(response.statusCode, 401);
    const data = response.json();
    assert.strictEqual(data.error.code, -32000);
    assert.ok(elapsed < 2000, `auth failure should be fast, took ${elapsed}ms`);
  } finally {
    await ctx.app.close();
    ctx.db.close();
  }
});

test("Global MCP accepts SURVHUB_AUTH_TOKEN", async () => {
  process.env.SURVHUB_AUTH_TOKEN = "global-test-token";
  const ctx = setupTestCtx();
  ctx.config.authToken = "global-test-token";
  ctx.app.decorate("ctx", ctx);
  registerAuthRoutes(ctx);
  registerMcpRoutes(ctx);
  
  try {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer global-test-token", accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        id: 1
      }
    });
    
    assert.strictEqual(response.statusCode, 200);
    const data = parseMcpJson(response.body);
    assert.strictEqual(data.id, 1);
    assert.ok(data.result.serverInfo.name === "serverhoster-control-plane");
  } finally {
    await ctx.app.close();
    ctx.db.close();
  }
});

test("Global MCP accepts durable API token", async () => {
  const ctx = setupTestCtx();
  ctx.config.authToken = "";
  ctx.config.secretKey = "test-secret-key-12345678901234567890123456789012";
  ctx.app.decorate("ctx", ctx);
  registerAuthRoutes(ctx);
  registerMcpRoutes(ctx);
  
  const durableToken = getDurableApiToken(ctx);
  assert.ok(durableToken);
  assert.strictEqual(durableToken.length, 40);
  
  try {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${durableToken}`, accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        id: 1
      }
    });
    
    assert.strictEqual(response.statusCode, 200);
    const data = parseMcpJson(response.body);
    assert.strictEqual(data.id, 1);
    assert.ok(data.result.serverInfo.name === "serverhoster-control-plane");
  } finally {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'api_token'").run();
    await ctx.app.close();
    ctx.db.close();
  }
});

test("Global MCP durable token initialize + list_services succeeds", async () => {
  const ctx = setupTestCtx();
  ctx.config.authToken = "";
  ctx.config.secretKey = "test-secret-key-12345678901234567890123456789012";
  ctx.app.decorate("ctx", ctx);
  registerAuthRoutes(ctx);
  registerMcpRoutes(ctx);

  ctx.db
    .prepare(
      "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run("p1", "demo", null, "now", "now");
  ctx.db
    .prepare(
      "INSERT INTO services (id, project_id, name, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run("s1", "p1", "web", "node", "stopped", "now", "now");

  const durableToken = getDurableApiToken(ctx);
  const headers = {
    authorization: `Bearer ${durableToken}`,
    accept: "application/json, text/event-stream"
  };

  try {
    const init = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        },
        id: 1
      }
    });
    assert.strictEqual(init.statusCode, 200);
    assert.strictEqual(parseMcpJson(init.body).result.serverInfo.name, "serverhoster-control-plane");

    const start = Date.now();
    const call = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "list_services", arguments: {} },
        id: 2
      }
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(call.statusCode, 200);
    assert.ok(elapsed < 5000, `list_services should return promptly, took ${elapsed}ms`);
    const result = parseMcpJson(call.body);
    assert.strictEqual(result.id, 2);
    assert.ok(!result.result?.isError, `tool error: ${JSON.stringify(result)}`);
    const payload = JSON.parse(result.result.content[0].text);
    assert.ok(Array.isArray(payload));
    assert.strictEqual(payload[0].name, "web");
  } finally {
    await ctx.app.close();
    ctx.db.close();
  }
});

test("Global MCP get_system_health fails fast when Docker hangs", async () => {
  const ctx = setupTestCtx();
  ctx.config.authToken = "";
  ctx.config.secretKey = "test-secret-key-12345678901234567890123456789012";
  let settleHang!: () => void;
  const hang = new Promise<void>((resolve) => {
    settleHang = resolve;
  });
  ctx.docker = {
    ping: async () => hang
  } as any;
  ctx.app.decorate("ctx", ctx);
  registerAuthRoutes(ctx);
  registerMcpRoutes(ctx);

  const durableToken = getDurableApiToken(ctx);
  try {
    const start = Date.now();
    const call = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${durableToken}`,
        accept: "application/json, text/event-stream"
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_system_health", arguments: {} },
        id: 3
      }
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(call.statusCode, 200);
    assert.ok(elapsed < 15_000, `get_system_health must not hang; took ${elapsed}ms`);
    const result = parseMcpJson(call.body);
    const health = JSON.parse(result.result.content[0].text);
    assert.strictEqual(health.dockerOk, false);
    assert.ok(String(health.dockerError || "").includes("timed out"));
  } finally {
    settleHang();
    await ctx.app.close();
    ctx.db.close();
  }
});

function parseMcpJson(body: string): any {
  // JSON response mode returns application/json; tolerate legacy SSE if present.
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No MCP JSON in body: ${body.slice(0, 200)}`);
  return JSON.parse(dataLine.substring(6));
}