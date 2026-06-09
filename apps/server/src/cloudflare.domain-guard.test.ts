import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { nowIso } from "./lib/core.js";

function seedService(ctx: Awaited<ReturnType<typeof buildApp>>, name: string, port: number): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "p1", name, "process", "node x.js", "/tmp", "", "", port, "running", 1, 0, 5, "manual", nowIso(), nowIso());
  return id;
}

async function tokenFor(ctx: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { password: "test-pass" } });
  return login.json().token as string;
}

test("expose/domain: a domain already bound to another service is rejected with 409 DOMAIN_IN_USE", async () => {
  const ctx = await buildApp();
  try {
    const token = await tokenFor(ctx);
    ctx.db.prepare("DELETE FROM proxy_routes").run(); // isolate from sibling tests (shared temp DB)
    const owner = seedService(ctx, "Mast3kMedia", 8000);
    const other = seedService(ctx, "FM_ECOM", 3333);
    // owner already owns the domain
    ctx.db
      .prepare("INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(nanoid(), owner, "mast3kmedia.dk", 8000, nowIso());

    const resp = await ctx.app.inject({
      method: "POST",
      url: `/services/${other}/expose/domain`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain: "mast3kmedia.dk" }
    });
    assert.equal(resp.statusCode, 409, "binding another service's domain must conflict");
    assert.match(resp.json().error ?? resp.body, /already routed to "Mast3kMedia"/);
    // the owner's route must be untouched
    const stillOwned = ctx.db
      .prepare("SELECT service_id FROM proxy_routes WHERE domain = ?")
      .all("mast3kmedia.dk") as Array<{ service_id: string }>;
    assert.deepEqual(
      stillOwned.map((r) => r.service_id),
      [owner],
      "the conflicting bind must not have inserted a second row for the domain"
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("expose/domain: a different domain passes the guard (fails later, not on conflict)", async () => {
  const ctx = await buildApp();
  try {
    const token = await tokenFor(ctx);
    ctx.db.prepare("DELETE FROM proxy_routes").run(); // isolate from sibling tests (shared temp DB)
    const owner = seedService(ctx, "Mast3kMedia", 8000);
    const other = seedService(ctx, "FM_ECOM", 3333);
    ctx.db
      .prepare("INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(nanoid(), owner, "mast3kmedia.dk", 8000, nowIso());

    const resp = await ctx.app.inject({
      method: "POST",
      url: `/services/${other}/expose/domain`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain: "fm-ecom.example.com" }
    });
    // No Cloudflare connected + no API token in this test env → it gets past the
    // cross-service guard and fails downstream (422), NOT with a 409 conflict.
    assert.notEqual(
      resp.statusCode,
      409,
      `a distinct domain must not be treated as a conflict (got ${resp.statusCode}: ${resp.body})`
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});
