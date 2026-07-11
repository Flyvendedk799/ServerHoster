import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import {
  ensureLinkedDatabaseRunning,
  gracefulShutdown,
  reconcileRuntimeStateOnBoot
} from "./services/runtime.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

type FakeState = { status: string; policy: string };

/**
 * Fake Docker that tracks start()/update() calls and serves a configurable
 * container state, so we can assert the linked-DB lifecycle without a real
 * daemon. `status: "not-found"` makes inspect() throw, mimicking a missing
 * container.
 */
function installFakeDocker(ctx: Ctx, state: FakeState): {
  started: string[];
  updated: Array<Record<string, unknown>>;
} {
  const started: string[] = [];
  const updated: Array<Record<string, unknown>> = [];
  (ctx as { docker: unknown }).docker = {
    listContainers: async () => [],
    getContainer: (idOrName: string) => ({
      inspect: async () => {
        if (state.status === "not-found") throw new Error(`no such container ${idOrName}`);
        return {
          State: { Status: state.status },
          HostConfig: { RestartPolicy: { Name: state.policy } }
        };
      },
      start: async () => {
        started.push(idOrName);
        state.status = "running";
      },
      update: async (opts: Record<string, unknown>) => {
        updated.push(opts);
        const name = (opts.RestartPolicy as { Name?: string } | undefined)?.Name;
        if (name) state.policy = name;
      }
    })
  };
  return { started, updated };
}

function seedDatabase(ctx: Ctx, containerId: string): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO databases (id, project_id, name, engine, port, container_id, connection_string, created_at)
       VALUES (?, 'proj-linked-db', ?, 'postgres', 5433, ?, ?, ?)`
    )
    .run(id, `db-${id.slice(0, 6)}`, containerId, "postgresql://leader:leader@localhost:5433/leader", nowIso());
  return id;
}

function seedService(ctx: Ctx, linkedDatabaseId: string | null): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, start_mode, linked_database_id)
       VALUES (?, 'proj-linked-db', ?, 'process', 'npm start', '/tmp', 3099, 'stopped',
        0, 0, 5, ?, ?, 'manual', ?)`
    )
    .run(id, `svc-${id.slice(0, 6)}`, nowIso(), nowIso(), linkedDatabaseId);
  return id;
}

const hasPolicy = (updated: Array<Record<string, unknown>>, name: string): boolean =>
  updated.some((u) => (u.RestartPolicy as { Name?: string } | undefined)?.Name === name);

test("ensureLinkedDatabaseRunning: starts a stopped linked database and re-asserts durability", async () => {
  const ctx = await buildApp();
  try {
    const dbId = seedDatabase(ctx, "fake-leader-db");
    const serviceId = seedService(ctx, dbId);
    const calls = installFakeDocker(ctx, { status: "exited", policy: "no" });

    await ensureLinkedDatabaseRunning(ctx, serviceId);

    assert.equal(calls.started.length, 1, "a stopped linked DB should be started before the service");
    assert.ok(hasPolicy(calls.updated, "unless-stopped"), "its restart policy should be set to unless-stopped");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensureLinkedDatabaseRunning: leaves a running linked database alone but keeps it durable", async () => {
  const ctx = await buildApp();
  try {
    const dbId = seedDatabase(ctx, "fake-running-db");
    const serviceId = seedService(ctx, dbId);
    const calls = installFakeDocker(ctx, { status: "running", policy: "no" });

    await ensureLinkedDatabaseRunning(ctx, serviceId);

    assert.equal(calls.started.length, 0, "a running DB must not be restarted");
    assert.ok(hasPolicy(calls.updated, "unless-stopped"), "a drifted policy on a running DB should be corrected");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensureLinkedDatabaseRunning: throws when the linked database container is missing", async () => {
  const ctx = await buildApp();
  try {
    const dbId = seedDatabase(ctx, "fake-missing-db");
    const serviceId = seedService(ctx, dbId);
    installFakeDocker(ctx, { status: "not-found", policy: "no" });

    await assert.rejects(() => ensureLinkedDatabaseRunning(ctx, serviceId), /container is missing/);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensureLinkedDatabaseRunning: no-op for a service without a linked database", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx, null);
    const calls = installFakeDocker(ctx, { status: "exited", policy: "no" });

    await ensureLinkedDatabaseRunning(ctx, serviceId);

    assert.equal(calls.started.length, 0);
    assert.equal(calls.updated.length, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("reconcileRuntimeStateOnBoot: re-asserts unless-stopped on managed databases whose policy drifted", async () => {
  const ctx = await buildApp();
  try {
    seedDatabase(ctx, "fake-drifted-db");
    const calls = installFakeDocker(ctx, { status: "running", policy: "no" });

    await reconcileRuntimeStateOnBoot(ctx);

    assert.ok(hasPolicy(calls.updated, "unless-stopped"), "boot reconcile should fix the managed DB restart policy");
  } finally {
    await gracefulShutdown(ctx);
  }
});

// ---- Self-heal sweep over arbitrary DB containers (managed + hand-rolled) ----

type FakeContainerDef = { id: string; image: string; name: string; status: string; policy: string };

/**
 * Fake Docker backed by a registry of containers, so the boot self-heal sweep
 * (which discovers containers via listContainers) can be exercised end-to-end.
 */
function installFakeDockerWith(ctx: Ctx, defs: FakeContainerDef[]): {
  started: string[];
  policyUpdates: Array<{ container: string; policy: string }>;
} {
  const started: string[] = [];
  const policyUpdates: Array<{ container: string; policy: string }> = [];
  const byKey = new Map<string, FakeContainerDef>();
  for (const d of defs) {
    byKey.set(d.id, d);
    byKey.set(d.name, d);
  }
  (ctx as { docker: unknown }).docker = {
    listContainers: async () => defs.map((d) => ({ Id: d.id, Names: [`/${d.name}`], Image: d.image, State: d.status })),
    getContainer: (key: string) => {
      const def = byKey.get(key);
      return {
        inspect: async () => {
          if (!def || def.status === "not-found") throw new Error(`no such container ${key}`);
          return { State: { Status: def.status }, HostConfig: { RestartPolicy: { Name: def.policy } } };
        },
        start: async () => {
          if (def) {
            started.push(def.id);
            def.status = "running";
          }
        },
        update: async (opts: Record<string, unknown>) => {
          const policy = (opts.RestartPolicy as { Name?: string } | undefined)?.Name;
          if (def && policy) {
            def.policy = policy;
            policyUpdates.push({ container: def.id, policy });
          }
        }
      };
    }
  };
  return { started, policyUpdates };
}

test("self-heal: recovers a hand-rolled DB container that was left without a restart policy", async () => {
  const ctx = await buildApp();
  try {
    const calls = installFakeDockerWith(ctx, [
      { id: "leader-db-id", image: "postgres:16-alpine", name: "leader-db", status: "exited", policy: "no" }
    ]);

    await reconcileRuntimeStateOnBoot(ctx);

    assert.deepEqual(calls.started, ["leader-db-id"], "the down, policy-less DB should be started");
    assert.ok(
      calls.policyUpdates.some((u) => u.container === "leader-db-id" && u.policy === "unless-stopped"),
      "and made durable for next time"
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("self-heal: leaves a deliberately-stopped (already durable) DB stopped", async () => {
  const ctx = await buildApp();
  try {
    const calls = installFakeDockerWith(ctx, [
      { id: "paused-db-id", image: "mysql:8.0", name: "paused-db", status: "exited", policy: "unless-stopped" }
    ]);

    await reconcileRuntimeStateOnBoot(ctx);

    assert.equal(calls.started.length, 0, "a DB stopped on purpose (already unless-stopped) must not be restarted");
    assert.equal(calls.policyUpdates.length, 0, "and its policy is already correct, so nothing changes");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("self-heal: never touches Supabase's own stack", async () => {
  const ctx = await buildApp();
  try {
    const calls = installFakeDockerWith(ctx, [
      { id: "sb-db-id", image: "public.ecr.aws/supabase/postgres:17", name: "supabase_db_proj", status: "exited", policy: "no" }
    ]);

    await reconcileRuntimeStateOnBoot(ctx);

    assert.equal(calls.started.length, 0, "Supabase-owned containers are left to the Supabase CLI");
    assert.equal(calls.policyUpdates.length, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("self-heal: a managed DB is handled by the precise path, not double-started by the sweep", async () => {
  const ctx = await buildApp();
  try {
    seedDatabase(ctx, "managed-pg-id");
    const calls = installFakeDockerWith(ctx, [
      { id: "managed-pg-id", image: "postgres:16", name: "managed-pg", status: "exited", policy: "no" }
    ]);

    await reconcileRuntimeStateOnBoot(ctx);

    // Precise path fixes the policy but never starts a stopped managed DB; the
    // sweep skips it because it's in managedKeys.
    assert.ok(
      calls.policyUpdates.some((u) => u.container === "managed-pg-id" && u.policy === "unless-stopped"),
      "managed DB policy should be corrected"
    );
    assert.equal(calls.started.length, 0, "a managed DB must not be started by the self-heal sweep");
  } finally {
    await gracefulShutdown(ctx);
  }
});
