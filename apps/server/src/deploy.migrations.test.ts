import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { nowIso } from "./lib/core.js";
import { createResource, linkResourceToService } from "./services/resources/lifecycle.js";
import {
  applyPendingSupabaseMigrations,
  autoMigrateEnabled,
  diffMigrations,
  isLocalDbUrl,
  listRepoMigrations,
  migrationLogLine,
  migrationVersion,
  resolveMigrationTarget,
  setMigrationCliRunner,
  setMigrationDbClient
} from "./services/resources/deployMigrations.js";

/**
 * Auto-applying supabase/migrations on a git deploy
 * (docs/supabase-migrations-and-grants.md, Part B).
 *
 * Both side-effecting layers are injected — the Supabase CLI through
 * setMigrationCliRunner and Postgres through setMigrationDbClient — so these run
 * without Docker, the CLI, or a database, matching the seams in functions.ts and
 * bootstrap.ts.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54522/postgres";
const HOSTED_DB_URL = "postgresql://postgres:pw@db.abcdefg.supabase.co:5432/postgres";

// ---- pure helpers -----------------------------------------------------------

test("migrationVersion reads the 14-digit timestamp prefix and ignores anything else", () => {
  assert.equal(migrationVersion("20260906201000_memberships_profiles_fk.sql"), "20260906201000");
  assert.equal(migrationVersion("20260906210000.sql"), "20260906210000");
  assert.equal(migrationVersion("README.md"), null);
  assert.equal(migrationVersion("rollback_20260906201000.sql"), null);
});

test("listRepoMigrations returns sorted versions and tolerates a repo with no migrations dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-migrations-"));
  assert.deepEqual(listRepoMigrations(dir), [], "no supabase/migrations means no versions, no throw");

  const migrations = path.join(dir, "supabase", "migrations");
  fs.mkdirSync(migrations, { recursive: true });
  fs.writeFileSync(path.join(migrations, "20260906210000_invitation_accept_flow.sql"), "");
  fs.writeFileSync(path.join(migrations, "20260906201000_memberships_profiles_fk.sql"), "");
  fs.writeFileSync(path.join(migrations, "notes.txt"), "not a migration");

  assert.deepEqual(listRepoMigrations(dir), ["20260906201000", "20260906210000"]);
});

test("diffMigrations reports only unrecorded versions as pending", () => {
  const { pending, outOfOrder } = diffMigrations(
    ["20260101000000", "20260906201000", "20260906210000"],
    ["20260101000000"]
  );
  assert.deepEqual(pending, ["20260906201000", "20260906210000"]);
  assert.equal(outOfOrder, false, "both sort after the newest applied version");
});

test("diffMigrations flags a pending migration that sorts before the newest applied one", () => {
  // Two branches merged in the wrong order — plain `migration up` refuses this,
  // so the runner has to reach for --include-all.
  const { pending, outOfOrder } = diffMigrations(
    ["20260906201000", "20260906210000"],
    ["20260906210000"]
  );
  assert.deepEqual(pending, ["20260906201000"]);
  assert.equal(outOfOrder, true);
});

test("only a loopback db_url is migratable, and auto_migrate defaults to on", () => {
  assert.equal(isLocalDbUrl(LOCAL_DB_URL), true);
  assert.equal(isLocalDbUrl(HOSTED_DB_URL), false);
  assert.equal(isLocalDbUrl("not a url"), false);

  assert.equal(autoMigrateEnabled({}), true, "absent means on");
  assert.equal(autoMigrateEnabled({ auto_migrate: true }), true);
  assert.equal(autoMigrateEnabled({ auto_migrate: false }), false, "only an explicit false opts out");
});

// ---- harness ----------------------------------------------------------------

const openApps: Ctx[] = [];

type StackSpec = { status?: string; config?: Record<string, unknown> };

type Harness = {
  ctx: Ctx;
  serviceId: string;
  resourceIds: string[];
  workdir: string;
};

async function makeHarness(options: {
  repoVersions: string[];
  stacks?: StackSpec[];
}): Promise<Harness> {
  const ctx = await buildApp();
  openApps.push(ctx);

  const now = nowIso();
  const projectId = `proj-${nanoid(8)}`;
  const serviceId = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at)
       VALUES (?, ?, ?, 'process', 'node index.js', '/tmp', 0, 'stopped', 0, 0, 5, ?, ?)`
    )
    .run(serviceId, projectId, `Awaire-${nanoid(6)}`, now, now);

  const stacks = options.stacks ?? [{}];
  const resourceIds: string[] = [];
  for (const stack of stacks) {
    const resource = createResource(ctx, {
      projectId,
      name: `Awaire-supabase-${nanoid(6)}`,
      profile: "supabase",
      status: stack.status ?? "running",
      config: { db_url: LOCAL_DB_URL, ...(stack.config ?? {}) }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });
    resourceIds.push(resource.id);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-deploy-"));
  if (options.repoVersions.length > 0) {
    const migrations = path.join(workdir, "supabase", "migrations");
    fs.mkdirSync(migrations, { recursive: true });
    for (const version of options.repoVersions) {
      fs.writeFileSync(path.join(migrations, `${version}_change.sql`), "select 1;");
    }
  }

  return { ctx, serviceId, resourceIds, workdir };
}

/** Fake stack DB whose recorded history grows only when the fake CLI runs. */
function fakeStack(
  applied: string[],
  options: { historyTable?: boolean; lockHeld?: boolean } = {}
) {
  const state = {
    applied: [...applied],
    cliCalls: [] as { local?: boolean; includeAll?: boolean }[],
    locks: [] as string[]
  };
  setMigrationDbClient(() => ({
    async query(sql: string) {
      if (sql.includes("to_regclass")) {
        return { rows: [{ present: options.historyTable !== false }] };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        state.locks.push("acquire");
        return { rows: [{ locked: options.lockHeld !== true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        state.locks.push("release");
        return { rows: [{}] };
      }
      return { rows: state.applied.map((version) => ({ version })) };
    },
    end: () => undefined
  }));
  return state;
}

test.afterEach(async () => {
  setMigrationDbClient(null);
  setMigrationCliRunner(null);
  while (openApps.length > 0) await gracefulShutdown(openApps.pop()!);
});

// ---- the deploy hook --------------------------------------------------------

test("a push that adds a migration applies it, and releases the advisory lock", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260101000000", "20260906201000", "20260906210000"]
  });
  const stack = fakeStack(["20260101000000"]);
  setMigrationCliRunner(async (dir, opts) => {
    assert.equal(dir, workdir, "the CLI runs in the freshly-reset checkout");
    stack.cliCalls.push(opts);
    stack.applied.push("20260906201000", "20260906210000");
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.pending, ["20260906201000", "20260906210000"]);
  assert.deepEqual(result.applied, ["20260906201000", "20260906210000"]);
  assert.deepEqual(stack.cliCalls, [{ local: true, includeAll: false }], "--local, in order");
  assert.deepEqual(stack.locks, ["acquire", "release"]);
  assert.match(migrationLogLine(result), /applied 2 migration\(s\)/);
});

test("nothing new in the push means neither the lock nor the CLI is touched", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: ["20260101000000"] });
  const stack = fakeStack(["20260101000000"]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "up-to-date");
  assert.deepEqual(stack.cliCalls, [], "no CLI call on an unchanged schema");
  assert.deepEqual(stack.locks, [], "the overwhelmingly common deploy takes no lock");
  assert.match(migrationLogLine(result), /up to date/);
});

test("an out-of-order migration is applied with --include-all", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000", "20260906210000"]
  });
  const stack = fakeStack(["20260906210000"]);
  setMigrationCliRunner(async (_dir, opts) => {
    stack.cliCalls.push(opts);
    stack.applied.push("20260906201000");
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.outOfOrder, true);
  assert.deepEqual(stack.cliCalls, [{ local: true, includeAll: true }]);
  assert.deepEqual(result.applied, ["20260906201000"]);
});

test("a failing migration surfaces as an error so the deploy stops before the build", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: ["20260906201000"] });
  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    throw new Error("supabase migration up failed (exit 1):\nERROR: relation does not exist");
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.match(result.error ?? "", /relation does not exist/);
  assert.match(migrationLogLine(result), /FAILED/);
  assert.deepEqual(stack.locks, ["acquire", "release"], "the lock is released even on failure");
});

test("a CLI that exits 0 without recording the migration is still a failure", async () => {
  // Trust the history table, not the exit code — otherwise the deploy would
  // proceed and start the new code against the old schema.
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: ["20260906201000"] });
  fakeStack([]);
  setMigrationCliRunner(async () => "Applying migration...\n");

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.match(result.error ?? "", /still unrecorded: 20260906201000/);
});

test("a concurrent run holding the advisory lock fails the deploy instead of interleaving", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: ["20260906201000"] });
  const stack = fakeStack([], { lockHeld: true });
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.match(result.error ?? "", /advisory lock/);
  assert.deepEqual(stack.cliCalls, [], "never runs while another apply is in flight");
});

test("a stack pointed at a hosted project is never migrated", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: [{ config: { db_url: HOSTED_DB_URL } }]
  });
  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "non-local-db");
  assert.deepEqual(stack.cliCalls, [], "the hosted database is left alone");
});

test("auto_migrate:false restores the hand-applied behaviour for one stack", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: [{ config: { auto_migrate: false } }]
  });
  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "disabled");
  assert.deepEqual(stack.cliCalls, []);
});

test("a stopped stack is skipped, not failed", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: [{ status: "stopped" }]
  });
  fakeStack([]);
  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "stack-not-running");
  assert.equal(result.error, undefined, "a deploy whose stack is down still succeeds");
});

test("a stack with no migration history is skipped rather than replayed from scratch", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: ["20260906201000"] });
  const stack = fakeStack([], { historyTable: false });
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "no-history-table");
  assert.deepEqual(stack.cliCalls, [], "never replays every migration over a populated database");
});

test("a repo with no supabase/migrations produces no build-log noise", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({ repoVersions: [] });
  fakeStack([]);
  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "no-migrations-dir");
  assert.equal(migrationLogLine(result), "");
});

test("a service with no supabase resource is a silent no-op", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: []
  });
  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "no-supabase-resource");
  assert.equal(migrationLogLine(result), "");
  assert.deepEqual(stack.cliCalls, []);
});

// ---- resource ambiguity (the live-fleet hazard) ------------------------------

test("one started stack among failed duplicates is resolved, not guessed at", async () => {
  // The shape measured on the fleet: three active links, two of them pointing at
  // `failed` resources left behind by earlier provisioning attempts.
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: [{ status: "failed" }, { status: "running" }, { status: "failed" }]
  });
  const { target, candidates } = resolveMigrationTarget(ctx, serviceId);
  assert.ok(target, "the one running stack is the target");
  assert.deepEqual(candidates, [target!.name]);

  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    stack.applied.push("20260906201000");
    return "";
  });
  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.resourceId, target!.resourceId);
  assert.deepEqual(result.applied, ["20260906201000"]);
});

test("two started stacks on one service skip and warn instead of migrating either", async () => {
  const { ctx, serviceId, workdir } = await makeHarness({
    repoVersions: ["20260906201000"],
    stacks: [{ status: "running" }, { status: "ready" }]
  });
  const stack = fakeStack([]);
  setMigrationCliRunner(async () => {
    stack.cliCalls.push({});
    return "";
  });

  const result = await applyPendingSupabaseMigrations(ctx, serviceId, workdir);
  assert.equal(result.skipped, "ambiguous-resources");
  assert.equal(result.candidates?.length, 2);
  assert.equal(result.error, undefined, "ambiguity warns; it does not fail the deploy");
  assert.deepEqual(stack.cliCalls, [], "neither database is touched");
  assert.match(migrationLogLine(result), /more than one started stack/);
});
