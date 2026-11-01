import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { nowIso } from "./lib/core.js";
import {
  createResource,
  getResource,
  linkResourceToService,
  unlinkResource,
  listLinksForService,
  resourceConfig
} from "./services/resources/lifecycle.js";
import {
  findDuplicateResourceGroups,
  mergeDuplicateResources,
  mergeIfDuplicate,
  stackIdentity
} from "./services/resources/duplicates.js";

/**
 * One physical Supabase stack recorded as two managed_resources rows (Awaire,
 * 2026-07-23 + 2026-08-10: same workdir, same ports). Merging is bookkeeping:
 * links, secrets and missing config move to the kept row; nothing else is touched.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const openApps: Ctx[] = [];

test.afterEach(async () => {
  while (openApps.length > 0) await gracefulShutdown(openApps.pop()!);
});

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54522/postgres";
const PORTS = { api: 54521, db: 54522 };

async function setup() {
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
  const workdir = `/root/.survhub/projects/${nanoid(8)}`;
  return { ctx, projectId, serviceId, workdir };
}

function insertSecret(ctx: Ctx, resourceId: string, key: string, value: string): void {
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO resource_secrets (id, resource_id, key, value, is_generated, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(nanoid(), resourceId, key, value, now, now);
}

test("stackIdentity needs a workdir and ports or a db_url to prove sameness", async () => {
  const { ctx, projectId, workdir } = await setup();
  const full = createResource(ctx, {
    projectId,
    name: "a",
    profile: "supabase",
    config: { workdir, db_url: DB_URL },
    ports: PORTS
  });
  const noWorkdir = createResource(ctx, {
    projectId,
    name: "b",
    profile: "supabase",
    config: { db_url: DB_URL }
  });
  const nothing = createResource(ctx, { projectId, name: "c", profile: "supabase", config: { workdir } });
  assert.ok(stackIdentity(full));
  assert.equal(stackIdentity(noWorkdir), null);
  assert.equal(stackIdentity(nothing), null);
});

test("merging folds the duplicate record into the busier one and removes only the row", async () => {
  const { ctx, projectId, serviceId, workdir } = await setup();
  const older = createResource(ctx, {
    projectId,
    name: "Awaire-supabase",
    profile: "supabase",
    status: "running",
    config: { workdir, db_url: DB_URL, mode: "schema-only", error: "old start failure", api_url: "http://x" },
    ports: PORTS,
    containers: ["supabase_db_a"]
  });
  const newer = createResource(ctx, {
    projectId,
    name: "Awaire-supabase",
    profile: "supabase",
    status: "running",
    config: { workdir, db_url: DB_URL, port_offset: 200, functions: { enabled: true } },
    ports: PORTS
  });
  linkResourceToService(ctx, { serviceId, resourceId: older.id });
  linkResourceToService(ctx, { serviceId, resourceId: newer.id });
  insertSecret(ctx, older.id, "OPENAI_API_KEY", "enc-a");
  insertSecret(ctx, older.id, "SHARED", "enc-old");
  insertSecret(ctx, newer.id, "SHARED", "enc-new");

  // The test DB is shared across files; look only at this test's group.
  const ours = (report: ReturnType<typeof mergeDuplicateResources>) =>
    report.groups.filter((g) => g.kept.id === newer.id || g.kept.id === older.id);

  const dry = ours(mergeDuplicateResources(ctx, { dryRun: true }));
  assert.equal(dry.length, 1);
  assert.equal(dry[0]!.kept.id, newer.id, "the record with functions enabled is kept");
  assert.ok(getResource(ctx, older.id), "dry run changes nothing");

  const report = ours(mergeDuplicateResources(ctx));
  assert.deepEqual(
    report[0]!.merged.map((m) => m.id),
    [older.id]
  );
  assert.equal(getResource(ctx, older.id), null, "duplicate row removed");
  const kept = getResource(ctx, newer.id)!;
  const config = resourceConfig(kept);
  assert.equal(config.port_offset, 200, "kept row's own config wins");
  assert.equal(config.api_url, "http://x", "missing keys filled from the duplicate");
  assert.equal(config.error, undefined, "stale per-row error is not carried over");
  assert.equal((config.merged_duplicates as unknown[]).length, 1);
  assert.deepEqual(JSON.parse(kept.containers_json), ["supabase_db_a"], "empty containers filled in");

  const links = listLinksForService(ctx, serviceId);
  assert.deepEqual(
    links.map((l) => l.resource_id),
    [newer.id],
    "one active link, to the kept record"
  );
  const secrets = ctx.db
    .prepare("SELECT key, value FROM resource_secrets WHERE resource_id = ? ORDER BY key")
    .all(newer.id) as Array<{ key: string; value: string }>;
  assert.deepEqual(secrets, [
    { key: "OPENAI_API_KEY", value: "enc-a" },
    { key: "SHARED", value: "enc-new" }
  ]);
  assert.equal(
    (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM resource_secrets WHERE resource_id = ?").get(older.id) as {
        n: number;
      }
    ).n,
    0
  );
  assert.equal(findDuplicateResourceGroups(ctx).length, 0, "idempotent");
});

test("different ports or workdirs are different stacks and are never merged", async () => {
  const { ctx, projectId, workdir } = await setup();
  const ids = [
    createResource(ctx, {
      projectId,
      name: "a",
      profile: "supabase",
      config: { workdir, db_url: DB_URL },
      ports: PORTS
    }),
    createResource(ctx, {
      projectId,
      name: "b",
      profile: "supabase",
      config: { workdir, db_url: DB_URL },
      ports: { api: 54621, db: 54622 }
    }),
    createResource(ctx, {
      projectId,
      name: "c",
      profile: "supabase",
      config: { workdir: `${workdir}-other`, db_url: DB_URL },
      ports: PORTS
    })
  ].map((r) => r.id);
  const touched = mergeDuplicateResources(ctx).groups.filter(
    (g) => ids.includes(g.kept.id) || g.merged.some((m) => ids.includes(m.id))
  );
  assert.deepEqual(touched, []);
  for (const id of ids) assert.ok(getResource(ctx, id));
});

test("removing a duplicate record merges it instead of tearing down the shared stack", async () => {
  const { ctx, projectId, serviceId, workdir } = await setup();
  const a = createResource(ctx, {
    projectId,
    name: "a",
    profile: "supabase",
    status: "running",
    config: { workdir, db_url: DB_URL },
    ports: PORTS
  });
  const b = createResource(ctx, {
    projectId,
    name: "b",
    profile: "supabase",
    status: "running",
    config: { workdir, db_url: DB_URL },
    ports: PORTS
  });
  linkResourceToService(ctx, { serviceId, resourceId: a.id });
  const into = mergeIfDuplicate(ctx, a.id);
  assert.equal(into?.id, b.id);
  assert.equal(getResource(ctx, a.id), null);
  assert.deepEqual(
    listLinksForService(ctx, serviceId).map((l) => l.resource_id),
    [b.id],
    "the service's link moved to the surviving record"
  );
  assert.equal(mergeIfDuplicate(ctx, b.id), null, "a lone record is not a duplicate");
});

test("merging keeps the effective link overrides and the started status", async () => {
  const { ctx, projectId, serviceId, workdir } = await setup();
  // Kept record (functions enabled) is stopped and its link inactive; the
  // duplicate is the running one with the link that is actually in effect.
  const kept = createResource(ctx, {
    projectId,
    name: "k",
    profile: "supabase",
    status: "stopped",
    config: { workdir, db_url: DB_URL, functions: { enabled: true } },
    ports: PORTS
  });
  const dup = createResource(ctx, {
    projectId,
    name: "d",
    profile: "supabase",
    status: "running",
    config: { workdir, db_url: DB_URL },
    ports: PORTS
  });
  linkResourceToService(ctx, { serviceId, resourceId: kept.id, envMap: { A: "stale", ONLY_KEPT: "1" } });
  unlinkResource(ctx, serviceId, kept.id);
  linkResourceToService(ctx, { serviceId, resourceId: dup.id, envMap: { A: "live", B: "2" } });

  const into = mergeIfDuplicate(ctx, dup.id);
  assert.equal(into?.id, kept.id);
  const survivor = getResource(ctx, kept.id)!;
  assert.equal(survivor.status, "running", "boot still restarts the stack");
  const links = listLinksForService(ctx, serviceId);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.resource_id, kept.id);
  assert.deepEqual(
    JSON.parse(links[0]!.env_map_json),
    { A: "live", B: "2" },
    "inactive overrides never become live"
  );
});
