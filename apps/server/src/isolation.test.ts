import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  nowIso,
  sanitizedHostEnv,
  dbReservedPorts,
  assertPortAvailable,
  assertWithinServiceDir,
  dockerUnavailableMessage
} from "./lib/core.js";

test("dockerUnavailableMessage: maps a stopped-daemon socket error to actionable text", () => {
  assert.match(
    dockerUnavailableMessage({ code: "ECONNREFUSED", address: "/Users/x/.colima/default/docker.sock" }) ?? "",
    /Docker isn't reachable/
  );
  assert.match(
    dockerUnavailableMessage({ code: "ENOENT", message: "connect ENOENT /var/run/docker.sock" }) ?? "",
    /Docker isn't reachable/
  );
  // Not a docker socket error → leave it alone (don't mislabel a real DB refusal).
  assert.equal(dockerUnavailableMessage({ code: "ECONNREFUSED", address: "127.0.0.1:5432" }), null);
  assert.equal(dockerUnavailableMessage(new Error("something else")), null);
});

function seedService(ctx: Awaited<ReturnType<typeof buildApp>>, name: string, port: number): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "p1", name, "process", "node x.js", "/tmp", "", "", port, "stopped", 1, 0, 5, "manual", nowIso(), nowIso());
  return id;
}

test("sanitizedHostEnv: strips SURVHUB_* and operator tokens, keeps benign host vars", () => {
  process.env.SURVHUB_TESTLEAK = "leak";
  process.env.GITHUB_TOKEN = "ghp_test";
  process.env.CLOUDFLARE_API_TOKEN = "cf_test";
  try {
    const env = sanitizedHostEnv();
    assert.equal(env.SURVHUB_TESTLEAK, undefined, "all SURVHUB_* must be stripped");
    assert.equal(env.SURVHUB_SECRET_KEY, undefined, "the master key must never reach a child");
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
    assert.ok(env.PATH, "benign host vars (PATH) still pass through so builds/tools work");
  } finally {
    delete process.env.SURVHUB_TESTLEAK;
    delete process.env.GITHUB_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test("assertPortAvailable / dbReservedPorts: a port held by another service is taken", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, "A", 3500);
    assert.throws(() => assertPortAvailable(ctx, 3500), /already used/, "a used port must be rejected");
    assert.doesNotThrow(() => assertPortAvailable(ctx, 3501), "a free port must pass");
    assert.doesNotThrow(
      () => assertPortAvailable(ctx, 3500, id),
      "the owning service may re-assert its own port"
    );

    const taken = dbReservedPorts(ctx);
    assert.ok(taken.has(3500), "reserved set includes a stopped service's port (logical reservation)");
    assert.ok(!dbReservedPorts(ctx, id).has(3500), "excludeServiceId drops the owner's own port");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("DATA_DIR: every service gets a persistent dir that survives redeploys", async () => {
  const { getServiceEnvWithLinks } = await import("./services/runtime.js");
  const ctx = await buildApp();
  try {
    const procId = seedService(ctx, "proc-svc", 3601);
    const env = getServiceEnvWithLinks(ctx, procId);
    const expected = path.join(ctx.config.serviceDataDir, procId);
    assert.equal(env.DATA_DIR, expected, "process services get the host data dir");
    assert.ok(fs.existsSync(expected), "the dir is created on first use");
    assert.ok(
      !expected.startsWith(path.join(ctx.config.projectsDir)),
      "data dir must live OUTSIDE the disposable git clone"
    );

    // Docker services see the bind-mounted container path instead.
    const dockId = seedService(ctx, "dock-svc", 3602);
    ctx.db.prepare("UPDATE services SET type = 'docker' WHERE id = ?").run(dockId);
    assert.equal(getServiceEnvWithLinks(ctx, dockId).DATA_DIR, "/data");

    // A user-set DATA_DIR env var wins over the default.
    ctx.db
      .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)")
      .run(nanoid(), procId, "DATA_DIR", "/custom/spot");
    assert.equal(getServiceEnvWithLinks(ctx, procId).DATA_DIR, "/custom/spot");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("assertWithinServiceDir: confines working_dir to the service's own clone", async () => {
  const ctx = await buildApp();
  try {
    const id = "svc-confine";
    const base = path.join(ctx.config.projectsDir, id);
    fs.mkdirSync(path.join(base, "backend"), { recursive: true });

    assert.doesNotThrow(() => assertWithinServiceDir(ctx, id, base), "the clone root is allowed");
    assert.doesNotThrow(
      () => assertWithinServiceDir(ctx, id, path.join(base, "backend")),
      "a nested app dir is allowed"
    );
    assert.throws(
      () => assertWithinServiceDir(ctx, id, path.join(ctx.config.projectsDir, "another-service")),
      /inside the service/,
      "another service's clone is rejected"
    );
    // sibling-prefix bug guard: /projects/svc-confineX must not count as inside /projects/svc-confine
    fs.mkdirSync(path.join(ctx.config.projectsDir, id + "X"), { recursive: true });
    assert.throws(
      () => assertWithinServiceDir(ctx, id, path.join(ctx.config.projectsDir, id + "X")),
      /inside the service/
    );
    assert.throws(() => assertWithinServiceDir(ctx, id, "/etc"), /inside the service/, "a host path is rejected");
  } finally {
    await gracefulShutdown(ctx);
  }
});
