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

test("GET /services/:id/exposure: returns capabilities (regression: no 'domain' column crash)", async () => {
  // getExposure used to `SELECT ... domain ... FROM services`, but domain lives
  // in proxy_routes — so it threw "no such column: domain" and 500'd every Go
  // Public open. This asserts the wizard's data loads.
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-exposure-${Date.now()}`, 3210);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/services/${id}/exposure`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      capabilities?: { hasCloudflaredBinary?: boolean };
      service?: { id?: string; domain?: string | null };
    };
    assert.ok(body.capabilities, "exposure should include capabilities");
    assert.equal(body.service?.id, id);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("GET /services/:id/certificate: 404 (not 500) for a service with no bound domain", async () => {
  // Regression: the handler used to SELECT services.domain (no such column) → 500.
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-cert-${Date.now()}`, 3301);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/services/${id}/certificate`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 404);
    assert.match((res.json() as { error?: string }).error ?? "", /no domain/i);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("POST /expose/domain: surfaces a 422 (not 500) when Cloudflare isn't configured", async () => {
  // Regression for TWO fixes: the services.domain query no longer 500s, and the
  // global error handler now honors statusCode (the guard throws a 422).
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-bind-${Date.now()}`, 3302);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/services/${id}/expose/domain`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain: "app.example.com" }
    });
    // The point of this regression: a deliberate client error surfaces as 422
    // (not 500). Both unconfigured paths (no API token / no Cloudflare zone) are
    // 422, so we don't over-assert the exact message.
    assert.equal(res.statusCode, 422);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("POST /backup/import: drops unknown columns instead of 500ing or injecting", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const now = nowIso();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/backup/import",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        data: {
          projects: [
            { id: "imp-proj-1", name: "Imported", created_at: now, updated_at: now, evil_unknown_col: "x" }
          ]
        }
      }
    });
    assert.equal(res.statusCode, 200);
    const row = ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get("imp-proj-1") as
      | { name?: string }
      | undefined;
    assert.equal(row?.name, "Imported");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("POST /services/:id/force-restart: recovers a service wedged at 'stopping'", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-stuck-${Date.now()}`, 3100);
    // Simulate the wedged state the user hit: status pinned at "stopping" with a
    // held action lock, and a runtime that no longer exists. A fast, harmless
    // command + auto_restart off keeps the follow-up start deterministic.
    ctx.db
      .prepare("UPDATE services SET status = 'stopping', command = 'true', auto_restart = 0 WHERE id = ?")
      .run(id);
    ctx.actionLocks.add(id);

    // A normal restart can't break out of the stuck lock.
    const blocked = await ctx.app.inject({
      method: "POST",
      url: `/services/${id}/restart`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(blocked.statusCode, 500);
    assert.ok(ctx.actionLocks.has(id), "stuck lock should still be held after a blocked restart");

    // Force restart breaks the lock and moves the service out of "stopping".
    const forced = await ctx.app.inject({
      method: "POST",
      url: `/services/${id}/force-restart`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(forced.statusCode, 200);
    assert.equal((forced.json() as { ok?: boolean }).ok, true);
    assert.equal(ctx.actionLocks.has(id), false, "force restart should release the action lock");
    const status = (
      ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(id) as { status: string }
    ).status;
    assert.notEqual(status, "stopping");
  } finally {
    await gracefulShutdown(ctx);
  }
});

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

test("PATCH /services/:id: alwaysOn applies and removes the 24/7 runtime preset", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-always-${Date.now()}`, 3009);
    const enable = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { alwaysOn: true }
    });
    assert.equal(enable.statusCode, 200);
    let row = ctx.db
      .prepare("SELECT auto_restart, start_mode, stop_with_hoster FROM services WHERE id = ?")
      .get(id) as { auto_restart: number; start_mode: string; stop_with_hoster: number };
    assert.equal(row.auto_restart, 1);
    assert.equal(row.start_mode, "auto");
    assert.equal(row.stop_with_hoster, 0);

    const disable = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { alwaysOn: false }
    });
    assert.equal(disable.statusCode, 200);
    row = ctx.db
      .prepare("SELECT auto_restart, start_mode, stop_with_hoster FROM services WHERE id = ?")
      .get(id) as { auto_restart: number; start_mode: string; stop_with_hoster: number };
    assert.equal(row.auto_restart, 1, "default auto-restart can stay enabled outside 24/7 mode");
    assert.equal(row.start_mode, "manual");
    assert.equal(row.stop_with_hoster, 1);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("PATCH /services/:id: alwaysOn updates a running Docker container restart policy", async () => {
  const ctx = await buildApp();
  const dockerUpdates: unknown[] = [];
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, `svc-always-docker-${Date.now()}`, 3010);
    ctx.db.prepare("UPDATE services SET type = 'docker' WHERE id = ?").run(id);
    (ctx as { docker: unknown }).docker = {
      getContainer: (name: string) => {
        assert.equal(name, `survhub-${id}`);
        return {
          update: async (opts: unknown) => {
            dockerUpdates.push(opts);
          }
        };
      }
    };

    const enable = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { alwaysOn: true }
    });
    assert.equal(enable.statusCode, 200);

    const disable = await ctx.app.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { alwaysOn: false }
    });
    assert.equal(disable.statusCode, 200);
    assert.deepEqual(dockerUpdates, [
      { RestartPolicy: { Name: "unless-stopped" } },
      { RestartPolicy: { Name: "no" } }
    ]);
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
