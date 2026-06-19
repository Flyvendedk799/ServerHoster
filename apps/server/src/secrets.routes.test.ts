import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { getServiceEnvWithLinks, gracefulShutdown } from "./services/runtime.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function seedProjectAndService(ctx: Ctx): { projectId: string; serviceId: string } {
  const projectId = nanoid();
  const serviceId = nanoid();
  ctx.db
    .prepare(
      "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, '', '', ?, ?)"
    )
    .run(projectId, "secret-test-project", nowIso(), nowIso());
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'process', 'node index.js', '/tmp', '', '', 0, 'stopped', 1, 0, 5, 'manual', ?, ?)`
    )
    .run(serviceId, projectId, "gamehub", nowIso(), nowIso());
  return { projectId, serviceId };
}

function enablePasswordAuth(ctx: Ctx): void {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
}

async function login(ctx: Ctx): Promise<string> {
  enablePasswordAuth(ctx);
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(resp.statusCode, 200);
  return resp.json().token as string;
}

test("secret routes require auth, mask values, and inject decrypted runtime env", async () => {
  const ctx = await buildApp();
  try {
    const { projectId, serviceId } = seedProjectAndService(ctx);
    enablePasswordAuth(ctx);
    const unauthorized = await ctx.app.inject({ method: "GET", url: "/secrets" });
    assert.equal(unauthorized.statusCode, 401);

    const token = await login(ctx);
    const serviceSecret = "ghp_platform_api_key_for_gamehub_123456789";
    const createServiceSecret = await ctx.app.inject({
      method: "POST",
      url: "/secrets/service",
      headers: { authorization: `Bearer ${token}` },
      payload: { serviceId, key: "PLATFORM_API_KEY", value: serviceSecret }
    });
    assert.equal(createServiceSecret.statusCode, 200);
    const created = createServiceSecret.json() as {
      secret: { id: string; value_preview: string; linked_services: Array<{ id: string }> };
      redeploy_required: boolean;
      message: string;
    };
    assert.equal(created.redeploy_required, true);
    assert.match(created.message, /Redeploy or restart/);
    assert.notEqual(created.secret.value_preview, serviceSecret);
    assert.equal(created.secret.linked_services[0]?.id, serviceId);

    const rawServiceRow = ctx.db
      .prepare("SELECT value, is_secret FROM env_vars WHERE service_id = ? AND key = ?")
      .get(serviceId, "PLATFORM_API_KEY") as { value: string; is_secret: number };
    assert.equal(rawServiceRow.is_secret, 1);
    assert.notEqual(rawServiceRow.value, serviceSecret);
    assert.ok(!rawServiceRow.value.includes(serviceSecret), "service secret must be encrypted at rest");
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).PLATFORM_API_KEY, serviceSecret);

    const envResp = await ctx.app.inject({
      method: "GET",
      url: `/services/${serviceId}/env`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(envResp.statusCode, 200);
    assert.ok(!envResp.body.includes(serviceSecret), "service env API must not return raw secrets");

    const sharedSecret = "shared_webhook_secret_for_project_987654321";
    const createSharedSecret = await ctx.app.inject({
      method: "POST",
      url: "/secrets/shared",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId, key: "WEBHOOK_SHARED_SECRET", value: sharedSecret }
    });
    assert.equal(createSharedSecret.statusCode, 200);
    const rawProjectRow = ctx.db
      .prepare("SELECT value, is_secret FROM project_env_vars WHERE project_id = ? AND key = ?")
      .get(projectId, "WEBHOOK_SHARED_SECRET") as { value: string; is_secret: number };
    assert.equal(rawProjectRow.is_secret, 1);
    assert.notEqual(rawProjectRow.value, sharedSecret);
    assert.ok(!rawProjectRow.value.includes(sharedSecret), "shared secret must be encrypted at rest");
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).WEBHOOK_SHARED_SECRET, sharedSecret);

    const projectEnvResp = await ctx.app.inject({
      method: "GET",
      url: `/projects/${projectId}/env`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(projectEnvResp.statusCode, 200);
    assert.ok(!projectEnvResp.body.includes(sharedSecret), "project env API must not return raw secrets");

    const inventory = await ctx.app.inject({
      method: "GET",
      url: "/secrets",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(inventory.statusCode, 200);
    assert.ok(!inventory.body.includes(serviceSecret), "inventory must not leak service secret plaintext");
    assert.ok(!inventory.body.includes(sharedSecret), "inventory must not leak shared secret plaintext");
    const inventoryBody = inventory.json() as {
      secrets: Array<{ key: string; scope: string; linked_services: Array<{ id: string }> }>;
    };
    assert.ok(
      inventoryBody.secrets.some(
        (secret) => secret.key === "WEBHOOK_SHARED_SECRET" && secret.scope === "shared"
      )
    );
    assert.ok(
      inventoryBody.secrets.some(
        (secret) =>
          secret.key === "PLATFORM_API_KEY" &&
          secret.scope === "service" &&
          secret.linked_services.some((service) => service.id === serviceId)
      )
    );

    const promote = await ctx.app.inject({
      method: "POST",
      url: "/secrets/promote",
      headers: { authorization: `Bearer ${token}` },
      payload: { serviceEnvId: created.secret.id }
    });
    assert.equal(promote.statusCode, 200);
    const promoted = promote.json() as { secret: { key: string; scope: string }; redeploy_required: boolean };
    assert.deepEqual(
      { key: promoted.secret.key, scope: promoted.secret.scope, redeploy: promoted.redeploy_required },
      { key: "PLATFORM_API_KEY", scope: "shared", redeploy: true }
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});
