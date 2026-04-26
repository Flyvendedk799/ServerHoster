import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";

test("auth login and protected route", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "test-pass" }
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().token as string;
    assert.ok(token);

    const protectedResp = await ctx.app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(protectedResp.statusCode, 200);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("backup import/export roundtrip basic", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: "test-pass" } });
    const token = login.json().token as string;

    const createProject = await ctx.app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "backup-test" }
    });
    assert.equal(createProject.statusCode, 200);

    const exported = await ctx.app.inject({
      method: "GET",
      url: "/backup/export",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(exported.statusCode, 200);
    const payload = exported.json() as { data: Record<string, unknown[]> };
    assert.ok(Array.isArray(payload.data.projects));

    const imported = await ctx.app.inject({
      method: "POST",
      url: "/backup/import",
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    assert.equal(imported.statusCode, 200);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("bootstrap user and username login", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db.prepare("DELETE FROM users").run();
    ctx.db.prepare("DELETE FROM settings WHERE key = 'dashboard_password'").run();
    const bootstrap = await ctx.app.inject({
      method: "POST",
      url: "/auth/bootstrap",
      payload: { username: "admin", password: "supersecret" }
    });
    assert.equal(bootstrap.statusCode, 200);

    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "supersecret" }
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().token as string;
    assert.ok(token);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("railway migration dry run", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "test-pass" }
    });
    const token = login.json().token as string;
    const dryRun = await ctx.app.inject({
      method: "POST",
      url: "/migrations/railway/import",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        dryRun: true,
        projects: [{ name: "demo", services: [{ name: "api", type: "docker", image: "nginx:latest" }] }]
      }
    });
    assert.equal(dryRun.statusCode, 200);
    const payload = dryRun.json() as { dryRun: boolean; summary: Array<{ project: string; services: number }> };
    assert.equal(payload.dryRun, true);
    assert.equal(payload.summary[0]?.project, "demo");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("bootstrap without bearer when dashboard password is configured (no users yet)", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db.prepare("DELETE FROM users").run();
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'gate-pass')").run();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bootstrap",
      payload: { username: "bootstrap-gate-user", password: "longenough" }
    });
    assert.equal(res.statusCode, 200);
    ctx.db.prepare("DELETE FROM users WHERE username = 'bootstrap-gate-user'").run();
    ctx.db.prepare("DELETE FROM settings WHERE key = 'dashboard_password'").run();
  } finally {
    await gracefulShutdown(ctx);
  }
});
