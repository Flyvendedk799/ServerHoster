import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-secret-detect-"));
  const ctx = await buildApp();
  try {
    const { projectId, serviceId } = seedProjectAndService(ctx);
    ctx.db.prepare("UPDATE services SET working_dir = ? WHERE id = ?").run(tmp, serviceId);
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

    const plainServiceSecret = "plain-service-secret-value-12345";
    ctx.db
      .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)")
      .run(nanoid(), serviceId, "ANTHROPIC_API_KEY", plainServiceSecret);
    const plainSharedSecret = "plain-shared-secret-value-67890";
    ctx.db
      .prepare(
        "INSERT OR REPLACE INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)"
      )
      .run(nanoid(), projectId, "STRIPE_SECRET_KEY", plainSharedSecret);
    fs.writeFileSync(
      path.join(tmp, ".env.local"),
      [
        "PLATFORM_API_KEY=repo-hardcoded-platform-key-abcdef",
        "NEXT_PUBLIC_API_URL=http://localhost:3191",
        "OPENAI_API_KEY=example"
      ].join("\n")
    );

    const visible = await ctx.app.inject({
      method: "GET",
      url: "/secrets",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(visible.statusCode, 200);
    assert.ok(!visible.body.includes(plainServiceSecret), "plain service secret must be masked");
    assert.ok(!visible.body.includes(plainSharedSecret), "plain shared secret must be masked");
    assert.ok(!visible.body.includes("repo-hardcoded-platform-key-abcdef"), "repo detected secret must be masked");
    const visibleBody = visible.json() as {
      secrets: Array<{ id: string; key: string; storage?: string; source_file?: string }>;
    };
    const plainService = visibleBody.secrets.find(
      (secret) => secret.key === "ANTHROPIC_API_KEY" && secret.storage === "plain-env"
    );
    assert.ok(plainService, "plain service env that looks secret appears in inventory");
    assert.ok(
      visibleBody.secrets.some(
        (secret) => secret.key === "STRIPE_SECRET_KEY" && secret.storage === "plain-env"
      ),
      "plain shared env that looks secret appears in inventory"
    );
    assert.ok(
      visibleBody.secrets.some(
        (secret) =>
          secret.key === "PLATFORM_API_KEY" &&
          secret.storage === "repo-detected" &&
          secret.source_file === ".env.local"
      ),
      "repo .env secret-like values appear as read-only detections"
    );
    assert.ok(
      !visibleBody.secrets.some((secret) => secret.key === "NEXT_PUBLIC_API_URL"),
      "public env values are not misclassified as secrets"
    );

    const protect = await ctx.app.inject({
      method: "POST",
      url: `/secrets/service/${plainService.id}/protect`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(protect.statusCode, 200);
    const protectedRow = ctx.db
      .prepare("SELECT value, is_secret FROM env_vars WHERE id = ?")
      .get(plainService.id) as { value: string; is_secret: number };
    assert.equal(protectedRow.is_secret, 1);
    assert.notEqual(protectedRow.value, plainServiceSecret);
    assert.ok(!protectedRow.value.includes(plainServiceSecret), "protected env value is encrypted at rest");
  } finally {
    await gracefulShutdown(ctx);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
