import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { getServiceEnv, nowIso } from "./lib/core.js";
import { gracefulShutdown } from "./services/runtime.js";
import { detectComposeDatabaseCandidate } from "./services/embeddedDatabases.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function makeComposeWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-compose-db-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "leader-like", dependencies: { "@prisma/client": "^5.0.0" } })
  );
  fs.writeFileSync(
    path.join(dir, "docker-compose.yml"),
    [
      "services:",
      "  db:",
      "    image: postgres:16-alpine",
      "    container_name: leader-db",
      "    environment:",
      "      POSTGRES_USER: leader",
      "      POSTGRES_PASSWORD: leader",
      "      POSTGRES_DB: leader",
      "    ports:",
      '      - "5432:5432"',
      "  app:",
      "    image: leader-app",
      "    environment:",
      '      DATABASE_URL: "postgresql://leader:leader@db:5432/leader?schema=public"',
      ""
    ].join("\n")
  );
  return dir;
}

function seedService(ctx: Ctx, workingDir: string): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at)
       VALUES (?, 'proj-compose', 'LEADer', 'process', 'npm start', ?, 3007, 'stopped',
        0, 0, 5, ?, ?)`
    )
    .run(id, workingDir, nowIso(), nowIso());
  return id;
}

async function loginToken(ctx: Ctx): Promise<string> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(login.statusCode, 200, login.body);
  return login.json().token as string;
}

function installFakeDocker(ctx: Ctx): void {
  (ctx as { docker: unknown }).docker = {
    getContainer: (name: string) => ({
      inspect: async () => {
        assert.equal(name, "leader-db");
        return {
          State: { Running: true, Status: "running" },
          NetworkSettings: {
            Ports: {
              "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5433" }]
            }
          }
        };
      }
    })
  };
}

test("compose detector rewrites service hostnames to the published localhost port", async () => {
  const dir = makeComposeWorkdir();
  try {
    const detected = await detectComposeDatabaseCandidate(dir, {
      resolvePort: async (containerName, internalPort) => {
        assert.equal(containerName, "leader-db");
        assert.equal(internalPort, 5432);
        return { running: true, hostPort: 5433 };
      }
    });

    assert.ok(detected);
    assert.equal(detected.env_key, "DATABASE_URL");
    assert.equal(
      detected.connection_url,
      "postgresql://leader:leader@localhost:5433/leader?schema=public"
    );
    assert.equal(
      detected.connection_preview,
      "postgresql://leader:****@localhost:5433/leader?schema=public"
    );
    assert.equal(detected.running, true);
    assert.equal(detected.available, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compose adopt route stores DATABASE_URL as a protected service secret", async () => {
  const ctx = await buildApp();
  const dir = makeComposeWorkdir();
  try {
    installFakeDocker(ctx);
    const serviceId = seedService(ctx, dir);
    const token = await loginToken(ctx);

    const response = await ctx.app.inject({
      method: "POST",
      url: `/databases/compose/${serviceId}/adopt`,
      headers: { authorization: `Bearer ${token}` },
      payload: { restart: false }
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes("leader:leader"), "raw compose password must not be echoed");
    const env = getServiceEnv(ctx, serviceId);
    assert.equal(env.DATABASE_URL, "postgresql://leader:leader@localhost:5433/leader?schema=public");
    const row = ctx.db
      .prepare("SELECT is_secret FROM env_vars WHERE service_id = ? AND key = 'DATABASE_URL'")
      .get(serviceId) as { is_secret: number } | undefined;
    assert.equal(row?.is_secret, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});
