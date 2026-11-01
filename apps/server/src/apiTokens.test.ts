import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  API_TOKEN_PREFIX,
  LAST_USED_THROTTLE_MS,
  apiTokenRequestAllowed,
  createApiToken,
  ensureApiTokensTable,
  hashApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken
} from "./services/apiTokens.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  ensureApiTokensTable(db);
  return db;
}

// --- Service ---------------------------------------------------------------

test("api tokens: created token is prefixed, stored only as a hash, and verifies", () => {
  const db = memoryDb();
  const { token, info } = createApiToken(db, { name: "claude-automation" });
  assert.ok(token.startsWith(API_TOKEN_PREFIX));
  assert.ok(token.length >= 40);
  assert.ok(token.startsWith(info.tokenPrefix));
  assert.deepEqual(info.scopes, ["admin"]);
  assert.equal(info.expiresAt, null);
  assert.equal(info.status, "active");

  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(info.id) as Record<string, unknown>;
  assert.equal(row.token_hash, hashApiToken(token));
  for (const value of Object.values(row)) {
    assert.notEqual(value, token, "the plaintext must never be stored");
  }

  const resolved = resolveApiToken(db, token);
  assert.equal(resolved?.id, info.id);
  assert.equal(resolveApiToken(db, `${token}x`), null);
  assert.equal(resolveApiToken(db, "not-a-token"), null);
  // Listing never carries the secret or its hash.
  const listed = JSON.stringify(listApiTokens(db));
  assert.ok(!listed.includes(token));
  assert.ok(!listed.includes(hashApiToken(token)));
});

test("api tokens: revoked and expired tokens are rejected", () => {
  const db = memoryDb();
  const now = Date.now();
  const revoked = createApiToken(db, { name: "revoked" }, now);
  const result = revokeApiToken(db, revoked.info.id, {}, now);
  assert.ok(result.ok && !result.alreadyRevoked);
  assert.equal(resolveApiToken(db, revoked.token, now), null);
  assert.equal(listApiTokens(db, now).find((t) => t.id === revoked.info.id)?.status, "revoked");

  const expiring = createApiToken(db, { name: "short", expiresInDays: 1 }, now);
  assert.ok(resolveApiToken(db, expiring.token, now + 1000));
  const afterExpiry = now + 24 * 60 * 60 * 1000 + 1;
  assert.equal(resolveApiToken(db, expiring.token, afterExpiry), null);
  assert.equal(listApiTokens(db, afterExpiry).find((t) => t.id === expiring.info.id)?.status, "expired");

  assert.throws(() => createApiToken(db, { name: "  " }));
  assert.throws(() => createApiToken(db, { name: "x", expiresInDays: 0 }));
});

test("api tokens: last_used_at is throttled", () => {
  const db = memoryDb();
  const now = Date.now();
  const { token, info } = createApiToken(db, { name: "t" }, now);
  const lastUsed = () =>
    (
      db.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").get(info.id) as {
        last_used_at: string | null;
      }
    ).last_used_at;
  resolveApiToken(db, token, now);
  const first = lastUsed();
  assert.equal(first, new Date(now).toISOString());
  resolveApiToken(db, token, now + 1000);
  assert.equal(lastUsed(), first, "a second use within the window must not write");
  resolveApiToken(db, token, now + LAST_USED_THROTTLE_MS + 1);
  assert.equal(lastUsed(), new Date(now + LAST_USED_THROTTLE_MS + 1).toISOString());
});

test("api tokens: revoke by prefix refuses ambiguity", () => {
  const db = memoryDb();
  const a = createApiToken(db, { name: "a" });
  createApiToken(db, { name: "b" });
  const ambiguous = revokeApiToken(db, API_TOKEN_PREFIX, { allowPrefix: true });
  assert.ok(!ambiguous.ok && ambiguous.reason === "ambiguous");
  const byPrefix = revokeApiToken(db, a.info.tokenPrefix, { allowPrefix: true });
  assert.ok(byPrefix.ok && byPrefix.info.id === a.info.id);
  // Without allowPrefix (the HTTP API) only an exact id matches.
  const b = listApiTokens(db).find((t) => t.name === "b")!;
  assert.ok(!revokeApiToken(db, b.tokenPrefix).ok);
});

test("api tokens: admin scope covers the API but never token management", () => {
  assert.equal(apiTokenRequestAllowed(["admin"], "POST", "/services/abc/restart"), true);
  assert.equal(apiTokenRequestAllowed(["admin"], "GET", "/auth/tokens"), false);
  assert.equal(apiTokenRequestAllowed(["admin"], "DELETE", "/auth/tokens/abc"), false);
  assert.equal(apiTokenRequestAllowed([], "GET", "/projects"), false);
});

// --- HTTP ------------------------------------------------------------------

function enablePasswordAuth(ctx: Ctx): void {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db.prepare("DELETE FROM api_tokens").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
}

async function login(ctx: Ctx): Promise<string> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(resp.statusCode, 200);
  return resp.json().token as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("api tokens over HTTP: session mints, token authenticates and survives a session wipe", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/auth/tokens",
      headers: bearer(session),
      payload: { name: "claude", expiresInDays: 30 }
    });
    assert.equal(created.statusCode, 200);
    const body = created.json();
    assert.ok(String(body.token).startsWith(API_TOKEN_PREFIX));
    assert.equal(body.name, "claude");
    assert.ok(body.expiresAt);

    const listed = await ctx.app.inject({ method: "GET", url: "/auth/tokens", headers: bearer(session) });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().tokens.length, 1);
    assert.ok(!listed.body.includes(body.token), "the list must not leak the secret");

    // A restart that empties the sessions table must not lock automation out.
    ctx.db.prepare("DELETE FROM sessions").run();
    const asToken = await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(body.token) });
    assert.equal(asToken.statusCode, 200);
    const asOldSession = await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(session) });
    assert.equal(asOldSession.statusCode, 401);

    // Mutating requests made with the token are audited under it.
    const write = await ctx.app.inject({ method: "POST", url: "/auth/logout", headers: bearer(body.token) });
    assert.equal(write.statusCode, 200);
    const audit = ctx.db
      .prepare("SELECT actor, action, resource_type FROM audit_logs WHERE actor = ? ORDER BY created_at DESC")
      .all(`apitoken:${body.id}`) as Array<{ actor: string; action: string; resource_type: string }>;
    assert.ok(audit.some((a) => a.action === "POST /auth/logout" && a.resource_type === "api_token"));
    // …and logging out with it does not revoke it.
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(body.token) })).statusCode,
      200
    );

    // Revoke from a fresh session; the token stops working immediately.
    const session2 = await login(ctx);
    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/tokens/${body.id}`,
      headers: bearer(session2)
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().token.status, "revoked");
    const afterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/projects",
      headers: bearer(body.token)
    });
    assert.equal(afterRevoke.statusCode, 401);
    const missing = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/tokens/nope",
      headers: bearer(session2)
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("api tokens over HTTP: an API token cannot list, mint or revoke tokens", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const { token, info } = createApiToken(ctx.db, { name: "agent" });
    for (const req of [
      { method: "GET" as const, url: "/auth/tokens" },
      { method: "POST" as const, url: "/auth/tokens", payload: { name: "escalate" } },
      { method: "DELETE" as const, url: `/auth/tokens/${info.id}` }
    ]) {
      const resp = await ctx.app.inject({ ...req, headers: bearer(token) });
      assert.equal(resp.statusCode, 403, `${req.method} ${req.url}`);
      assert.equal(resp.json().code, "API_TOKEN_SCOPE_DENIED");
    }
    assert.equal(listApiTokens(ctx.db).length, 1, "no token may have been minted");
    assert.equal(listApiTokens(ctx.db)[0].status, "active", "and none revoked");

    // The legacy durable settings token is a machine credential too.
    const durable = await ctx.app.inject({
      method: "GET",
      url: "/settings/api-token/reveal",
      headers: bearer(await login(ctx))
    });
    const legacy = await ctx.app.inject({
      method: "POST",
      url: "/auth/tokens",
      headers: bearer(durable.json().token),
      payload: { name: "escalate" }
    });
    assert.equal(legacy.statusCode, 403);

    // Nor can an API token copy or plant another long-lived credential that
    // would survive its own revocation.
    const escalations: Array<{
      method: "GET" | "POST" | "PUT" | "DELETE";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/settings/api-token/reveal" },
      { method: "POST", url: "/settings/api-token/rotate" },
      { method: "POST", url: "/saas/token/rotate" },
      { method: "POST", url: "/companion/pairings", payload: {} },
      { method: "PUT", url: "/settings", payload: { key: "api_token", value: "planted" } },
      { method: "PUT", url: "/settings", payload: { key: "dashboard_password", value: "planted" } },
      { method: "DELETE", url: "/settings/dashboard_password" }
    ];
    for (const req of escalations) {
      const resp = await ctx.app.inject({ ...req, headers: bearer(token) });
      assert.equal(resp.statusCode, 403, `${req.method} ${req.url} ${JSON.stringify(req.payload ?? {})}`);
      assert.equal(resp.json().code, "API_TOKEN_SCOPE_DENIED");
    }
    const pw = ctx.db.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").get() as {
      value: string;
    };
    assert.equal(pw.value, "test-pass", "the dashboard password must be untouched");
    // Ordinary settings and the masked token view stay available.
    assert.equal(
      (
        await ctx.app.inject({
          method: "PUT",
          url: "/settings",
          headers: bearer(token),
          payload: { key: "api_tokens_test_flag", value: "1" }
        })
      ).statusCode,
      200
    );
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/settings/api-token", headers: bearer(token) }))
        .statusCode,
      200
    );

    // Revoked / expired / unknown tokens are plain 401s.
    revokeApiToken(ctx.db, info.id);
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(token) })).statusCode,
      401
    );
    const expired = createApiToken(ctx.db, { name: "old", expiresInDays: 1 }, Date.now() - 2 * 86_400_000);
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(expired.token) })).statusCode,
      401
    );
    assert.equal(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/projects",
          headers: bearer(`${API_TOKEN_PREFIX}bogus-bogus`)
        })
      ).statusCode,
      401
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("api tokens over HTTP: SURVHUB_AUTH_TOKEN can manage tokens even when it seeded the durable token", async () => {
  const ctx = await buildApp();
  const previous = ctx.config.authToken;
  try {
    enablePasswordAuth(ctx);
    ctx.config.authToken = "host-root-token-for-tests";
    // First-start seeding: the durable token takes the env value.
    ctx.db.prepare("DELETE FROM settings WHERE key = 'api_token'").run();
    const listed = await ctx.app.inject({
      method: "GET",
      url: "/auth/tokens",
      headers: bearer("host-root-token-for-tests")
    });
    assert.equal(listed.statusCode, 200);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/auth/tokens",
      headers: bearer("host-root-token-for-tests"),
      payload: { name: "from-host" }
    });
    assert.equal(created.statusCode, 200);
  } finally {
    ctx.config.authToken = previous;
    ctx.db.prepare("DELETE FROM settings WHERE key = 'api_token'").run();
    await gracefulShutdown(ctx);
  }
});

test("api tokens over HTTP: the session flow is unchanged", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/projects" })).statusCode, 401);
    const session = await login(ctx);
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(session) })).statusCode,
      200
    );
    await ctx.app.inject({ method: "POST", url: "/auth/logout", headers: bearer(session) });
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/projects", headers: bearer(session) })).statusCode,
      401
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

// --- CLI -------------------------------------------------------------------

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

function runCli(dataDir: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, SURVHUB_DATA_DIR: dataDir }
  });
}

test("survhub token CLI: create, list and revoke against a temp database", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-token-cli-"));
  try {
    // No database yet: refuse rather than create one in the wrong place.
    const noDb = runCli(dataDir, ["token", "list"]);
    assert.equal(noDb.status, 1);

    // An existing database from a build that predates api_tokens.
    new Database(path.join(dataDir, "survhub.db")).close();

    const missingName = runCli(dataDir, ["token", "create"]);
    assert.equal(missingName.status, 2);

    // A dangling --expires-days must not silently mint a permanent token.
    const danglingExpiry = runCli(dataDir, ["token", "create", "--name", "x", "--expires-days"]);
    assert.equal(danglingExpiry.status, 2);
    const emptyExpiry = runCli(dataDir, ["token", "create", "--name", "x", "--expires-days="]);
    assert.equal(emptyExpiry.status, 2);

    const created = runCli(dataDir, ["token", "create", "--name", "claude", "--expires-days", "90"]);
    assert.equal(created.status, 0, created.stderr);
    const token = created.stdout.match(/shk_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(token, created.stdout);

    const quiet = runCli(dataDir, ["token", "create", "--name=ci", "--quiet"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.match(quiet.stdout, /^shk_[A-Za-z0-9_-]+\n$/);

    const db = new Database(path.join(dataDir, "survhub.db"));
    try {
      assert.ok(resolveApiToken(db, token!), "the CLI-minted token must verify");
    } finally {
      db.close();
    }

    const listed = runCli(dataDir, ["token", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /claude/);
    assert.match(listed.stdout, /\bci\b/);
    assert.ok(!listed.stdout.includes(token!), "list must not print the secret");

    const prefix = token!.slice(0, 12);
    const revoked = runCli(dataDir, ["token", "revoke", prefix]);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.match(revoked.stdout, /Revoked API token "claude"/);

    const db2 = new Database(path.join(dataDir, "survhub.db"));
    try {
      assert.equal(resolveApiToken(db2, token!), null, "a revoked token must stop verifying");
    } finally {
      db2.close();
    }

    const unknown = runCli(dataDir, ["token", "revoke", "does-not-exist"]);
    assert.equal(unknown.status, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
