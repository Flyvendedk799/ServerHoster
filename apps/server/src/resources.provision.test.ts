import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { getServiceEnvWithLinks, gracefulShutdown } from "./services/runtime.js";
import {
  checkSupabaseCli,
  parseSupabaseStatus,
  setSupabaseCliRunner,
  type CliResult
} from "./services/resources/supabaseCli.js";
import { getProfile } from "./services/resources/profiles.js";
import { supabaseProfile, supabaseResourceAction } from "./services/resources/profiles/supabase.js";
import { postgresProfile } from "./services/resources/profiles/postgres.js";
import { mongoProfile } from "./services/resources/profiles/mongo.js";
import {
  functionEnvFilePath,
  isFunctionsServing,
  setFunctionsSpawn,
  stopFunctionsServe,
  type FunctionsProcessHandle
} from "./services/resources/functions.js";
import {
  getResource,
  listLinksForService,
  listResources,
  resourceConfig
} from "./services/resources/lifecycle.js";
import { getResourceSecret } from "./services/resources/secrets.js";
import { restartOrRedeployService, setRestartActions } from "./services/resources/restart.js";

/**
 * Database-Tracker Phase 3 — local Supabase stack provisioning, postgres
 * profile compatibility, restart-vs-redeploy, and the lifecycle routes.
 *
 * Everything runs WITHOUT Docker or the Supabase CLI: process execution goes
 * through the injectable CLI runner (setSupabaseCliRunner), docker calls hit
 * an in-memory fake on ctx.docker, and restart/redeploy executors are swapped
 * via setRestartActions. `supabase status` parsing is pinned against fixture
 * outputs of both formats (Risk Register: CLI output changes).
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

// ---- pinned `supabase status` fixtures --------------------------------------

const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture-anon-key";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture-service-role-key";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** `supabase status -o env` format (stable KEY="value" lines). */
const STATUS_ENV_OUTPUT = [
  `ANON_KEY="${ANON_KEY}"`,
  `API_URL="http://127.0.0.1:54321"`,
  `DB_URL="${DB_URL}"`,
  `GRAPHQL_URL="http://127.0.0.1:54321/graphql/v1"`,
  `INBUCKET_URL="http://127.0.0.1:54324"`,
  `JWT_SECRET="${JWT_SECRET}"`,
  `S3_PROTOCOL_ACCESS_KEY_ID="625729a08b95bf1b7ff351a663f3a23c"`,
  `SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"`,
  `STORAGE_S3_URL="http://127.0.0.1:54321/storage/v1/s3"`,
  `STUDIO_URL="http://127.0.0.1:54323"`
].join("\n");

// Post-restart fixture: supabase/config.toml was edited, so the stack came
// back with DIFFERENT ports and rotated keys (Gap 2 — restart re-parse).
const NEW_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.rotated-anon-key";
const NEW_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.rotated-service-role-key";
const NEW_JWT_SECRET = "rotated-jwt-secret-with-at-least-32-characters-long!";
const NEW_DB_URL = "postgresql://postgres:postgres@127.0.0.1:64322/postgres";

const RESTARTED_STATUS_OUTPUT = [
  `ANON_KEY="${NEW_ANON_KEY}"`,
  `API_URL="http://127.0.0.1:64321"`,
  `DB_URL="${NEW_DB_URL}"`,
  `GRAPHQL_URL="http://127.0.0.1:64321/graphql/v1"`,
  `JWT_SECRET="${NEW_JWT_SECRET}"`,
  `SERVICE_ROLE_KEY="${NEW_SERVICE_ROLE_KEY}"`,
  `STUDIO_URL="http://127.0.0.1:64323"`
].join("\n");

/** Plain-text format (older CLIs / no -o env support). */
const STATUS_TEXT_OUTPUT = [
  "supabase local development setup is running.",
  "",
  "         API URL: http://127.0.0.1:54321",
  "     GraphQL URL: http://127.0.0.1:54321/graphql/v1",
  `          DB URL: ${DB_URL}`,
  "      Studio URL: http://127.0.0.1:54323",
  "    Inbucket URL: http://127.0.0.1:54324",
  `      JWT secret: ${JWT_SECRET}`,
  `        anon key: ${ANON_KEY}`,
  `service_role key: ${SERVICE_ROLE_KEY}`,
  "   S3 Access Key: 625729a08b95bf1b7ff351a663f3a23c"
].join("\n");

test("parseSupabaseStatus: pinned `-o env` fixture", () => {
  const info = parseSupabaseStatus(STATUS_ENV_OUTPUT);
  assert.equal(info.api_url, "http://127.0.0.1:54321");
  assert.equal(info.graphql_url, "http://127.0.0.1:54321/graphql/v1");
  assert.equal(info.db_url, DB_URL);
  assert.equal(info.studio_url, "http://127.0.0.1:54323");
  assert.equal(info.anon_key, ANON_KEY);
  assert.equal(info.service_role_key, SERVICE_ROLE_KEY);
  assert.equal(info.jwt_secret, JWT_SECRET);
  assert.deepEqual(info.ports, { api: 54321, db: 54322, studio: 54323 });
});

test("parseSupabaseStatus: pinned text-format fixture", () => {
  const info = parseSupabaseStatus(STATUS_TEXT_OUTPUT);
  assert.equal(info.api_url, "http://127.0.0.1:54321");
  assert.equal(info.graphql_url, "http://127.0.0.1:54321/graphql/v1");
  assert.equal(info.db_url, DB_URL);
  assert.equal(info.studio_url, "http://127.0.0.1:54323");
  assert.equal(info.anon_key, ANON_KEY);
  assert.equal(info.service_role_key, SERVICE_ROLE_KEY);
  assert.equal(info.jwt_secret, JWT_SECRET);
  assert.deepEqual(info.ports, { api: 54321, db: 54322, studio: 54323 });
});

test("parseSupabaseStatus: unknown lines are inert, missing fields stay null", () => {
  const info = parseSupabaseStatus('Stopped services: [supabase_imgproxy]\nSOME_NEW_KEY="x"\n');
  assert.equal(info.api_url, null);
  assert.equal(info.anon_key, null);
  assert.deepEqual(info.ports, {});
});

// ---- fake CLI runner ---------------------------------------------------------

type FakeCliOptions = {
  /** args.join(" ") prefixes that should fail with exit 1. */
  failOn?: string[];
  /** Force the `-o env` variant to fail so the text fallback is exercised. */
  envStatusUnsupported?: boolean;
  /**
   * Mutable override for the `supabase status` output — restart re-parse
   * tests swap it between calls (the runner closes over the options object).
   */
  statusOutput?: string;
};

function installFakeCli(options: FakeCliOptions = {}): { calls: string[][] } {
  const calls: string[][] = [];
  setSupabaseCliRunner(async (command, args): Promise<CliResult> => {
    assert.equal(command, "supabase");
    calls.push(args);
    const joined = args.join(" ");
    if (options.failOn?.some((prefix) => joined.startsWith(prefix))) {
      return { code: 1, stdout: "", stderr: `fake failure for: ${joined}` };
    }
    if (joined === "--version") return { code: 0, stdout: "2.30.4\n", stderr: "" };
    if (joined === "status -o env") {
      if (options.envStatusUnsupported) return { code: 1, stdout: "", stderr: "unknown flag: -o" };
      return { code: 0, stdout: options.statusOutput ?? STATUS_ENV_OUTPUT, stderr: "" };
    }
    if (joined === "status") {
      return { code: 0, stdout: options.statusOutput ?? STATUS_TEXT_OUTPUT, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  return { calls };
}

function cliSaw(calls: string[][], prefix: string): boolean {
  return calls.some((args) => args.join(" ").startsWith(prefix));
}

// ---- fake docker + ws capture -------------------------------------------------

function installFakeDocker(ctx: Ctx): { logsRequested: string[] } {
  const logsRequested: string[] = [];
  const fake = {
    ping: async () => "OK",
    listContainers: async (opts: { filters?: Record<string, string[]> }) => {
      // The supabase profile filters by the CLI's project label.
      void opts;
      return [{ Names: ["/supabase_db_app"] }, { Names: ["/supabase_kong_app"] }];
    },
    getContainer: (name: string) => ({
      inspect: async () => ({ State: { Status: "running" } }),
      logs: async () => {
        logsRequested.push(name);
        return Buffer.from(`log line from ${name}\n`);
      },
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
      remove: async () => undefined
    }),
    pull: async () => ({}),
    modem: { followProgress: (_s: unknown, cb: (err: null) => void) => cb(null) },
    createContainer: async () => ({ id: `fake-container-${nanoid(6)}`, start: async () => undefined })
  };
  (ctx as { docker: unknown }).docker = fake;
  return { logsRequested };
}

function captureWsEvents(ctx: Ctx): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const fakeClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    }
  };
  ctx.wsSubscribers.add(fakeClient as unknown as never);
  return events;
}

function installFakeRestart(): { restarted: string[]; redeployed: string[] } {
  const restarted: string[] = [];
  const redeployed: string[] = [];
  setRestartActions({
    restart: async (_ctx, serviceId) => {
      restarted.push(serviceId);
    },
    redeploy: async (_ctx, serviceId) => {
      redeployed.push(serviceId);
      return { status: "success" };
    }
  });
  return { restarted, redeployed };
}

function restoreSeams(): void {
  setSupabaseCliRunner(null);
  setRestartActions(null);
}

// ---- fixtures: a Supabase-shaped working dir ----------------------------------

function makeSupabaseWorkdir(opts: { configToml?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-supabase-test-"));
  if (opts.configToml !== false) {
    fs.mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "supabase", "config.toml"), 'project_id = "fixture-app"\n');
    fs.writeFileSync(
      path.join(dir, "supabase", "migrations", "0001_init.sql"),
      "create table public.things (id uuid primary key);\n"
    );
    fs.mkdirSync(path.join(dir, "supabase", "functions", "ai-chat"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "supabase", "functions", "ai-chat", "index.ts"),
      'const key = Deno.env.get("AI_KEY_ENCRYPTION_KEY");\nexport default key;\n'
    );
  }
  return dir;
}

function seedService(
  ctx: Ctx,
  opts: {
    type?: string;
    workingDir?: string;
    port?: number;
    status?: string;
    repoUrl?: string | null;
  } = {}
): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at,
        linked_database_id, github_repo_url, github_branch)
       VALUES (?, 'proj-prov', ?, ?, 'npm run dev', ?, ?, ?, 0, 0, 5, ?, ?, NULL, ?, 'main')`
    )
    .run(
      id,
      `svc-${id.slice(0, 6)}`,
      opts.type ?? "process",
      opts.workingDir ?? "/tmp",
      opts.port ?? 4567,
      opts.status ?? "stopped",
      nowIso(),
      nowIso(),
      opts.repoUrl ?? null
    );
  return id;
}

/**
 * The tests in one process share a DB file, so failure-path lookups must be
 * scoped to the service under test (resource name defaults to `<service>-supabase`).
 */
function supabaseResourceForService(ctx: Ctx, serviceId: string) {
  const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as {
    name: string;
  };
  return listResources(ctx).find((r) => r.name === `${service.name}-supabase`) ?? null;
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
  assert.equal(login.statusCode, 200);
  return login.json().token as string;
}

// ---- CLI wrapper -------------------------------------------------------------

test("checkSupabaseCli: available with version; missing yields install instructions", async () => {
  installFakeCli();
  try {
    const ok = await checkSupabaseCli();
    assert.equal(ok.available, true);
    assert.equal(ok.version, "2.30.4");
  } finally {
    restoreSeams();
  }
  setSupabaseCliRunner(async () => ({ code: 127, stdout: "", stderr: "command not found" }));
  try {
    const missing = await checkSupabaseCli();
    assert.equal(missing.available, false);
    assert.match(missing.instructions ?? "", /brew install supabase/);
  } finally {
    restoreSeams();
  }
});

// ---- supabase provisioning ----------------------------------------------------

test("supabase provision happy path: ready row, encrypted secrets, env injection, link, restart", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  const { calls } = installFakeCli();
  const restart = installFakeRestart();
  installFakeDocker(ctx);
  const events = captureWsEvents(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir, port: 4567 });
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "schema-only" });

    // Row state + persisted runtime info.
    assert.equal(resource.status, "ready");
    assert.equal(resource.profile, "supabase");
    const config = resourceConfig(resource);
    assert.equal(config.api_url, "http://127.0.0.1:54321");
    assert.equal(config.studio_url, "http://127.0.0.1:54323");
    assert.equal(config.db_url, DB_URL, "db_url stays in config for control-plane use");
    assert.deepEqual(JSON.parse(resource.ports_json), { api: 54321, db: 54322, studio: 54323 });
    assert.deepEqual(JSON.parse(resource.containers_json), ["supabase_db_app", "supabase_kong_app"]);

    // CLI orchestration: schema-only runs `migration up`, never `db reset`.
    assert.ok(cliSaw(calls, "start"), "supabase start must run");
    assert.ok(cliSaw(calls, "status"), "supabase status must run");
    assert.ok(cliSaw(calls, "migration up"), "schema-only applies migrations");
    assert.ok(!cliSaw(calls, "db reset"), "schema-only must never seed");

    // Secrets: encrypted at rest, decrypt back to the parsed values.
    for (const [key, expected] of [
      ["SUPABASE_ANON_KEY", ANON_KEY],
      ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
      ["SUPABASE_JWT_SECRET", JWT_SECRET]
    ] as const) {
      const raw = ctx.db
        .prepare("SELECT value, is_generated FROM resource_secrets WHERE resource_id = ? AND key = ?")
        .get(resource.id, key) as { value: string; is_generated: number };
      assert.ok(raw, `${key} must be stored`);
      assert.ok(!raw.value.includes(expected), `${key} must be ciphertext at rest`);
      assert.equal(raw.is_generated, 1);
      assert.equal(getResourceSecret(ctx, resource.id, key), expected);
    }
    // AI_KEY_ENCRYPTION_KEY generated because a function reads it.
    const aiKey = getResourceSecret(ctx, resource.id, "AI_KEY_ENCRYPTION_KEY");
    assert.ok(aiKey && aiKey.length > 20, "AI_KEY_ENCRYPTION_KEY must be generated");

    // Link + env injection.
    const links = listLinksForService(ctx, serviceId);
    assert.equal(links.length, 1);
    assert.equal(links[0].resource_id, resource.id);

    const env = supabaseProfile.env(ctx, resource.id, serviceId);
    assert.equal(env.SUPABASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.VITE_SUPABASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.SUPABASE_ANON_KEY, ANON_KEY);
    assert.equal(env.VITE_SUPABASE_PUBLISHABLE_KEY, ANON_KEY);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, SERVICE_ROLE_KEY, "backend services get the service role");
    assert.equal(env.APP_URL, "http://localhost:4567");
    assert.ok(!("SUPABASE_JWT_SECRET" in env), "JWT secret is never injected");
    assert.ok(!Object.values(env).includes(DB_URL), "db_url is never injected");

    const merged = getServiceEnvWithLinks(ctx, serviceId);
    assert.equal(merged.VITE_SUPABASE_URL, "http://127.0.0.1:54321");
    assert.equal(merged.SUPABASE_ANON_KEY, ANON_KEY);

    // Restart: process service → restart (not redeploy).
    assert.deepEqual(restart.restarted, [serviceId]);
    assert.deepEqual(restart.redeployed, []);

    // WS lifecycle events.
    const statusEvents = events.filter((e) => e.type === "resource_status").map((e) => e.status);
    assert.deepEqual(statusEvents, ["provisioning", "ready"]);
    const steps = events.filter((e) => e.type === "resource_provisioning").map((e) => e.step);
    for (const expected of ["preflight", "start", "status", "migrate", "restart", "done"]) {
      assert.ok(steps.includes(expected), `missing provisioning step event: ${expected}`);
    }
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("supabase provision: static frontends never receive the service role key", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir, type: "static", port: 8080 });
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "empty", restart: false });
    const env = supabaseProfile.env(ctx, resource.id, serviceId);
    assert.equal(env.VITE_SUPABASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.VITE_SUPABASE_PUBLISHABLE_KEY, ANON_KEY);
    assert.ok(
      !("SUPABASE_SERVICE_ROLE_KEY" in env),
      "static bundle is world-readable — service role must not be injected"
    );
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("supabase provision mode matrix: seed only on schema-and-seed; empty skips migrations", async () => {
  for (const [mode, expectMigrate, expectSeed] of [
    ["schema-only", true, false],
    ["schema-and-seed", false, true],
    ["empty", false, false]
  ] as const) {
    const ctx = await buildApp();
    const workdir = makeSupabaseWorkdir();
    const { calls } = installFakeCli();
    installFakeRestart();
    installFakeDocker(ctx);
    try {
      const serviceId = seedService(ctx, { workingDir: workdir });
      const resource = await supabaseProfile.provision(ctx, { serviceId, mode, restart: false });
      assert.equal(resource.status, "ready", `${mode} must provision cleanly`);
      assert.equal(cliSaw(calls, "migration up"), expectMigrate, `${mode}: migration up`);
      assert.equal(cliSaw(calls, "db reset"), expectSeed, `${mode}: db reset (seed)`);
    } finally {
      restoreSeams();
      fs.rmSync(workdir, { recursive: true, force: true });
      await gracefulShutdown(ctx);
    }
  }
});

test("supabase provision failure at migration: status failed, stack stopped, error retained", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  const { calls } = installFakeCli({ failOn: ["migration up"] });
  installFakeRestart();
  installFakeDocker(ctx);
  const events = captureWsEvents(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir });
    await assert.rejects(
      () => supabaseProfile.provision(ctx, { serviceId, mode: "schema-only" }),
      /migration up failed/
    );
    const resource = supabaseResourceForService(ctx, serviceId);
    assert.ok(resource, "failed row must be kept for diagnostics");
    assert.equal(resource.status, "failed");
    assert.match(String(resourceConfig(resource).error ?? ""), /migration up failed/);
    assert.ok(cliSaw(calls, "stop"), "best-effort supabase stop after failure");
    const statusEvents = events.filter((e) => e.type === "resource_status").map((e) => e.status);
    assert.deepEqual(statusEvents, ["provisioning", "failed"]);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("supabase provision preflight: missing config.toml fails fast without starting the stack", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir({ configToml: false });
  const { calls } = installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir });
    await assert.rejects(() => supabaseProfile.provision(ctx, { serviceId }), /No supabase\/config\.toml/);
    const resource = supabaseResourceForService(ctx, serviceId);
    assert.equal(resource?.status, "failed");
    assert.ok(!cliSaw(calls, "start"), "stack must not start when preflight fails");
    assert.ok(!cliSaw(calls, "stop"), "nothing to stop when the stack never started");
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("supabase status fallback: text output is used when -o env is unsupported", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  installFakeCli({ envStatusUnsupported: true });
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir });
    const resource = await supabaseProfile.provision(ctx, { serviceId, restart: false });
    assert.equal(resource.status, "ready");
    assert.equal(resourceConfig(resource).api_url, "http://127.0.0.1:54321");
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY"), ANON_KEY);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

// ---- start/restart re-parses `supabase status` (Gap 2) --------------------------

test("supabase restart re-parses status: new ports/keys are re-recorded, empty output never clobbers", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  const cliOptions: FakeCliOptions = {};
  installFakeCli(cliOptions);
  installFakeRestart();
  installFakeDocker(ctx);
  const events = captureWsEvents(ctx);
  try {
    const serviceId = seedService(ctx, { workingDir: workdir, port: 4567 });
    const resource = await supabaseProfile.provision(ctx, {
      serviceId,
      mode: "empty",
      restart: false,
      serveFunctions: false
    });
    assert.equal(resourceConfig(resource).api_url, "http://127.0.0.1:54321");

    // config.toml changed → the restarted stack reports different ports/keys.
    cliOptions.statusOutput = RESTARTED_STATUS_OUTPUT;
    await supabaseResourceAction(ctx, resource.id, "restart");

    const refreshed = getResource(ctx, resource.id)!;
    const config = resourceConfig(refreshed);
    assert.equal(config.api_url, "http://127.0.0.1:64321");
    assert.equal(config.studio_url, "http://127.0.0.1:64323");
    assert.equal(config.db_url, NEW_DB_URL);
    assert.deepEqual(JSON.parse(refreshed.ports_json), { api: 64321, db: 64322, studio: 64323 });
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY"), NEW_ANON_KEY);
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY"), NEW_SERVICE_ROLE_KEY);
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_JWT_SECRET"), NEW_JWT_SECRET);

    // env() reflects the refreshed values immediately.
    const env = supabaseProfile.env(ctx, resource.id, serviceId);
    assert.equal(env.SUPABASE_URL, "http://127.0.0.1:64321");
    assert.equal(env.VITE_SUPABASE_URL, "http://127.0.0.1:64321");
    assert.equal(env.SUPABASE_ANON_KEY, NEW_ANON_KEY);

    // The action path still broadcasts resource_status lifecycle events.
    const statusEvents = events.filter((e) => e.type === "resource_status").map((e) => e.status);
    assert.deepEqual(statusEvents.slice(-2), ["stopped", "running"]);

    // A status output with empty/missing fields must NOT clobber stored info.
    cliOptions.statusOutput = "Stopped services: [supabase_imgproxy]\n";
    await supabaseResourceAction(ctx, resource.id, "start");
    const afterEmpty = getResource(ctx, resource.id)!;
    assert.equal(resourceConfig(afterEmpty).api_url, "http://127.0.0.1:64321");
    assert.deepEqual(JSON.parse(afterEmpty.ports_json), { api: 64321, db: 64322, studio: 64323 });
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY"), NEW_ANON_KEY);
    assert.equal(getResourceSecret(ctx, resource.id, "SUPABASE_JWT_SECRET"), NEW_JWT_SECRET);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("supabase restart with functions serving: env file rewritten with refreshed values, serve restarted", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  const cliOptions: FakeCliOptions = {};
  installFakeCli(cliOptions);
  installFakeRestart();
  installFakeDocker(ctx);
  const spawned: string[][] = [];
  setFunctionsSpawn((args): FunctionsProcessHandle => {
    spawned.push(args);
    return { pid: 4242, onOutput: () => undefined, onExit: () => undefined, stop: () => undefined };
  });
  try {
    const serviceId = seedService(ctx, { workingDir: workdir });
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "empty", restart: false });
    assert.equal(spawned.length, 1, "provision serves the edge functions");
    assert.ok(isFunctionsServing(resource.id));
    const envFile = functionEnvFilePath(ctx, resource.id);
    assert.match(fs.readFileSync(envFile, "utf8"), /http:\/\/127\.0\.0\.1:54321/);

    cliOptions.statusOutput = RESTARTED_STATUS_OUTPUT;
    await supabaseResourceAction(ctx, resource.id, "restart");

    assert.equal(spawned.length, 2, "restart must restart the serve process");
    assert.ok(isFunctionsServing(resource.id));
    const rewritten = fs.readFileSync(envFile, "utf8");
    assert.match(rewritten, /SUPABASE_URL="http:\/\/127\.0\.0\.1:64321"/);
    assert.ok(rewritten.includes(NEW_ANON_KEY), "env file must carry the rotated anon key");
    assert.ok(rewritten.includes(NEW_SERVICE_ROLE_KEY), "env file must carry the rotated service role key");
    assert.ok(!rewritten.includes(ANON_KEY), "stale anon key must be gone");

    await stopFunctionsServe(ctx, getResource(ctx, resource.id)!, { persist: false });
  } finally {
    setFunctionsSpawn(null);
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

// ---- restart vs redeploy -------------------------------------------------------

test("restartOrRedeployService: static+git rebuilds, everything else restarts", async () => {
  const ctx = await buildApp();
  const restart = installFakeRestart();
  try {
    const processSvc = seedService(ctx, { type: "process" });
    assert.deepEqual(await restartOrRedeployService(ctx, processSvc), { action: "restarted" });

    const staticGit = seedService(ctx, { type: "static", repoUrl: "https://github.com/x/y.git" });
    assert.deepEqual(await restartOrRedeployService(ctx, staticGit), { action: "redeployed" });

    // Static without a repo can't be rebuilt — falls back to restart.
    const staticLocal = seedService(ctx, { type: "static", repoUrl: null });
    assert.deepEqual(await restartOrRedeployService(ctx, staticLocal), { action: "restarted" });

    assert.deepEqual(restart.restarted, [processSvc, staticLocal]);
    assert.deepEqual(restart.redeployed, [staticGit]);

    // A failed rebuild surfaces as an error.
    setRestartActions({
      restart: async () => undefined,
      redeploy: async () => ({ status: "failed" })
    });
    await assert.rejects(() => restartOrRedeployService(ctx, staticGit), /Rebuild after resource/);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

// ---- routes ---------------------------------------------------------------------

test("routes: provision + lifecycle + logs + link/unlink + delete, with secret redaction", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  const { calls } = installFakeCli();
  installFakeRestart();
  const { logsRequested } = installFakeDocker(ctx);
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx, { workingDir: workdir });

    // Auth is enforced.
    const unauthorized = await ctx.app.inject({ method: "POST", url: "/resources/provision" });
    assert.equal(unauthorized.statusCode, 401);

    // Provision through the API.
    const provision = await ctx.app.inject({
      method: "POST",
      url: "/resources/provision",
      headers: auth,
      payload: {
        serviceId,
        profile: "supabase",
        mode: "schema-only",
        restart: false,
        secrets: { OPENAI_API_KEY: "sk-user-pasted-key" },
        disabledSecrets: ["RESEND_API_KEY"]
      }
    });
    assert.equal(provision.statusCode, 200, provision.body);
    const body = provision.json() as {
      id: string;
      status: string;
      config: Record<string, unknown>;
      secrets: Array<{ key: string; is_generated: boolean; value_preview: string }>;
    };
    assert.equal(body.status, "ready");

    // Redaction: raw secret material and db_url never appear in any response.
    assert.ok(!provision.body.includes(SERVICE_ROLE_KEY), "service role key must never be returned");
    assert.ok(!provision.body.includes(JWT_SECRET), "JWT secret must never be returned");
    assert.ok(!provision.body.includes(DB_URL), "db_url must never be returned");
    assert.ok(!provision.body.includes("sk-user-pasted-key"), "user secrets must never be echoed");
    assert.ok(!("db_url" in body.config), "db_url is stripped from config");
    assert.deepEqual(body.config.disabled_secrets, ["RESEND_API_KEY"]);

    // User-provided secret stored encrypted, not generated.
    const userSecret = body.secrets.find((s) => s.key === "OPENAI_API_KEY");
    assert.ok(userSecret, "user secret must be stored");
    assert.equal(userSecret.is_generated, false);
    assert.ok(!userSecret.value_preview.includes("sk-user-pasted-key"));
    assert.equal(getResourceSecret(ctx, body.id, "OPENAI_API_KEY"), "sk-user-pasted-key");

    // Detail view applies the same redaction.
    const detail = await ctx.app.inject({ method: "GET", url: `/resources/${body.id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    assert.ok(!detail.body.includes(SERVICE_ROLE_KEY));
    assert.ok(!detail.body.includes(DB_URL));

    // Lifecycle: stop → start → restart drive the CLI from the recorded workdir.
    calls.length = 0;
    const stop = await ctx.app.inject({ method: "POST", url: `/resources/${body.id}/stop`, headers: auth });
    assert.equal(stop.statusCode, 200);
    assert.ok(cliSaw(calls, "stop"));
    assert.equal(getResource(ctx, body.id)?.status, "stopped");

    const start = await ctx.app.inject({
      method: "POST",
      url: `/resources/${body.id}/start`,
      headers: auth
    });
    assert.equal(start.statusCode, 200);
    assert.ok(cliSaw(calls, "start"));
    assert.equal(getResource(ctx, body.id)?.status, "running");

    calls.length = 0;
    const restartRes = await ctx.app.inject({
      method: "POST",
      url: `/resources/${body.id}/restart`,
      headers: auth
    });
    assert.equal(restartRes.statusCode, 200);
    assert.ok(cliSaw(calls, "stop") && cliSaw(calls, "start"));

    // Logs: docker logs of every recorded container, secrets redacted by nature.
    const logs = await ctx.app.inject({ method: "GET", url: `/resources/${body.id}/logs`, headers: auth });
    assert.equal(logs.statusCode, 200);
    const logsBody = logs.json() as { logs: string };
    assert.match(logsBody.logs, /=== supabase_db_app ===/);
    assert.match(logsBody.logs, /log line from supabase_kong_app/);
    assert.deepEqual(logsRequested.sort(), ["supabase_db_app", "supabase_kong_app"]);

    // Unlink stops env injection; link reactivates it.
    const unlink = await ctx.app.inject({
      method: "POST",
      url: `/resources/${body.id}/unlink`,
      headers: auth,
      payload: { serviceId }
    });
    assert.equal(unlink.statusCode, 200);
    assert.equal(listLinksForService(ctx, serviceId).length, 0);
    assert.ok(!("VITE_SUPABASE_URL" in getServiceEnvWithLinks(ctx, serviceId)));

    const link = await ctx.app.inject({
      method: "POST",
      url: `/resources/${body.id}/link`,
      headers: auth,
      payload: { serviceId }
    });
    assert.equal(link.statusCode, 200);
    assert.equal(listLinksForService(ctx, serviceId).length, 1);
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).VITE_SUPABASE_URL, "http://127.0.0.1:54321");

    // Delete: warns linked services (notification), stops the stack, removes the row.
    calls.length = 0;
    const remove = await ctx.app.inject({ method: "DELETE", url: `/resources/${body.id}`, headers: auth });
    assert.equal(remove.statusCode, 200);
    assert.deepEqual(remove.json(), { ok: true, strandedServices: 1 });
    assert.ok(cliSaw(calls, "stop"), "removal stops the local stack");
    assert.equal(getResource(ctx, body.id), null);
    assert.equal(listLinksForService(ctx, serviceId, false).length, 0);
    const warning = ctx.db
      .prepare("SELECT title FROM notifications WHERE service_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(serviceId) as { title: string } | undefined;
    assert.match(warning?.title ?? "", /Resource removed/);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("routes: provisioning failure surfaces an error and leaves a diagnosable failed row", async () => {
  const ctx = await buildApp();
  const workdir = makeSupabaseWorkdir();
  installFakeCli({ failOn: ["migration up"] });
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx, { workingDir: workdir });
    const provision = await ctx.app.inject({
      method: "POST",
      url: "/resources/provision",
      headers: auth,
      payload: { serviceId, profile: "supabase", mode: "schema-only", restart: false }
    });
    assert.equal(provision.statusCode, 500);
    const failed = supabaseResourceForService(ctx, serviceId);
    assert.ok(failed, "failed row must be kept for diagnostics");
    const detail = await ctx.app.inject({ method: "GET", url: `/resources/${failed.id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { status: string }).status, "failed");
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

// ---- postgres profile compatibility ---------------------------------------------

test("postgres profile provision: legacy databases row + linked_database_id + resource row", async () => {
  const ctx = await buildApp();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx, { type: "process" });

    const resource = await postgresProfile.provision(ctx, { serviceId, restart: false });
    assert.equal(resource.status, "ready");

    // Legacy databases row exists and the service points at it.
    const config = resourceConfig(resource);
    const databaseId = String(config.database_id ?? "");
    assert.ok(databaseId, "config_json.database_id must reference the legacy row");
    const dbRow = ctx.db.prepare("SELECT * FROM databases WHERE id = ?").get(databaseId) as
      | { id: string; engine: string; port: number; connection_string: string }
      | undefined;
    assert.ok(dbRow, "legacy databases row must exist");
    assert.equal(dbRow.engine, "postgres");
    const svc = ctx.db.prepare("SELECT linked_database_id FROM services WHERE id = ?").get(serviceId) as {
      linked_database_id: string | null;
    };
    assert.equal(svc.linked_database_id, databaseId);

    // Resource link + env injection produce the same DATABASE_URL.
    assert.equal(listLinksForService(ctx, serviceId).length, 1);
    const env = postgresProfile.env(ctx, resource.id, serviceId);
    assert.equal(env.DATABASE_URL, dbRow.connection_string);
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).DATABASE_URL, dbRow.connection_string);

    // Encrypted DATABASE_URL copy in resource secrets (legacy row unchanged).
    const rawSecret = ctx.db
      .prepare("SELECT value FROM resource_secrets WHERE resource_id = ? AND key = 'DATABASE_URL'")
      .get(resource.id) as { value: string } | undefined;
    assert.ok(rawSecret && !rawSecret.value.includes(dbRow.connection_string));

    // /databases/* keeps working on the same row.
    const dbList = await ctx.app.inject({ method: "GET", url: `/databases/${databaseId}`, headers: auth });
    assert.equal(dbList.statusCode, 200);

    // Removal goes through the shared path: databases row gone, link nulled.
    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/resources/${resource.id}`,
      headers: auth
    });
    assert.equal(remove.statusCode, 200);
    assert.equal(getResource(ctx, resource.id), null);
    assert.equal(ctx.db.prepare("SELECT id FROM databases WHERE id = ?").get(databaseId), undefined);
    const svcAfter = ctx.db
      .prepare("SELECT linked_database_id FROM services WHERE id = ?")
      .get(serviceId) as { linked_database_id: string | null };
    assert.equal(svcAfter.linked_database_id, null);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("mysql profile provision (route): legacy mysql row + DATABASE_URL injection + /databases compat + removal", async () => {
  const ctx = await buildApp();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx, { type: "process" });

    const provision = await ctx.app.inject({
      method: "POST",
      url: "/resources/provision",
      headers: auth,
      payload: { serviceId, profile: "mysql", restart: false }
    });
    assert.equal(provision.statusCode, 200, provision.body);
    const body = provision.json() as { id: string; status: string; ports: Record<string, number> };
    assert.equal(body.status, "ready");

    // Legacy databases row exists with the right engine and the service points at it.
    const resource = getResource(ctx, body.id)!;
    const databaseId = String(resourceConfig(resource).database_id ?? "");
    assert.ok(databaseId, "config_json.database_id must reference the legacy row");
    const dbRow = ctx.db.prepare("SELECT * FROM databases WHERE id = ?").get(databaseId) as
      | { id: string; engine: string; port: number; connection_string: string }
      | undefined;
    assert.ok(dbRow, "legacy databases row must exist");
    assert.equal(dbRow.engine, "mysql");
    assert.ok(
      dbRow.port >= 33306 && dbRow.port <= 33406,
      `mysql port ${dbRow.port} must come from the profile window`
    );
    assert.deepEqual(body.ports, { mysql: dbRow.port });
    assert.match(dbRow.connection_string, /^mysql:\/\//);
    const svc = ctx.db.prepare("SELECT linked_database_id FROM services WHERE id = ?").get(serviceId) as {
      linked_database_id: string | null;
    };
    assert.equal(svc.linked_database_id, databaseId);

    // Resource link + env injection produce the same DATABASE_URL.
    assert.equal(listLinksForService(ctx, serviceId).length, 1);
    const mysqlProfile = getProfile("mysql")!;
    assert.equal(mysqlProfile.env(ctx, body.id, serviceId).DATABASE_URL, dbRow.connection_string);
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).DATABASE_URL, dbRow.connection_string);

    // Encrypted DATABASE_URL copy in resource secrets.
    const rawSecret = ctx.db
      .prepare("SELECT value FROM resource_secrets WHERE resource_id = ? AND key = 'DATABASE_URL'")
      .get(body.id) as { value: string } | undefined;
    assert.ok(rawSecret && !rawSecret.value.includes(dbRow.connection_string));

    // /databases/* keeps working on the same row.
    const dbDetail = await ctx.app.inject({ method: "GET", url: `/databases/${databaseId}`, headers: auth });
    assert.equal(dbDetail.statusCode, 200);

    // Removal goes through the shared path: databases row gone, link nulled.
    const remove = await ctx.app.inject({ method: "DELETE", url: `/resources/${body.id}`, headers: auth });
    assert.equal(remove.statusCode, 200);
    assert.equal(getResource(ctx, body.id), null);
    assert.equal(ctx.db.prepare("SELECT id FROM databases WHERE id = ?").get(databaseId), undefined);
    const svcAfter = ctx.db
      .prepare("SELECT linked_database_id FROM services WHERE id = ?")
      .get(serviceId) as { linked_database_id: string | null };
    assert.equal(svcAfter.linked_database_id, null);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("mongo profile provision: legacy mongo row, mongodb:// DATABASE_URL, removal cascades", async () => {
  const ctx = await buildApp();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  try {
    const serviceId = seedService(ctx, { type: "process" });
    const resource = await mongoProfile.provision(ctx, { serviceId, restart: false });
    assert.equal(resource.status, "ready");
    assert.equal(resource.profile, "mongo");

    const databaseId = String(resourceConfig(resource).database_id ?? "");
    const dbRow = ctx.db.prepare("SELECT * FROM databases WHERE id = ?").get(databaseId) as
      | { id: string; engine: string; port: number; connection_string: string }
      | undefined;
    assert.ok(dbRow, "legacy databases row must exist");
    assert.equal(dbRow.engine, "mongo");
    assert.ok(
      dbRow.port >= 47017 && dbRow.port <= 47117,
      `mongo port ${dbRow.port} must come from the profile window`
    );
    assert.deepEqual(JSON.parse(resource.ports_json), { mongo: dbRow.port });
    assert.match(dbRow.connection_string, /^mongodb:\/\/.*authSource=admin$/);

    const svc = ctx.db.prepare("SELECT linked_database_id FROM services WHERE id = ?").get(serviceId) as {
      linked_database_id: string | null;
    };
    assert.equal(svc.linked_database_id, databaseId);
    assert.equal(mongoProfile.env(ctx, resource.id, serviceId).DATABASE_URL, dbRow.connection_string);
    assert.equal(getServiceEnvWithLinks(ctx, serviceId).DATABASE_URL, dbRow.connection_string);

    await mongoProfile.remove(ctx, resource.id);
    assert.equal(getResource(ctx, resource.id), null);
    assert.equal(ctx.db.prepare("SELECT id FROM databases WHERE id = ?").get(databaseId), undefined);
    assert.equal(listLinksForService(ctx, serviceId).length, 0);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("redis still rejects provisioning; mysql and mongo are registered profiles now", async () => {
  const ctx = await buildApp();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx);
    const redis = await ctx.app.inject({
      method: "POST",
      url: "/resources/provision",
      headers: auth,
      payload: { serviceId, profile: "redis" }
    });
    assert.equal(redis.statusCode, 500);
    assert.ok(getProfile("mysql"), "mysql profile must be registered");
    assert.ok(getProfile("mongo"), "mongo profile must be registered");
  } finally {
    await gracefulShutdown(ctx);
  }
});
