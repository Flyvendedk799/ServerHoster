import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { getServiceEnvWithLinks, gracefulShutdown } from "./services/runtime.js";
import { scanForDatabaseDrivers } from "./services/codeScan.js";
import { redisProfile } from "./services/resources/profiles/redis.js";

/**
 * Database-Tracker Phase 0 — guardrail tests around CURRENT behavior, written
 * before the generic resource layer so refactors can't silently regress the
 * legacy linked-database flow or driver detection.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

/** LearnAI-like Supabase-only frontend fixture, reused by later phases. */
const LEARNAI_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  // Tests run from dist/, the fixture stays under src/ (excluded from tsc).
  "../src/services/resources/__fixtures__/learnai-like"
);

function seedService(
  ctx: Ctx,
  opts: { projectId?: string; linkedDatabaseId?: string | null; workingDir?: string } = {}
): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, ?, ?, 'process', 'node index.js', ?, 0, 'stopped', 0, 0, 5, ?, ?, ?)`
    )
    .run(
      id,
      opts.projectId ?? "proj-guardrail",
      `svc-${id.slice(0, 6)}`,
      opts.workingDir ?? "/tmp",
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
       VALUES (?, ?, 'guardrail-pg', 'postgres', 55432, '', '', 'appuser', 'apppass', 'appdb', ?)`
    )
    .run(id, projectId, nowIso());
  return id;
}

function setServiceEnvVar(ctx: Ctx, serviceId: string, key: string, value: string): void {
  ctx.db
    .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, 0)")
    .run(nanoid(), serviceId, key, value);
}

test("guardrail: linked postgres database injects DATABASE_URL via getServiceEnvWithLinks", async () => {
  const ctx = await buildApp();
  try {
    const databaseId = seedPostgresDatabase(ctx, "proj-guardrail");
    const serviceId = seedService(ctx, { linkedDatabaseId: databaseId });

    const env = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(
      env.DATABASE_URL,
      "postgresql://appuser:apppass@localhost:55432/appdb",
      "linked database must inject its connection string as DATABASE_URL"
    );
    // The persistent data dir default must still be present.
    assert.ok(env.DATA_DIR, "DATA_DIR default must be injected");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("guardrail: service-level DATABASE_URL overrides linked-database injection", async () => {
  const ctx = await buildApp();
  try {
    const databaseId = seedPostgresDatabase(ctx, "proj-guardrail");
    const serviceId = seedService(ctx, { linkedDatabaseId: databaseId });
    setServiceEnvVar(ctx, serviceId, "DATABASE_URL", "postgresql://manual:override@example.com:5432/mine");

    const env = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(
      env.DATABASE_URL,
      "postgresql://manual:override@example.com:5432/mine",
      "service env must always win over linked-database injection"
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("guardrail: codeScan detects node database drivers from package.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-codescan-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "driver-fixture",
        dependencies: { pg: "^8.0.0", mysql2: "^3.0.0", ioredis: "^5.0.0" },
        devDependencies: { mongoose: "^8.0.0" }
      })
    );
    const signals = scanForDatabaseDrivers(dir);
    const drivers = signals.map((s) => s.driver).sort();
    assert.deepEqual(drivers, ["MongoDB", "MySQL", "PostgreSQL", "Redis"]);
    for (const signal of signals) {
      assert.equal(signal.ecosystem, "node");
      assert.equal(signal.source_file, "package.json");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guardrail: redis dependency plans Redis/REDIS_URL, not a Postgres offer", async () => {
  const ctx = await buildApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-redis-plan-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "redis-fixture", dependencies: { ioredis: "^5.0.0" } })
    );
    const serviceId = seedService(ctx, { workingDir: dir });
    const plan = await redisProfile.plan(ctx, serviceId);

    assert.equal(plan.profile, "redis");
    assert.equal(plan.confidence, "high");
    assert.deepEqual(plan.env.generated, ["REDIS_URL"]);
    assert.equal(plan.actions[0].label, "Create managed Redis and inject REDIS_URL");
    assert.ok(!plan.actions.some((action) => /Postgres|DATABASE_URL/.test(action.label)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("guardrail: codeScan returns nothing for a missing or driver-free directory", () => {
  assert.deepEqual(scanForDatabaseDrivers("/nonexistent/path/survhub"), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-codescan-empty-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "no-db", dependencies: {} }));
    assert.deepEqual(scanForDatabaseDrivers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: Supabase-only frontend is NOT classified as a plain postgres app", () => {
  // The LearnAI-like fixture only depends on @supabase/supabase-js — the
  // manifest scan must not report a plain Postgres driver, which is what
  // currently triggers the misleading one-click "Add Postgres" offer.
  const signals = scanForDatabaseDrivers(LEARNAI_FIXTURE_DIR);
  const postgresSignals = signals.filter((s) => s.driver === "PostgreSQL");
  assert.deepEqual(postgresSignals, [], "Supabase-only app must not be flagged as plain Postgres");
});

test("fixture: LearnAI-like Supabase fixture is complete for later phases", () => {
  const mustExist = [
    "package.json",
    "supabase/config.toml",
    "supabase/migrations/0001_init.sql",
    "supabase/functions/ai-chat/index.ts",
    "src/integrations/supabase/client.ts",
    ".env.example"
  ];
  for (const rel of mustExist) {
    assert.ok(fs.existsSync(path.join(LEARNAI_FIXTURE_DIR, rel)), `fixture file missing: ${rel}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(LEARNAI_FIXTURE_DIR, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["@supabase/supabase-js"], "fixture must depend on @supabase/supabase-js");

  const migration = fs.readFileSync(
    path.join(LEARNAI_FIXTURE_DIR, "supabase/migrations/0001_init.sql"),
    "utf8"
  );
  for (const role of [
    "super_admin",
    "org_owner",
    "org_admin",
    "compliance_manager",
    "hr_manager",
    "department_manager",
    "employee",
    "auditor_readonly"
  ]) {
    assert.ok(migration.includes(`'${role}'`), `app_role enum must include ${role}`);
  }
  for (const marker of [
    "public.app_role",
    "public.profiles",
    "public.platform_admins",
    "public.organizations",
    "public.organization_memberships",
    "on_auth_user_created"
  ]) {
    assert.ok(migration.includes(marker), `migration must define ${marker}`);
  }

  const fn = fs.readFileSync(path.join(LEARNAI_FIXTURE_DIR, "supabase/functions/ai-chat/index.ts"), "utf8");
  assert.ok(fn.includes('Deno.env.get("OPENAI_API_KEY")'));
  assert.ok(fn.includes('Deno.env.get("SUPABASE_URL")'));

  const client = fs.readFileSync(
    path.join(LEARNAI_FIXTURE_DIR, "src/integrations/supabase/client.ts"),
    "utf8"
  );
  assert.ok(client.includes("@supabase/supabase-js"));
  assert.ok(client.includes("createClient"));

  const envExample = fs.readFileSync(path.join(LEARNAI_FIXTURE_DIR, ".env.example"), "utf8");
  assert.ok(envExample.includes("VITE_SUPABASE_URL"));
  assert.ok(envExample.includes("VITE_SUPABASE_PUBLISHABLE_KEY"));
});
