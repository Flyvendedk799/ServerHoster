import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { getServiceEnvWithLinks, gracefulShutdown, serviceDataDirFor } from "./services/runtime.js";
import {
  createResource,
  deleteResource,
  getResource,
  linkResourceToService,
  listLinksForService,
  listResources,
  unlinkResource,
  updateResourceStatus
} from "./services/resources/lifecycle.js";
import { getProfile, listProfiles, registerProfile } from "./services/resources/profiles.js";
import {
  deleteResourceSecret,
  getResourceSecret,
  listResourceSecrets,
  setResourceSecret
} from "./services/resources/secrets.js";
import { getResourceEnvForService } from "./services/resources/runtimeEnv.js";

/**
 * Database-Tracker Phase 1 — generic resource layer: profile registry,
 * encrypted resource secrets, lifecycle CRUD, and resource-aware env
 * injection with the full five-layer precedence.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function seedService(ctx: Ctx, opts: { projectId?: string; linkedDatabaseId?: string | null } = {}): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, ?, ?, 'process', 'node index.js', '/tmp', 0, 'stopped', 0, 0, 5, ?, ?, ?)`
    )
    .run(
      id,
      opts.projectId ?? "proj-layer",
      `svc-${id.slice(0, 6)}`,
      nowIso(),
      nowIso(),
      opts.linkedDatabaseId ?? null
    );
  return id;
}

function seedPostgresDatabase(ctx: Ctx, projectId: string): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO databases
       (id, project_id, name, engine, port, container_id, connection_string,
        username, password, database_name, created_at)
       VALUES (?, ?, 'layer-pg', 'postgres', 55433, '', '', 'legacyuser', 'legacypass', 'legacydb', ?)`
    )
    .run(id, projectId, nowIso());
  return id;
}

function setProjectEnvVar(ctx: Ctx, projectId: string, key: string, value: string): void {
  ctx.db
    .prepare(
      "INSERT OR REPLACE INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)"
    )
    .run(nanoid(), projectId, key, value);
}

function setServiceEnvVar(ctx: Ctx, serviceId: string, key: string, value: string): void {
  ctx.db
    .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)")
    .run(nanoid(), serviceId, key, value);
}

test("profile registry: built-in profiles are registered; custom profiles slot in", async () => {
  const manual = getProfile("manual");
  assert.ok(manual, "manual profile must be registered at import time");
  assert.equal(manual.id, "manual");
  // Phase 2 registers the rich profiles at import time (buildApp → routes →
  // scan.ts side-effect imports), alongside the Phase 1 manual profile.
  for (const id of ["manual", "supabase", "postgres", "mysql", "mongo", "redis"] as const) {
    assert.ok(getProfile(id), `${id} profile must be registered`);
    assert.ok(listProfiles().some((p) => p.id === id));
  }

  // registerProfile upserts: re-registering an id replaces the entry in place.
  const countBefore = listProfiles().length;
  registerProfile({
    id: "redis",
    label: "Redis (test stub)",
    detect: () => [],
    plan: async (_ctx, serviceId) => ({
      profile: "redis",
      service_id: serviceId,
      project_id: null,
      confidence: "low",
      signals: [],
      actions: [],
      env: { generated: [], required_user_input: [], optional_user_input: [], injected: [] }
    }),
    provision: async () => {
      throw new Error("not implemented");
    },
    status: async () => "running",
    env: () => ({ REDIS_URL: "redis://localhost:6379" }),
    remove: async () => undefined
  });
  assert.equal(getProfile("redis")?.label, "Redis (test stub)", "re-registration replaces the profile");
  assert.equal(listProfiles().length, countBefore, "re-registration must not grow the registry");
});

test("lifecycle: resource CRUD + link helpers", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx);
    const resource = createResource(ctx, {
      projectId: "proj-layer",
      name: "test-resource",
      profile: "manual",
      config: { env: { FOO: "bar" } }
    });
    assert.equal(resource.status, "provisioning", "default status is provisioning");
    assert.ok(resource.created_at && resource.updated_at);

    updateResourceStatus(ctx, resource.id, "running");
    assert.equal(getResource(ctx, resource.id)?.status, "running");
    assert.ok(listResources(ctx, "proj-layer").some((r) => r.id === resource.id));

    const link = linkResourceToService(ctx, { serviceId, resourceId: resource.id });
    assert.equal(link.active, 1);
    assert.equal(listLinksForService(ctx, serviceId).length, 1);

    // Linking the same pair again upserts (UNIQUE(service_id, resource_id)).
    const relink = linkResourceToService(ctx, { serviceId, resourceId: resource.id, envMap: { A: "b" } });
    assert.equal(relink.id, link.id);
    assert.equal(listLinksForService(ctx, serviceId).length, 1);

    unlinkResource(ctx, serviceId, resource.id);
    assert.equal(listLinksForService(ctx, serviceId).length, 0, "inactive links are filtered");
    assert.equal(listLinksForService(ctx, serviceId, false).length, 1, "row is kept for history");

    deleteResource(ctx, resource.id);
    assert.equal(getResource(ctx, resource.id), null);
    assert.equal(listLinksForService(ctx, serviceId, false).length, 0, "delete cascades to links");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("secrets: encrypted at rest, decrypted reads, preview-only listing", async () => {
  const ctx = await buildApp();
  try {
    const resource = createResource(ctx, { name: "secret-holder", profile: "manual" });
    const plaintext = "super-secret-service-role-key";
    setResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY", plaintext, true);

    // Encrypt-at-rest: the raw sqlite row must not contain the plaintext.
    const raw = ctx.db
      .prepare("SELECT value, is_generated FROM resource_secrets WHERE resource_id = ? AND key = ?")
      .get(resource.id, "SUPABASE_SERVICE_ROLE_KEY") as { value: string; is_generated: number };
    assert.notEqual(raw.value, plaintext);
    assert.ok(!raw.value.includes(plaintext), "stored value must be ciphertext");
    assert.match(raw.value, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, "iv:tag:ciphertext hex format");
    assert.equal(raw.is_generated, 1);

    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY"), plaintext);
    assert.equal(getResourceSecret(ctx, resource.id, "MISSING_KEY"), null);

    const previews = listResourceSecrets(ctx, resource.id);
    assert.equal(previews.length, 1);
    const preview = previews[0];
    assert.equal(preview.key, "SUPABASE_SERVICE_ROLE_KEY");
    assert.equal(preview.is_generated, true);
    assert.equal(preview.value_preview, "su****ey", "preview is masked");
    assert.ok(!("value" in preview), "previews must never carry the full value");
    assert.ok(preview.created_at && preview.updated_at);

    // Upsert path: same key replaces the value, flips is_generated.
    setResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY", "user-pasted-value", false);
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY"), "user-pasted-value");
    assert.equal(listResourceSecrets(ctx, resource.id)[0].is_generated, false);
    assert.equal(listResourceSecrets(ctx, resource.id).length, 1);

    deleteResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY");
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY"), null);
    assert.equal(listResourceSecrets(ctx, resource.id).length, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("env precedence: project → resource links → legacy linked DB → DATA_DIR → service env", async () => {
  const ctx = await buildApp();
  try {
    const projectId = "proj-precedence";
    const databaseId = seedPostgresDatabase(ctx, projectId);
    const serviceId = seedService(ctx, { projectId, linkedDatabaseId: databaseId });

    // Layer 1: project env.
    setProjectEnvVar(ctx, projectId, "FROM_PROJECT", "project-value");
    setProjectEnvVar(ctx, projectId, "SHARED_KEY", "project-value");
    setProjectEnvVar(ctx, projectId, "SERVICE_WINS", "project-value");

    // Layer 2: linked managed resource (manual profile, env in config_json).
    const resource = createResource(ctx, {
      projectId,
      name: "mock-supabase",
      profile: "manual",
      status: "running",
      config: {
        env: {
          SHARED_KEY: "resource-value",
          FROM_RESOURCE: "resource-value",
          SERVICE_WINS: "resource-value",
          DATABASE_URL: "postgresql://resource:resource@localhost:59999/resource"
        }
      }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });

    // Layer 5: service env override.
    setServiceEnvVar(ctx, serviceId, "SERVICE_WINS", "service-value");

    const env = getServiceEnvWithLinks(ctx, serviceId);

    // Project env survives where nothing overrides it.
    assert.equal(env.FROM_PROJECT, "project-value");
    // Resource env beats project env.
    assert.equal(env.SHARED_KEY, "resource-value");
    assert.equal(env.FROM_RESOURCE, "resource-value");
    // Legacy linked DATABASE_URL beats resource env (compat guarantee).
    assert.equal(env.DATABASE_URL, "postgresql://legacyuser:legacypass@localhost:55433/legacydb");
    // Service env always wins.
    assert.equal(env.SERVICE_WINS, "service-value");
    // DATA_DIR default is injected when no layer provides one.
    assert.equal(env.DATA_DIR, serviceDataDirFor(ctx, serviceId));
    assert.equal(path.isAbsolute(env.DATA_DIR), true);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("env precedence: service-level DATABASE_URL beats both legacy DB and resource env", async () => {
  const ctx = await buildApp();
  try {
    const projectId = "proj-precedence-2";
    const databaseId = seedPostgresDatabase(ctx, projectId);
    const serviceId = seedService(ctx, { projectId, linkedDatabaseId: databaseId });
    const resource = createResource(ctx, {
      projectId,
      name: "mock-db-resource",
      profile: "manual",
      status: "running",
      config: { env: { DATABASE_URL: "postgresql://resource:resource@localhost:59999/resource" } }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });
    setServiceEnvVar(ctx, serviceId, "DATABASE_URL", "postgresql://manual:override@example.com:5432/mine");

    const env = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(env.DATABASE_URL, "postgresql://manual:override@example.com:5432/mine");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("resource env: link order, env_map overrides, unregistered profiles, unlink", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx);

    // An UNREGISTERED profile (supabase arrives in a later phase) still
    // injects env from config_json.env — proves a mock resource can inject
    // env without touching the old database flow or the registry.
    const supabaseLike = createResource(ctx, {
      name: "supabase-stack",
      profile: "supabase",
      status: "running",
      config: { env: { ORDER_KEY: "first", VITE_SUPABASE_URL: "http://localhost:54321" } }
    });
    linkResourceToService(ctx, {
      serviceId,
      resourceId: supabaseLike.id,
      envMap: { SUPABASE_URL: "http://localhost:54321" }
    });

    const second = createResource(ctx, {
      name: "second-resource",
      profile: "manual",
      status: "running",
      config: { env: { ORDER_KEY: "second" } }
    });
    linkResourceToService(ctx, { serviceId, resourceId: second.id });

    const resourceEnv = getResourceEnvForService(ctx, serviceId);
    assert.equal(resourceEnv.VITE_SUPABASE_URL, "http://localhost:54321", "config env injected");
    assert.equal(resourceEnv.SUPABASE_URL, "http://localhost:54321", "link env_map injected");
    assert.equal(resourceEnv.ORDER_KEY, "second", "later links win on key conflicts");

    // And it flows through the shared merge path.
    const fullEnv = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(fullEnv.VITE_SUPABASE_URL, "http://localhost:54321");

    unlinkResource(ctx, serviceId, supabaseLike.id);
    const afterUnlink = getResourceEnvForService(ctx, serviceId);
    assert.equal(afterUnlink.VITE_SUPABASE_URL, undefined, "unlinked resources stop injecting");
    assert.equal(afterUnlink.ORDER_KEY, "second", "remaining links keep injecting");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("resource env: a resource-provided DATA_DIR is respected over the injected default", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx);
    const resource = createResource(ctx, {
      name: "data-dir-resource",
      profile: "manual",
      status: "running",
      config: { env: { DATA_DIR: "/custom/resource/data" } }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });

    const env = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(env.DATA_DIR, "/custom/resource/data");
  } finally {
    await gracefulShutdown(ctx);
  }
});
