import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown } from "./services/runtime.js";
import { setSupabaseCliRunner, type CliResult } from "./services/resources/supabaseCli.js";
import { supabaseProfile } from "./services/resources/profiles/supabase.js";
import { createResource, getResource, resourceConfig } from "./services/resources/lifecycle.js";
import { getResourceSecret, setResourceSecret } from "./services/resources/secrets.js";
import { scanFunctionSecrets } from "./services/resources/secretsScan.js";
import {
  classifySecretStates,
  functionEnvFilePath,
  functionStatuses,
  isFunctionsServing,
  listEdgeFunctions,
  setFunctionsSpawn,
  startFunctionsServe,
  writeFunctionEnvFile,
  type FunctionsProcessHandle
} from "./services/resources/functions.js";
import { setRestartActions } from "./services/resources/restart.js";

/**
 * Database-Tracker Phase 4 — Edge Functions and secrets: per-function secret
 * attribution, env-file generation, the serve-process lifecycle, secret state
 * classification, and the env-requirements / secrets routes.
 *
 * Deterministic by construction: the Supabase CLI goes through the injectable
 * runner, docker through an in-memory fake, restarts through setRestartActions,
 * and the `supabase functions serve` process through setFunctionsSpawn.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

const LEARNAI_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/services/resources/__fixtures__/learnai-like"
);

const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture-anon-key";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture-service-role-key";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const STATUS_ENV_OUTPUT = [
  `ANON_KEY="${ANON_KEY}"`,
  `API_URL="http://127.0.0.1:54321"`,
  `DB_URL="${DB_URL}"`,
  `GRAPHQL_URL="http://127.0.0.1:54321/graphql/v1"`,
  `JWT_SECRET="${JWT_SECRET}"`,
  `SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"`,
  `STUDIO_URL="http://127.0.0.1:54323"`
].join("\n");

// ---- seams ---------------------------------------------------------------------

function installFakeCli(): { calls: string[][] } {
  const calls: string[][] = [];
  setSupabaseCliRunner(async (command, args): Promise<CliResult> => {
    assert.equal(command, "supabase");
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "--version") return { code: 0, stdout: "2.30.4\n", stderr: "" };
    if (joined === "status -o env") return { code: 0, stdout: STATUS_ENV_OUTPUT, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  return { calls };
}

function installFakeDocker(ctx: Ctx): void {
  const fake = {
    ping: async () => "OK",
    listContainers: async () => [{ Names: ["/supabase_db_app"] }],
    getContainer: () => ({
      inspect: async () => ({ State: { Status: "running" } }),
      logs: async () => Buffer.from("docker log line\n")
    })
  };
  (ctx as { docker: unknown }).docker = fake;
}

function installFakeRestart(): void {
  setRestartActions({
    restart: async () => undefined,
    redeploy: async () => ({ status: "success" })
  });
}

type FakeServeHandle = FunctionsProcessHandle & {
  stopped: boolean;
  emit(chunk: string): void;
  exit(code: number): void;
};

function makeFakeHandle(pid: number): FakeServeHandle {
  const outputListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  const handle: FakeServeHandle = {
    pid,
    stopped: false,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    stop() {
      handle.stopped = true;
    },
    emit(chunk) {
      for (const listener of outputListeners) listener(chunk);
    },
    exit(code) {
      for (const listener of exitListeners) listener(code);
    }
  };
  return handle;
}

function installFakeServeSpawn(opts: { failOnSpawn?: boolean } = {}): {
  calls: Array<{ args: string[]; cwd: string }>;
  handles: FakeServeHandle[];
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const handles: FakeServeHandle[] = [];
  setFunctionsSpawn((args, options) => {
    calls.push({ args, cwd: options.cwd });
    if (opts.failOnSpawn) throw new Error("spawn supabase ENOENT");
    const handle = makeFakeHandle(40000 + handles.length);
    handles.push(handle);
    return handle;
  });
  return { calls, handles };
}

function restoreSeams(): void {
  setSupabaseCliRunner(null);
  setRestartActions(null);
  setFunctionsSpawn(null);
}

// ---- fixtures --------------------------------------------------------------------

/** Supabase workdir with two functions reading distinct keys plus a _shared dir. */
function makeFunctionsWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-fn-test-"));
  fs.mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "supabase", "config.toml"), 'project_id = "fn-fixture"\n');
  fs.writeFileSync(
    path.join(dir, "supabase", "migrations", "0001_init.sql"),
    "create table public.things (id uuid primary key);\n"
  );
  fs.mkdirSync(path.join(dir, "supabase", "functions", "ai-chat"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "supabase", "functions", "ai-chat", "index.ts"),
    [
      'const openai = Deno.env.get("OPENAI_API_KEY");',
      'const url = Deno.env.get("SUPABASE_URL");',
      'const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");',
      'const aiKey = Deno.env.get("AI_KEY_ENCRYPTION_KEY");',
      "export default { openai, url, serviceRole, aiKey };"
    ].join("\n")
  );
  fs.mkdirSync(path.join(dir, "supabase", "functions", "send-email"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "supabase", "functions", "send-email", "index.ts"),
    'const resend = Deno.env.get("RESEND_API_KEY");\nexport default resend;\n'
  );
  fs.mkdirSync(path.join(dir, "supabase", "functions", "_shared"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "supabase", "functions", "_shared", "util.ts"),
    'export const lovable = Deno.env.get("LOVABLE_API_KEY");\n'
  );
  return dir;
}

function seedService(ctx: Ctx, workingDir: string): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, 'proj-fn', ?, 'process', 'npm run dev', ?, 4321, 'stopped', 0, 0, 5, ?, ?, NULL)`
    )
    .run(id, `svc-${id.slice(0, 6)}`, workingDir, nowIso(), nowIso());
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
  assert.equal(login.statusCode, 200);
  return login.json().token as string;
}

// ---- per-function secret attribution ----------------------------------------------

test("listEdgeFunctions: LearnAI fixture attributes keys to ai-chat", () => {
  const functions = listEdgeFunctions(LEARNAI_FIXTURE_DIR);
  assert.equal(functions.length, 1);
  const aiChat = functions[0];
  assert.equal(aiChat.name, "ai-chat");
  assert.equal(aiChat.path, path.join("supabase", "functions", "ai-chat"));
  const byKey = new Map(aiChat.secrets.map((s) => [s.key, s]));
  assert.equal(byKey.get("OPENAI_API_KEY")?.classification, "optional-external");
  assert.deepEqual(byKey.get("OPENAI_API_KEY")?.source_files, [
    path.join("supabase", "functions", "ai-chat", "index.ts")
  ]);
  assert.equal(byKey.get("SUPABASE_URL")?.classification, "auto-generated");
  assert.equal(byKey.get("SUPABASE_SERVICE_ROLE_KEY")?.classification, "auto-generated");
});

test("listEdgeFunctions: keys are attributed per function; _shared is not a function", () => {
  const workdir = makeFunctionsWorkdir();
  try {
    const functions = listEdgeFunctions(workdir);
    assert.deepEqual(
      functions.map((fn) => fn.name),
      ["ai-chat", "send-email"]
    );
    const aiChatKeys = functions[0].secrets.map((s) => s.key);
    assert.ok(aiChatKeys.includes("OPENAI_API_KEY"));
    assert.ok(!aiChatKeys.includes("RESEND_API_KEY"), "send-email's key must not leak into ai-chat");
    assert.deepEqual(
      functions[1].secrets.map((s) => s.key),
      ["RESEND_API_KEY"]
    );

    // Aggregate export still covers everything, including _shared code.
    const aggregateKeys = scanFunctionSecrets(workdir).map((s) => s.key);
    for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "LOVABLE_API_KEY"]) {
      assert.ok(aggregateKeys.includes(key), `aggregate must include ${key}`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

// ---- env file generation -----------------------------------------------------------

test("writeFunctionEnvFile: generated + provided values, minus disabled, mode 0600", async () => {
  const ctx = await buildApp();
  try {
    const resource = createResource(ctx, {
      name: "envfile-test",
      profile: "supabase",
      status: "ready",
      config: {
        workdir: "/tmp",
        api_url: "http://127.0.0.1:54321",
        disabled_secrets: ["RESEND_API_KEY"]
      }
    });
    setResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY", ANON_KEY, true);
    setResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY, true);
    setResourceSecret(ctx, resource.id, "SUPABASE_JWT_SECRET", JWT_SECRET, true);
    setResourceSecret(ctx, resource.id, "AI_KEY_ENCRYPTION_KEY", "ai-encryption-key-value", true);
    setResourceSecret(ctx, resource.id, "OPENAI_API_KEY", "sk-user-pasted-openai-key", false);
    setResourceSecret(ctx, resource.id, "RESEND_API_KEY", "re-disabled-key-value", false);

    const result = writeFunctionEnvFile(ctx, resource.id);
    assert.equal(result.path, functionEnvFilePath(ctx, resource.id));
    assert.ok(
      result.path.startsWith(path.join(ctx.config.dataRoot, "resources", resource.id)),
      "env file must live under $SURVHUB_DATA_DIR/resources/<resourceId>/"
    );
    assert.deepEqual(result.keys, [
      "AI_KEY_ENCRYPTION_KEY",
      "OPENAI_API_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_URL"
    ]);

    const content = fs.readFileSync(result.path, "utf8");
    assert.match(content, /SUPABASE_URL="http:\/\/127\.0\.0\.1:54321"/);
    assert.ok(content.includes(`SUPABASE_ANON_KEY="${ANON_KEY}"`), "decrypted anon key");
    assert.ok(content.includes(`SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"`));
    assert.ok(content.includes('OPENAI_API_KEY="sk-user-pasted-openai-key"'), "user secret decrypted");
    assert.ok(!content.includes("RESEND_API_KEY"), "disabled keys are excluded");
    assert.ok(!content.includes(JWT_SECRET), "JWT secret never lands in the function env file");

    const mode = fs.statSync(result.path).mode & 0o777;
    assert.equal(mode, 0o600, "env file must be 0600");

    // Rewrites keep the mode and apply changes.
    setResourceSecret(ctx, resource.id, "OPENAI_API_KEY", "sk-rotated-key", false);
    const rewritten = writeFunctionEnvFile(ctx, resource.id);
    assert.ok(fs.readFileSync(rewritten.path, "utf8").includes("sk-rotated-key"));
    assert.equal(fs.statSync(rewritten.path).mode & 0o777, 0o600);
  } finally {
    await gracefulShutdown(ctx);
  }
});

// ---- secret state classification ----------------------------------------------------

test("classifySecretStates: full matrix of the five spec states", async () => {
  const ctx = await buildApp();
  try {
    const resource = createResource(ctx, {
      name: "state-matrix",
      profile: "supabase",
      status: "ready",
      config: {
        workdir: "/tmp",
        api_url: "http://127.0.0.1:54321",
        disabled_secrets: ["RESEND_API_KEY"]
      }
    });
    setResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY", ANON_KEY, true);
    setResourceSecret(ctx, resource.id, "OPENAI_API_KEY", "sk-user-key", false);

    const requirements = [
      { key: "SUPABASE_ANON_KEY", classification: "auto-generated" as const, source_files: ["a.ts"] },
      { key: "SUPABASE_URL", classification: "auto-generated" as const, source_files: ["a.ts"] },
      { key: "OPENAI_API_KEY", classification: "optional-external" as const, source_files: ["a.ts"] },
      { key: "RESEND_API_KEY", classification: "optional-external" as const, source_files: ["b.ts"] },
      { key: "AI_KEY_ENCRYPTION_KEY", classification: "auto-generated" as const, source_files: ["a.ts"] },
      { key: "LOVABLE_API_KEY", classification: "optional-external" as const, source_files: ["b.ts"] },
      { key: "SOME_RANDOM_FLAG", classification: "unknown" as const, source_files: ["b.ts"] }
    ];
    const states = new Map(
      classifySecretStates(ctx, getResource(ctx, resource.id)!, requirements).map((s) => [s.key, s.state])
    );
    assert.equal(states.get("SUPABASE_ANON_KEY"), "generated", "is_generated secret");
    assert.equal(states.get("SUPABASE_URL"), "generated", "derived from config api_url");
    assert.equal(states.get("OPENAI_API_KEY"), "provided", "user-pasted secret");
    assert.equal(states.get("RESEND_API_KEY"), "disabled", "operator-disabled key");
    assert.equal(states.get("AI_KEY_ENCRYPTION_KEY"), "missing-required", "absent auto-generated key");
    assert.equal(states.get("LOVABLE_API_KEY"), "missing-optional", "absent external key");
    assert.equal(states.get("SOME_RANDOM_FLAG"), "missing-optional", "absent unknown key");
  } finally {
    await gracefulShutdown(ctx);
  }
});

// ---- provisioning with functions ------------------------------------------------------

test("provision with functions: env file written, serve spawned with --env-file, statuses degrade on missing secrets", async () => {
  const ctx = await buildApp();
  const workdir = makeFunctionsWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  const spawnSeam = installFakeServeSpawn();
  const events: Array<Record<string, unknown>> = [];
  ctx.wsSubscribers.add({
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => events.push(JSON.parse(payload) as Record<string, unknown>)
  } as unknown as never);
  try {
    const serviceId = seedService(ctx, workdir);
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "schema-only" });
    assert.equal(resource.status, "ready");

    // Serve process spawned from the service workdir with the generated env file.
    assert.equal(spawnSeam.calls.length, 1);
    const call = spawnSeam.calls[0];
    assert.equal(call.cwd, workdir);
    assert.deepEqual(call.args.slice(0, 3), ["functions", "serve", "--env-file"]);
    const envFile = call.args[3];
    assert.equal(envFile, functionEnvFilePath(ctx, resource.id));
    const content = fs.readFileSync(envFile, "utf8");
    assert.ok(content.includes(ANON_KEY), "env file carries the generated anon key");
    assert.match(content, /AI_KEY_ENCRYPTION_KEY=/, "generated AI key included");
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

    // Process identity recorded in config_json.functions.
    const fnState = resourceConfig(resource).functions as Record<string, unknown>;
    assert.equal(fnState.enabled, true);
    assert.equal(fnState.pid, spawnSeam.handles[0].pid);
    assert.equal(fnState.env_file, envFile);
    assert.deepEqual(fnState.functions, ["ai-chat", "send-email"]);
    assert.ok(isFunctionsServing(resource.id));

    // WS provisioning stream includes the functions step.
    const steps = events.filter((e) => e.type === "resource_provisioning").map((e) => e.step);
    assert.ok(steps.includes("functions"), `steps: ${steps}`);

    // ai-chat misses OPENAI_API_KEY → degraded, pointing at the exact key.
    const statuses = functionStatuses(ctx, getResource(ctx, resource.id)!);
    const aiChat = statuses.find((s) => s.name === "ai-chat");
    assert.equal(aiChat?.status, "degraded");
    assert.deepEqual(aiChat?.missing_secrets, ["OPENAI_API_KEY"]);
    const sendEmail = statuses.find((s) => s.name === "send-email");
    assert.equal(sendEmail?.status, "degraded");
    assert.deepEqual(sendEmail?.missing_secrets, ["RESEND_API_KEY"]);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("provision: serve failure degrades functions but provisioning still succeeds", async () => {
  const ctx = await buildApp();
  const workdir = makeFunctionsWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  installFakeServeSpawn({ failOnSpawn: true });
  try {
    const serviceId = seedService(ctx, workdir);
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "schema-only" });
    assert.equal(resource.status, "ready", "serve failure must not fail provisioning");
    const fnState = resourceConfig(resource).functions as Record<string, unknown>;
    assert.equal(fnState.enabled, false);
    assert.match(String(fnState.error ?? ""), /ENOENT/);
    assert.equal(isFunctionsServing(resource.id), false);
    for (const status of functionStatuses(ctx, resource)) {
      assert.equal(status.status, "disabled", "not serving → functions report disabled");
    }
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("provision with serveFunctions=false skips function serving entirely", async () => {
  const ctx = await buildApp();
  const workdir = makeFunctionsWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  const spawnSeam = installFakeServeSpawn();
  try {
    const serviceId = seedService(ctx, workdir);
    const resource = await supabaseProfile.provision(ctx, {
      serviceId,
      mode: "schema-only",
      serveFunctions: false
    });
    assert.equal(resource.status, "ready");
    assert.equal(spawnSeam.calls.length, 0, "no serve process when the action is disabled");
    assert.equal(resourceConfig(resource).functions, undefined);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

// ---- routes -------------------------------------------------------------------------

test("routes: env-requirements + secrets update + function logs + stop/delete lifecycle", async () => {
  const ctx = await buildApp();
  const workdir = makeFunctionsWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  const spawnSeam = installFakeServeSpawn();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const serviceId = seedService(ctx, workdir);

    const provision = await ctx.app.inject({
      method: "POST",
      url: "/resources/provision",
      headers: auth,
      payload: { serviceId, profile: "supabase", mode: "schema-only", restart: false }
    });
    assert.equal(provision.statusCode, 200, provision.body);
    const resourceId = (provision.json() as { id: string }).id;
    assert.equal(spawnSeam.calls.length, 1);

    // env-requirements: per-function + aggregate states.
    const requirements = await ctx.app.inject({
      method: "GET",
      url: `/resources/${resourceId}/env-requirements`,
      headers: auth
    });
    assert.equal(requirements.statusCode, 200);
    const reqBody = requirements.json() as {
      resource_id: string;
      serving: boolean;
      functions: Array<{ name: string; status: string; missing_secrets: string[] }>;
      aggregate: Array<{ key: string; state: string; source_files: string[] }>;
    };
    assert.equal(reqBody.resource_id, resourceId);
    assert.equal(reqBody.serving, true);
    const aiChatBefore = reqBody.functions.find((f) => f.name === "ai-chat");
    assert.equal(aiChatBefore?.status, "degraded");
    assert.deepEqual(aiChatBefore?.missing_secrets, ["OPENAI_API_KEY"]);
    const aggregate = new Map(reqBody.aggregate.map((s) => [s.key, s]));
    assert.equal(aggregate.get("OPENAI_API_KEY")?.state, "missing-optional");
    assert.equal(aggregate.get("SUPABASE_URL")?.state, "generated");
    assert.equal(aggregate.get("SUPABASE_SERVICE_ROLE_KEY")?.state, "generated");
    assert.ok(
      aggregate.get("OPENAI_API_KEY")?.source_files.some((f) => f.includes("ai-chat")),
      "missing-secret diagnostics point at the referencing file"
    );

    // Provide OPENAI_API_KEY: state flips to provided, env file rewritten,
    // serve restarted via the spawn seam.
    const firstHandle = spawnSeam.handles[0];
    const provide = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/secrets`,
      headers: auth,
      payload: { secrets: { OPENAI_API_KEY: "sk-live-very-secret-value-12345" } }
    });
    assert.equal(provide.statusCode, 200, provide.body);
    const provideBody = provide.json() as {
      ok: boolean;
      secrets: Array<{ key: string; is_generated: boolean; value_preview: string }>;
      requirements: {
        functions: Array<{ name: string; status: string; missing_secrets: string[] }>;
        aggregate: Array<{ key: string; state: string }>;
      };
    };
    assert.ok(!provide.body.includes("sk-live-very-secret-value-12345"), "raw value never echoed");
    const preview = provideBody.secrets.find((s) => s.key === "OPENAI_API_KEY");
    assert.ok(preview && !preview.is_generated);
    assert.equal(
      provideBody.requirements.aggregate.find((s) => s.key === "OPENAI_API_KEY")?.state,
      "provided"
    );
    assert.equal(
      provideBody.requirements.functions.find((f) => f.name === "ai-chat")?.status,
      "serving",
      "all ai-chat secrets resolved → serving"
    );
    assert.equal(getResourceSecret(ctx, resourceId, "OPENAI_API_KEY"), "sk-live-very-secret-value-12345");
    const envFile = functionEnvFilePath(ctx, resourceId);
    assert.ok(
      fs.readFileSync(envFile, "utf8").includes("sk-live-very-secret-value-12345"),
      "env file rewritten with the new secret"
    );
    assert.equal(spawnSeam.calls.length, 2, "serve restarted to pick up the new env file");
    assert.equal(firstHandle.stopped, true, "previous serve process stopped");

    // Disable RESEND_API_KEY: send-email flips to disabled (clean), env file excludes it.
    const disable = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/secrets`,
      headers: auth,
      payload: { disable: ["RESEND_API_KEY"] }
    });
    assert.equal(disable.statusCode, 200);
    const disableBody = disable.json() as {
      requirements: {
        functions: Array<{ name: string; status: string; missing_secrets: string[] }>;
        aggregate: Array<{ key: string; state: string }>;
      };
    };
    assert.equal(
      disableBody.requirements.aggregate.find((s) => s.key === "RESEND_API_KEY")?.state,
      "disabled"
    );
    const sendEmail = disableBody.requirements.functions.find((f) => f.name === "send-email");
    assert.equal(sendEmail?.status, "disabled");
    assert.deepEqual(sendEmail?.missing_secrets, [], "disabled functions report clean");
    assert.ok(!fs.readFileSync(envFile, "utf8").includes("RESEND_API_KEY"));
    assert.deepEqual(resourceConfig(getResource(ctx, resourceId)!).disabled_secrets, ["RESEND_API_KEY"]);

    // Function serve output is captured and surfaced via the logs route.
    spawnSeam.handles[spawnSeam.handles.length - 1].emit("ai-chat booted on :54321\n");
    const fnLogs = await ctx.app.inject({
      method: "GET",
      url: `/resources/${resourceId}/logs?source=functions`,
      headers: auth
    });
    assert.equal(fnLogs.statusCode, 200);
    const fnLogsBody = (fnLogs.json() as { logs: string }).logs;
    assert.match(fnLogsBody, /=== functions ===/);
    assert.match(fnLogsBody, /ai-chat booted on :54321/);
    assert.match(fnLogsBody, /missing secret OPENAI_API_KEY/, "logs point at the exact missing secret");
    assert.ok(!fnLogsBody.includes("docker log line"), "source=functions excludes containers");

    const mergedLogs = await ctx.app.inject({
      method: "GET",
      url: `/resources/${resourceId}/logs`,
      headers: auth
    });
    const mergedBody = (mergedLogs.json() as { logs: string }).logs;
    assert.match(mergedBody, /=== supabase_db_app ===/);
    assert.match(mergedBody, /=== functions ===/);

    // Stop: stack action also stops the serve process.
    const liveHandle = spawnSeam.handles[spawnSeam.handles.length - 1];
    const stop = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/stop`,
      headers: auth
    });
    assert.equal(stop.statusCode, 200);
    assert.equal(liveHandle.stopped, true);
    assert.equal(isFunctionsServing(resourceId), false);
    const fnStateAfterStop = resourceConfig(getResource(ctx, resourceId)!).functions as Record<
      string,
      unknown
    >;
    assert.equal(fnStateAfterStop.enabled, false);
    const stoppedReq = await ctx.app.inject({
      method: "GET",
      url: `/resources/${resourceId}/env-requirements`,
      headers: auth
    });
    assert.equal((stoppedReq.json() as { serving: boolean }).serving, false);

    // Delete: serve process gone and the resource data dir cleaned up.
    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/resources/${resourceId}`,
      headers: auth
    });
    assert.equal(remove.statusCode, 200);
    assert.equal(
      fs.existsSync(path.join(ctx.config.dataRoot, "resources", resourceId)),
      false,
      "resource data dir (env file) removed with the resource"
    );
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("restart action resumes function serving when it was enabled", async () => {
  const ctx = await buildApp();
  const workdir = makeFunctionsWorkdir();
  installFakeCli();
  installFakeRestart();
  installFakeDocker(ctx);
  const spawnSeam = installFakeServeSpawn();
  try {
    const serviceId = seedService(ctx, workdir);
    const resource = await supabaseProfile.provision(ctx, { serviceId, mode: "empty", restart: false });
    assert.equal(spawnSeam.calls.length, 1);

    const token = await loginToken(ctx);
    const restart = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resource.id}/restart`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(restart.statusCode, 200);
    assert.equal(spawnSeam.handles[0].stopped, true, "old serve process stopped on restart");
    assert.equal(spawnSeam.calls.length, 2, "serve resumed after the stack restart");
    assert.ok(isFunctionsServing(resource.id));

    // Direct start after an explicit stop does NOT resume (operator turned it off).
    await ctx.app.inject({
      method: "POST",
      url: `/resources/${resource.id}/stop`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(isFunctionsServing(resource.id), false);
    await ctx.app.inject({
      method: "POST",
      url: `/resources/${resource.id}/start`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(spawnSeam.calls.length, 2, "explicit stop persists functions disabled");
    assert.equal(isFunctionsServing(resource.id), false);
  } finally {
    restoreSeams();
    fs.rmSync(workdir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("startFunctionsServe degrades cleanly when the workdir has no functions", async () => {
  const ctx = await buildApp();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-nofn-"));
  installFakeServeSpawn();
  try {
    const resource = createResource(ctx, {
      name: "no-functions",
      profile: "supabase",
      status: "ready",
      config: { workdir: emptyDir, api_url: "http://127.0.0.1:54321" }
    });
    const outcome = await startFunctionsServe(ctx, resource);
    assert.equal(outcome.started, false);
    assert.match(outcome.error ?? "", /No Edge Functions/);
    const fnState = resourceConfig(getResource(ctx, resource.id)!).functions as Record<string, unknown>;
    assert.equal(fnState.enabled, false);
  } finally {
    restoreSeams();
    fs.rmSync(emptyDir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});
