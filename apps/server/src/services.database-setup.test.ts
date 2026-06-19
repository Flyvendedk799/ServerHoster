import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { getServiceEnv, nowIso } from "./lib/core.js";
import { applyServiceDatabaseSetup } from "./services/databaseSetup.js";
import { gracefulShutdown } from "./services/runtime.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function makeWorkdir(name: string, dependencies: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `survhub-dbsetup-${name}-`));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, dependencies }));
  return dir;
}

function seedService(ctx: Ctx, opts: { workingDir: string; projectId?: string; name?: string }): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, ?, ?, 'process', 'npm start', ?, 3011, 'stopped',
        0, 0, 5, ?, ?, NULL)`
    )
    .run(
      id,
      opts.projectId ?? "proj-dbsetup",
      opts.name ?? `svc-${id.slice(0, 6)}`,
      opts.workingDir,
      nowIso(),
      nowIso()
    );
  return id;
}

function installFakeDocker(ctx: Ctx): { createRequests: Array<Record<string, unknown>> } {
  const createRequests: Array<Record<string, unknown>> = [];
  (ctx as { docker: unknown }).docker = {
    ping: async () => "OK",
    pull: async () => ({}),
    modem: { followProgress: (_stream: unknown, cb: (error: null) => void) => cb(null) },
    createContainer: async (opts: Record<string, unknown>) => {
      createRequests.push(opts);
      return { id: `fake-db-${nanoid(6)}`, start: async () => undefined };
    },
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name !== "compose-db") throw new Error(`unexpected container ${name}`);
        return {
          State: { Running: true, Status: "running" },
          NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "15432" }] } }
        };
      }
    })
  };
  return { createRequests };
}

test("database setup auto: connects an existing Docker Compose database before provisioning", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir("compose-app", { pg: "^8.0.0" });
  try {
    fs.writeFileSync(
      path.join(dir, "docker-compose.yml"),
      [
        "services:",
        "  db:",
        "    image: postgres:16",
        "    container_name: compose-db",
        "    environment:",
        "      POSTGRES_USER: app",
        "      POSTGRES_PASSWORD: app-secret",
        "      POSTGRES_DB: app",
        "    ports:",
        '      - "15432:5432"',
        "  app:",
        "    image: compose-app",
        "    environment:",
        '      DATABASE_URL: "postgresql://app:app-secret@db:5432/app"',
        ""
      ].join("\n")
    );
    const { createRequests } = installFakeDocker(ctx);
    const serviceId = seedService(ctx, { workingDir: dir, name: "compose-app" });

    const result = await applyServiceDatabaseSetup(ctx, serviceId, { mode: "auto", restart: false });

    assert.equal(result.status, "ready");
    assert.equal(result.action, "connect-compose");
    assert.equal(createRequests.length, 0, "existing compose DB should be connected, not recreated");
    assert.equal(getServiceEnv(ctx, serviceId).DATABASE_URL, "postgresql://app:app-secret@localhost:15432/app");
    const envRow = ctx.db
      .prepare("SELECT is_secret FROM env_vars WHERE service_id = ? AND key = 'DATABASE_URL'")
      .get(serviceId) as { is_secret: number } | undefined;
    assert.equal(envRow?.is_secret, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("database setup auto: provisions the detected engine through the managed resource path", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir("mysql-app", { mysql2: "^3.0.0" });
  try {
    const { createRequests } = installFakeDocker(ctx);
    const serviceId = seedService(ctx, { workingDir: dir, name: "mysql-app" });

    const result = await applyServiceDatabaseSetup(ctx, serviceId, { mode: "auto", restart: false });

    assert.equal(result.status, "ready");
    assert.equal(result.action, "provision");
    assert.equal(result.profile, "mysql");
    assert.equal(createRequests.length, 1);
    const service = ctx.db
      .prepare("SELECT linked_database_id FROM services WHERE id = ?")
      .get(serviceId) as { linked_database_id: string | null };
    assert.ok(service.linked_database_id);
    const db = ctx.db
      .prepare("SELECT engine FROM databases WHERE id = ?")
      .get(service.linked_database_id) as { engine: string } | undefined;
    assert.equal(db?.engine, "mysql");
    const activeLink = ctx.db
      .prepare("SELECT 1 FROM service_resource_links WHERE service_id = ? AND active = 1")
      .get(serviceId);
    assert.ok(activeLink);
    assert.equal(result.recognition?.state, "satisfied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});
