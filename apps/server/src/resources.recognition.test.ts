import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { encryptSecret } from "./security.js";
import { gracefulShutdown } from "./services/runtime.js";
import { createResource, linkResourceToService } from "./services/resources/lifecycle.js";
import {
  adoptDatabaseAsResource,
  recognizeService,
  runRecognitionScan,
  setRecognitionPreference
} from "./services/resources/recognition.js";
import { setResourceSecret } from "./services/resources/secrets.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function makeWorkdir(dependencies: Record<string, string>, opts: { supabase?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-recognition-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies }));
  if (opts.supabase) {
    fs.mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "supabase", "config.toml"), 'project_id = "recognition"\n');
    fs.writeFileSync(path.join(dir, "supabase", "migrations", "0001.sql"), "select 1;\n");
  }
  return dir;
}

function seedService(
  ctx: Ctx,
  opts: {
    projectId?: string;
    name?: string;
    type?: "process" | "docker" | "static";
    workingDir?: string;
    linkedDatabaseId?: string | null;
  } = {}
): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, ?, ?, ?, 'node index.js', ?, 4173, 'stopped', 0, 0, 5, ?, ?, ?)`
    )
    .run(
      id,
      opts.projectId ?? "proj-recognition",
      opts.name ?? `svc-${id.slice(0, 6)}`,
      opts.type ?? "process",
      opts.workingDir ?? "/tmp",
      nowIso(),
      nowIso(),
      opts.linkedDatabaseId ?? null
    );
  return id;
}

function seedDatabase(ctx: Ctx, engine: "postgres" | "mysql" | "redis" | "mongo" = "postgres"): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO databases
       (id, project_id, name, engine, port, container_id, connection_string,
        username, password, database_name, created_at)
       VALUES (?, 'proj-recognition', ?, ?, ?, ?, '', 'user', 'pass', 'appdb', ?)`
    )
    .run(id, `${engine}-db`, engine, engine === "redis" ? 63790 : 55432, `container-${id}`, nowIso());
  return id;
}

function setServiceEnv(
  ctx: Ctx,
  serviceId: string,
  key: string,
  value: string,
  isSecret = false
): void {
  ctx.db
    .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
    .run(nanoid(), serviceId, key, isSecret ? encryptSecret(value, ctx.config.secretKey) : value, isSecret ? 1 : 0);
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

test("recognition: Supabase app with hosted env is satisfied, not missing", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ "@supabase/supabase-js": "^2.0.0" }, { supabase: true });
  try {
    const serviceId = seedService(ctx, { workingDir: dir });
    setServiceEnv(ctx, serviceId, "VITE_SUPABASE_URL", "https://project.supabase.co");

    const recognition = await recognizeService(ctx, serviceId);
    assert.equal(recognition.detected.profile, "supabase");
    assert.equal(recognition.current_provider.kind, "hosted-env");
    assert.equal(recognition.state, "satisfied");
    assert.ok(!recognition.issues.some((issue) => issue.code === "missing-provider"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("recognition: local Supabase shadowed by service hosted env is a conflict", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ "@supabase/supabase-js": "^2.0.0" }, { supabase: true });
  try {
    const serviceId = seedService(ctx, { workingDir: dir });
    const resource = createResource(ctx, {
      projectId: "proj-recognition",
      name: "local-supabase",
      profile: "supabase",
      status: "running",
      config: { api_url: "http://127.0.0.1:54321", workdir: dir }
    });
    setResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY", "anon", true);
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });
    setServiceEnv(ctx, serviceId, "VITE_SUPABASE_URL", "https://project.supabase.co");

    const recognition = await recognizeService(ctx, serviceId);
    assert.equal(recognition.state, "conflict");
    assert.ok(recognition.issues.some((issue) => issue.code === "env-override"));
    assert.equal(recognition.current_provider.kind, "hosted-env");

    setRecognitionPreference(ctx, serviceId, { mode: "hosted" });
    const hosted = await recognizeService(ctx, serviceId);
    assert.equal(hosted.state, "satisfied");
    assert.ok(hosted.issues.some((issue) => issue.code === "hosted-selected"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("recognition: direct Redis need is satisfied by a linked managed Redis resource", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ ioredis: "^5.0.0" });
  try {
    const serviceId = seedService(ctx, { workingDir: dir });
    const resource = createResource(ctx, {
      projectId: "proj-recognition",
      name: "redis-cache",
      profile: "redis",
      status: "ready",
      config: { env: { REDIS_URL: "redis://localhost:63790" } }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });

    const recognition = await recognizeService(ctx, serviceId);
    assert.equal(recognition.detected.profile, "redis");
    assert.equal(recognition.current_provider.kind, "managed-resource");
    assert.equal(recognition.state, "satisfied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("recognition: detected database need with no provider is missing", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ mysql2: "^3.0.0" });
  try {
    const serviceId = seedService(ctx, { workingDir: dir });
    const recognition = await recognizeService(ctx, serviceId);
    assert.equal(recognition.detected.profile, "mysql");
    assert.equal(recognition.state, "missing");
    assert.ok(recognition.issues.some((issue) => issue.code === "missing-provider"));
    assert.ok(recognition.actions.some((action) => action.id === "provision" && action.profile === "mysql"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("recognition: linked legacy database is satisfied and can be adopted without recreation", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ pg: "^8.0.0" });
  try {
    const databaseId = seedDatabase(ctx, "postgres");
    const serviceId = seedService(ctx, { workingDir: dir, linkedDatabaseId: databaseId });
    const databaseCountBeforeAdopt = ctx.db
      .prepare("SELECT COUNT(*) AS count FROM databases")
      .get() as { count: number };

    const before = await recognizeService(ctx, serviceId);
    assert.equal(before.state, "satisfied");
    assert.equal(before.current_provider.kind, "legacy-database");
    assert.ok(before.actions.some((action) => action.id === "adopt-legacy" && action.database_id === databaseId));

    const resource = await adoptDatabaseAsResource(ctx, { databaseId, serviceId });
    assert.equal(resource.profile, "postgres");
    assert.equal(JSON.parse(resource.config_json).database_id, databaseId);
    const databaseCountAfterAdopt = ctx.db
      .prepare("SELECT COUNT(*) AS count FROM databases")
      .get() as { count: number };
    assert.equal(databaseCountAfterAdopt.count, databaseCountBeforeAdopt.count);

    const after = await recognizeService(ctx, serviceId);
    assert.ok(after.providers.some((provider) => provider.kind === "managed-resource"));
    assert.equal(after.current_provider.kind, "legacy-database", "legacy env precedence stays unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("recognition: embedded SQLite reports persistent versus ephemeral truth", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx, { type: "docker" });
    const base = {
      service_id: serviceId,
      service_name: "sqlite-app",
      project_id: "proj-recognition",
      container_id: "container",
      container_name: "container",
      engine: "sqlite" as const,
      file_path: "/app/app.db",
      size_bytes: 128,
      missing_env: ["DATABASE_URL"]
    };

    const ephemeral = await recognizeService(ctx, serviceId, {
      embeddedByService: new Map([[serviceId, { ...base, persistent: false }]])
    });
    assert.equal(ephemeral.state, "partial");
    assert.ok(ephemeral.issues.some((issue) => issue.code === "embedded-ephemeral"));

    const persistent = await recognizeService(ctx, serviceId, {
      embeddedByService: new Map([[serviceId, { ...base, persistent: true }]])
    });
    assert.equal(persistent.state, "partial");
    assert.ok(persistent.issues.some((issue) => issue.code === "embedded-sqlite"));
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("recognition routes: auth, rescan, preference, and adoption", async () => {
  const ctx = await buildApp();
  const dir = makeWorkdir({ mongodb: "^6.0.0" });
  try {
    const serviceId = seedService(ctx, { workingDir: dir });
    const databaseId = seedDatabase(ctx, "mongo");
    const unauthorized = await ctx.app.inject({ method: "GET", url: "/resources/recognition" });
    assert.equal(unauthorized.statusCode, 401);

    const token = await loginToken(ctx);
    const headers = { authorization: `Bearer ${token}` };

    const run = await ctx.app.inject({
      method: "POST",
      url: `/resources/recognition/${serviceId}/run`,
      headers
    });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().detected.profile, "mongo");

    const pref = await ctx.app.inject({
      method: "POST",
      url: `/resources/recognition/${serviceId}/preference`,
      headers,
      payload: { mode: "manual", note: "operator chose manual DB" }
    });
    assert.equal(pref.statusCode, 200);
    assert.equal(pref.json().preference.mode, "manual");

    const adopt = await ctx.app.inject({
      method: "POST",
      url: "/resources/adopt-database",
      headers,
      payload: { databaseId, serviceId }
    });
    assert.equal(adopt.statusCode, 200);
    const body = adopt.json();
    assert.equal(body.ok, true);
    assert.equal(body.resource.profile, "mongo");
    assert.equal(body.recognition.service_id, serviceId);
    assert.ok(!adopt.body.includes("pass"), "raw database password should not be returned by adoption response");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});
