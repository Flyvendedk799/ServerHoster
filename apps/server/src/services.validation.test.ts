import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { nowIso } from "./lib/core.js";

async function authedToken(ctx: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  return login.json().token as string;
}

function seedService(ctx: Awaited<ReturnType<typeof buildApp>>, name: string, port: number | null): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
    (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
     auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "p1",
      name,
      "process",
      "node x.js",
      "/tmp",
      "",
      "",
      port,
      "stopped",
      1,
      0,
      5,
      "manual",
      nowIso(),
      nowIso()
    );
  return id;
}

test("PATCH /services/:id: rejects invalid port", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-port-${Date.now()}`, 3000);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { port: 99999 }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { fields?: Record<string, string> };
    assert.ok(body.fields?.port);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("PATCH /services/:id: rejects port already in use", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const suffix = Date.now();
    seedService(ctx, `svc-a-${suffix}`, 4567);
    const idB = seedService(ctx, `svc-b-${suffix}`, 1234);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${idB}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { port: 4567 }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { fields?: Record<string, string> };
    assert.match(body.fields?.port ?? "", /in use/i);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("PATCH /services/:id: rejects malformed domain", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-dom-${Date.now()}`, 5000);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain: "not a domain" }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { fields?: Record<string, string> };
    assert.ok(body.fields?.domain);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("PATCH /services/:id: rejects missing working dir", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-wd-${Date.now()}`, 5001);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { workingDir: "/definitely/does/not/exist/survhub-test" }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { fields?: Record<string, string> };
    assert.ok(body.fields?.workingDir);
  } finally {
    await gracefulShutdown(ctx);
  }
});
