import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown } from "./services/runtime.js";

async function auth(ctx: Awaited<ReturnType<typeof buildApp>>): Promise<{ authorization: string }> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(login.statusCode, 200);
  return { authorization: `Bearer ${login.json().token as string}` };
}

function seedProject(ctx: Awaited<ReturnType<typeof buildApp>>): string {
  const id = nanoid();
  const now = nowIso();
  ctx.db
    .prepare(
      "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, `group-project-${id}`, "", "", now, now);
  return id;
}

function seedService(
  ctx: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  name: string,
  command = "true"
): string {
  const id = nanoid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO services (
        id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, name, "process", command, "/tmp", "", "", null, "stopped", 0, 0, 5, "manual", now, now);
  return id;
}

test("service groups create, list, update, delete selected parent services", async () => {
  const ctx = await buildApp();
  try {
    const headers = await auth(ctx);
    const projectId = seedProject(ctx);
    const apiId = seedService(ctx, projectId, "group-api");
    const webId = seedService(ctx, projectId, "group-web");
    const workerId = seedService(ctx, projectId, "group-worker");

    const create = await ctx.app.inject({
      method: "POST",
      url: "/service-groups",
      headers,
      payload: {
        name: "Launch set",
        description: "Things I want to operate together",
        serviceIds: [apiId, webId, apiId]
      }
    });
    assert.equal(create.statusCode, 200);
    const created = create.json() as { id: string; service_ids: string[]; services: Array<{ id: string }> };
    assert.deepEqual(created.service_ids.sort(), [apiId, webId].sort());
    assert.deepEqual(
      created.services.map((service) => service.id).sort(),
      [apiId, webId].sort()
    );

    const list = await ctx.app.inject({ method: "GET", url: "/service-groups", headers });
    assert.equal(list.statusCode, 200);
    const groups = list.json() as Array<{ id: string; name: string; service_ids: string[] }>;
    assert.equal(groups.find((group) => group.id === created.id)?.name, "Launch set");

    const update = await ctx.app.inject({
      method: "PUT",
      url: `/service-groups/${created.id}`,
      headers,
      payload: { name: "Daily ops", serviceIds: [workerId] }
    });
    assert.equal(update.statusCode, 200);
    assert.deepEqual((update.json() as { service_ids: string[] }).service_ids, [workerId]);

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/service-groups/${created.id}`,
      headers
    });
    assert.equal(remove.statusCode, 200);
    const memberCount = ctx.db
      .prepare("SELECT COUNT(*) AS count FROM service_group_members WHERE group_id = ?")
      .get(created.id) as { count: number };
    assert.equal(memberCount.count, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("service group start-all returns per-service results", async () => {
  const ctx = await buildApp();
  try {
    const headers = await auth(ctx);
    const projectId = seedProject(ctx);
    const one = seedService(ctx, projectId, "start-one", "true");
    const two = seedService(ctx, projectId, "start-two", "true");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/service-groups",
      headers,
      payload: { name: "Startable", serviceIds: [one, two] }
    });
    assert.equal(create.statusCode, 200);
    const groupId = (create.json() as { id: string }).id;

    const start = await ctx.app.inject({
      method: "POST",
      url: `/service-groups/${groupId}/start-all`,
      headers
    });
    assert.equal(start.statusCode, 200);
    const body = start.json() as { results: Array<{ serviceId: string; ok: boolean }> };
    assert.deepEqual(
      body.results.map((result) => result.serviceId).sort(),
      [one, two].sort()
    );
    assert.ok(body.results.every((result) => result.ok));
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("deleting a service removes it from service groups", async () => {
  const ctx = await buildApp();
  try {
    const headers = await auth(ctx);
    const projectId = seedProject(ctx);
    const serviceId = seedService(ctx, projectId, "delete-member");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/service-groups",
      headers,
      payload: { name: "Cleanup", serviceIds: [serviceId] }
    });
    assert.equal(create.statusCode, 200);

    const removeService = await ctx.app.inject({
      method: "DELETE",
      url: `/services/${serviceId}`,
      headers
    });
    assert.equal(removeService.statusCode, 200);

    const groups = (await ctx.app.inject({ method: "GET", url: "/service-groups", headers })).json() as Array<{
      id: string;
      service_ids: string[];
    }>;
    assert.deepEqual(groups.find((group) => group.id === (create.json() as { id: string }).id)?.service_ids, []);
  } finally {
    await gracefulShutdown(ctx);
  }
});
