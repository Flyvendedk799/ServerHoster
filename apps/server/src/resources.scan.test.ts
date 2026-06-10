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
import { getProfile } from "./services/resources/profiles.js";
import { scoreSupabaseSignals } from "./services/resources/profiles/supabase.js";
import { getLatestScan, listLatestScans, runDependencyScan } from "./services/resources/scan.js";
import { classifyFunctionSecret, scanFunctionSecrets } from "./services/resources/secretsScan.js";
import { createResource, linkResourceToService } from "./services/resources/lifecycle.js";
import { setResourceSecret } from "./services/resources/secrets.js";

/**
 * Database-Tracker Phase 2 — Supabase detection + planning, function-secret
 * scanning, scan persistence, and the first /resources API slice.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

/** LearnAI-like Supabase fixture (tests run from dist/, fixture stays in src/). */
const LEARNAI_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/services/resources/__fixtures__/learnai-like"
);

function seedService(ctx: Ctx, opts: { projectId?: string; workingDir?: string } = {}): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, port, status,
        auto_restart, restart_count, max_restarts, created_at, updated_at, linked_database_id)
       VALUES (?, ?, ?, 'process', 'npm run dev', ?, 0, 'stopped', 0, 0, 5, ?, ?, NULL)`
    )
    .run(
      id,
      opts.projectId ?? "proj-scan",
      `svc-${id.slice(0, 6)}`,
      opts.workingDir ?? "/tmp",
      nowIso(),
      nowIso()
    );
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

test("supabase detection: LearnAI fixture yields all spec'd signal kinds", () => {
  const supabase = getProfile("supabase");
  assert.ok(supabase, "supabase profile must be registered");
  const signals = supabase.detect(LEARNAI_FIXTURE_DIR);

  const byKind = (kind: string) => signals.filter((s) => s.kind === kind);

  // package dependency.
  const pkg = byKind("package");
  assert.equal(pkg.length, 1);
  assert.equal(pkg[0].value, "@supabase/supabase-js");
  assert.equal(pkg[0].source_file, "package.json");
  assert.equal(pkg[0].confidence, "high");

  // supabase/config.toml.
  const file = byKind("file");
  assert.equal(file.length, 1);
  assert.equal(file[0].source_file, path.join("supabase", "config.toml"));

  // supabase/migrations/*.sql.
  const migrations = byKind("migration");
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].value, "0001_init.sql");

  // supabase/functions/*/index.ts.
  const functions = byKind("function");
  assert.equal(functions.length, 1);
  assert.equal(functions[0].value, "ai-chat");

  // source code using the Supabase client.
  const codeValues = byKind("code").map((s) => s.value);
  assert.ok(codeValues.includes("createClient(@supabase/supabase-js)"), `code signals: ${codeValues}`);

  // env keys from .env.example and function/client code.
  const envValues = byKind("env").map((s) => s.value);
  for (const key of [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ]) {
    assert.ok(envValues.includes(key), `env signals must include ${key} (got: ${envValues})`);
  }

  // Full fixture scores high.
  assert.equal(scoreSupabaseSignals(signals), "high");
});

test("supabase scoring tiers: package+env => medium, env-only => low, nothing => null", () => {
  const supabase = getProfile("supabase")!;

  // package + env usage only (no config.toml, no migrations) → medium.
  const mediumDir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-supa-medium-"));
  try {
    fs.writeFileSync(
      path.join(mediumDir, "package.json"),
      JSON.stringify({ name: "m", dependencies: { "@supabase/supabase-js": "^2.0.0" } })
    );
    fs.writeFileSync(path.join(mediumDir, ".env"), "SUPABASE_URL=http://localhost:54321\n");
    const signals = supabase.detect(mediumDir);
    assert.ok(signals.some((s) => s.kind === "package"));
    assert.ok(signals.some((s) => s.kind === "env"));
    assert.equal(scoreSupabaseSignals(signals), "medium");
  } finally {
    fs.rmSync(mediumDir, { recursive: true, force: true });
  }

  // env usage only → low.
  const lowDir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-supa-low-"));
  try {
    fs.writeFileSync(path.join(lowDir, ".env"), "VITE_SUPABASE_URL=http://localhost:54321\n");
    const signals = supabase.detect(lowDir);
    assert.ok(signals.length > 0);
    assert.ok(signals.every((s) => s.kind === "env"));
    assert.equal(scoreSupabaseSignals(signals), "low");
  } finally {
    fs.rmSync(lowDir, { recursive: true, force: true });
  }

  // no signals → no recommendation.
  assert.equal(scoreSupabaseSignals([]), null);
});

test("function secrets: Deno.env.get scan on fixture classifies keys per spec", () => {
  const secrets = scanFunctionSecrets(LEARNAI_FIXTURE_DIR);
  const byKey = new Map(secrets.map((s) => [s.key, s]));

  const openai = byKey.get("OPENAI_API_KEY");
  assert.ok(openai, "OPENAI_API_KEY must be detected");
  assert.equal(openai.classification, "optional-external");
  assert.deepEqual(openai.source_files, [path.join("supabase", "functions", "ai-chat", "index.ts")]);

  assert.equal(byKey.get("SUPABASE_URL")?.classification, "auto-generated");
  assert.equal(byKey.get("SUPABASE_SERVICE_ROLE_KEY")?.classification, "auto-generated");

  // Classifier unit checks (spec "Local Function Secrets").
  assert.equal(classifyFunctionSecret("AI_KEY_ENCRYPTION_KEY"), "auto-generated");
  assert.equal(classifyFunctionSecret("APP_URL"), "auto-generated");
  assert.equal(classifyFunctionSecret("LOVABLE_API_KEY"), "optional-external");
  assert.equal(classifyFunctionSecret("RESEND_API_KEY"), "optional-external");
  assert.equal(classifyFunctionSecret("STRIPE_WEBHOOK_SIGNING_KEY"), "optional-external");
  assert.equal(classifyFunctionSecret("SOME_VENDOR_API_KEY"), "optional-external");
  assert.equal(classifyFunctionSecret("WEBHOOK_SECRET"), "optional-external");
  assert.equal(classifyFunctionSecret("GITLAB_TOKEN"), "optional-external");
  assert.equal(classifyFunctionSecret("DATABASE_URL"), "infrastructure");
  assert.equal(classifyFunctionSecret("SUPABASE_DB_URL"), "infrastructure");
  assert.equal(classifyFunctionSecret("FEATURE_FLAG"), "unknown");
});

test("dependency scan: LearnAI fixture recommends supabase (not postgres) and persists", async () => {
  const ctx = await buildApp();
  try {
    const serviceId = seedService(ctx, { workingDir: LEARNAI_FIXTURE_DIR });

    const result = await runDependencyScan(ctx, serviceId);
    assert.equal(result.scan.service_id, serviceId);
    assert.equal(result.scan.profile, "supabase", "Supabase app must NOT be labeled postgres");
    assert.equal(result.scan.confidence, "high");
    assert.ok(result.scan.signals.length > 0);
    assert.ok(result.recommended);
    assert.equal(result.recommended.profile, "supabase");
    assert.ok(!result.plans.some((p) => p.profile === "postgres"), "fixture has no postgres driver");

    // Persisted env requirements carry the classified function secrets.
    const openai = result.scan.env_requirements.find((r) => r.key === "OPENAI_API_KEY");
    assert.equal(openai?.classification, "optional-external");

    // Plan shape: actions + env classification.
    const plan = result.recommended;
    const actionIds = plan.actions.map((a) => a.id);
    assert.deepEqual(actionIds, [
      "start-stack",
      "apply-migrations",
      "run-seed",
      "serve-functions",
      "bootstrap-user"
    ]);
    const byId = new Map(plan.actions.map((a) => [a.id, a]));
    assert.equal(byId.get("run-seed")?.risk, "destructive");
    assert.equal(byId.get("run-seed")?.default_enabled, false);
    assert.equal(byId.get("serve-functions")?.default_enabled, true, "fixture has functions");
    assert.equal(byId.get("bootstrap-user")?.default_enabled, false);
    for (const key of [
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "APP_URL"
    ]) {
      assert.ok(plan.env.generated.includes(key), `generated env must include ${key}`);
    }
    assert.ok(plan.env.optional_user_input.includes("OPENAI_API_KEY"));

    // Snapshot row was written and reads back identically.
    const row = ctx.db.prepare("SELECT * FROM dependency_scans WHERE service_id = ?").get(serviceId) as
      | { id: string; profile: string; confidence: string }
      | undefined;
    assert.ok(row, "dependency_scans row must be persisted");
    assert.equal(row.id, result.scan.id);
    assert.equal(row.profile, "supabase");

    const latest = getLatestScan(ctx, serviceId);
    assert.deepEqual(latest, result.scan);

    // Re-running keeps one latest entry per service in listLatestScans.
    const second = await runDependencyScan(ctx, serviceId);
    const latestScans = listLatestScans(ctx).filter((s) => s.service_id === serviceId);
    assert.equal(latestScans.length, 1);
    assert.equal(latestScans[0].id, second.scan.id);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("dependency scan: supabase outranks postgres when both signals are present", async () => {
  const ctx = await buildApp();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-supa-vs-pg-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "both",
          dependencies: { "@supabase/supabase-js": "^2.0.0", pg: "^8.0.0", prisma: "^5.0.0" }
        })
      );
      fs.mkdirSync(path.join(dir, "supabase"), { recursive: true });
      fs.writeFileSync(path.join(dir, "supabase", "config.toml"), 'project_id = "both"\n');

      const serviceId = seedService(ctx, { workingDir: dir });
      const result = await runDependencyScan(ctx, serviceId);

      const profiles = result.plans.map((p) => p.profile).sort();
      assert.ok(profiles.includes("postgres"), "postgres candidate must be detected");
      assert.ok(profiles.includes("supabase"), "supabase candidate must be detected");
      assert.equal(result.scan.profile, "supabase", "supabase must outrank plain postgres");
      assert.equal(result.scan.confidence, "high");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("dependency scan: driver-free service falls back to manual/low; unknown service throws", async () => {
  const ctx = await buildApp();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-scan-empty-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "plain", dependencies: {} }));
      const serviceId = seedService(ctx, { workingDir: dir });
      const result = await runDependencyScan(ctx, serviceId);
      assert.equal(result.scan.profile, "manual");
      assert.equal(result.scan.confidence, "low");
      assert.equal(result.recommended, null);
      assert.deepEqual(result.plans, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await assert.rejects(() => runDependencyScan(ctx, "no-such-service"), /Service not found/);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("redis profile: detects redis drivers and plans REDIS_URL injection", async () => {
  const ctx = await buildApp();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-redis-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "queue", dependencies: { ioredis: "^5.0.0" } })
      );
      const serviceId = seedService(ctx, { workingDir: dir });
      const result = await runDependencyScan(ctx, serviceId);
      assert.equal(result.scan.profile, "redis");
      assert.equal(result.recommended?.env.generated[0], "REDIS_URL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("mysql/mongo detection: drivers recommend the right profile; supabase still outranks", async () => {
  const ctx = await buildApp();
  const dirs: string[] = [];
  const scanFor = async (dependencies: Record<string, string>, withSupabaseConfig = false) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-dbscan-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies }));
    if (withSupabaseConfig) {
      fs.mkdirSync(path.join(dir, "supabase"), { recursive: true });
      fs.writeFileSync(path.join(dir, "supabase", "config.toml"), 'project_id = "app"\n');
    }
    return runDependencyScan(ctx, seedService(ctx, { workingDir: dir }));
  };
  try {
    // mysql2 driver → mysql profile with DATABASE_URL injection.
    const mysql = await scanFor({ mysql2: "^3.0.0" });
    assert.equal(mysql.scan.profile, "mysql");
    assert.equal(mysql.scan.confidence, "high");
    assert.deepEqual(mysql.recommended?.env.generated, ["DATABASE_URL"]);

    // mongodb and mongoose drivers → mongo profile.
    const mongodb = await scanFor({ mongodb: "^6.0.0" });
    assert.equal(mongodb.scan.profile, "mongo");
    const mongoose = await scanFor({ mongoose: "^8.0.0" });
    assert.equal(mongoose.scan.profile, "mongo");
    assert.deepEqual(mongoose.recommended?.env.generated, ["DATABASE_URL"]);

    // Supabase dominance is untouched: a Supabase app that also carries
    // mysql/mongo drivers must never be labeled as a plain database.
    const mixed = await scanFor(
      { "@supabase/supabase-js": "^2.0.0", mysql2: "^3.0.0", mongodb: "^6.0.0" },
      true
    );
    assert.equal(mixed.scan.profile, "supabase");
    const candidates = mixed.plans.map((plan) => plan.profile).sort();
    assert.ok(candidates.includes("mysql") && candidates.includes("mongo"), `plans: ${candidates}`);
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("routes: /resources API slice (profiles, scans, resources) with auth + redaction", async () => {
  const ctx = await buildApp();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };

    // Auth is enforced on the /resources prefix.
    const unauthorized = await ctx.app.inject({ method: "GET", url: "/resources/profiles" });
    assert.equal(unauthorized.statusCode, 401);

    // Profile listing exposes id + label only.
    const profiles = await ctx.app.inject({ method: "GET", url: "/resources/profiles", headers: auth });
    assert.equal(profiles.statusCode, 200);
    const profileList = profiles.json() as Array<{ id: string; label: string }>;
    const ids = profileList.map((p) => p.id).sort();
    assert.deepEqual(ids, ["manual", "mongo", "mysql", "postgres", "redis", "supabase"]);
    assert.equal(profileList.find((p) => p.id === "supabase")?.label, "Local Supabase");
    for (const profile of profileList) {
      assert.deepEqual(Object.keys(profile).sort(), ["id", "label"]);
    }

    // Run a scan over HTTP and read it back through both scan routes.
    const serviceId = seedService(ctx, { workingDir: LEARNAI_FIXTURE_DIR });
    const run = await ctx.app.inject({
      method: "POST",
      url: `/resources/scans/${serviceId}/run`,
      headers: auth
    });
    assert.equal(run.statusCode, 200);
    const runBody = run.json() as {
      scan: { profile: string; confidence: string };
      plans: Array<{ profile: string }>;
      recommended: { profile: string } | null;
    };
    assert.equal(runBody.scan.profile, "supabase");
    assert.equal(runBody.scan.confidence, "high");
    assert.equal(runBody.recommended?.profile, "supabase");

    const single = await ctx.app.inject({
      method: "GET",
      url: `/resources/scans/${serviceId}`,
      headers: auth
    });
    assert.equal(single.statusCode, 200);
    assert.equal(single.json().profile, "supabase");

    const all = await ctx.app.inject({ method: "GET", url: "/resources/scans", headers: auth });
    assert.equal(all.statusCode, 200);
    assert.ok(
      (all.json() as Array<{ service_id: string }>).some((s) => s.service_id === serviceId),
      "latest-scans listing must include the scanned service"
    );

    const missingScan = await ctx.app.inject({
      method: "GET",
      url: `/resources/scans/${seedService(ctx)}`,
      headers: auth
    });
    assert.equal(missingScan.statusCode, 500);
    assert.match(missingScan.json().error as string, /No dependency scan/);

    // Resource views: secrets are preview-only and config env values are masked.
    const resource = createResource(ctx, {
      projectId: "proj-scan",
      name: "supabase-stack",
      profile: "supabase",
      status: "running",
      config: { env: { SUPABASE_SERVICE_ROLE_KEY: "super-secret-value-1234" } }
    });
    linkResourceToService(ctx, { serviceId, resourceId: resource.id });
    setResourceSecret(ctx, resource.id, "SUPABASE_ANON_KEY", "anon-key-plaintext", true);

    const list = await ctx.app.inject({ method: "GET", url: "/resources", headers: auth });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes("super-secret-value-1234"), "raw config secrets must never be returned");
    assert.ok(!list.body.includes("anon-key-plaintext"), "raw resource secrets must never be returned");

    const detail = await ctx.app.inject({ method: "GET", url: `/resources/${resource.id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    const body = detail.json() as {
      id: string;
      profile: string;
      config: { env: Record<string, string> };
      secrets: Array<{ key: string; is_generated: boolean; value_preview: string }>;
      links: Array<{ service_id: string; active: boolean }>;
    };
    assert.equal(body.id, resource.id);
    assert.equal(body.profile, "supabase");
    assert.notEqual(body.config.env.SUPABASE_SERVICE_ROLE_KEY, "super-secret-value-1234");
    assert.equal(body.secrets.length, 1);
    assert.equal(body.secrets[0].key, "SUPABASE_ANON_KEY");
    assert.ok(!("value" in body.secrets[0]), "secret previews must not carry full values");
    assert.equal(body.links[0]?.service_id, serviceId);
    assert.equal(body.links[0]?.active, true);

    const missingResource = await ctx.app.inject({
      method: "GET",
      url: "/resources/does-not-exist",
      headers: auth
    });
    assert.equal(missingResource.statusCode, 500);
    assert.match(missingResource.json().error as string, /Resource not found/);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("supabase profile: provision validates the service; remove tolerates missing rows", async () => {
  const ctx = await buildApp();
  try {
    const supabase = getProfile("supabase")!;
    // Phase 3 wired the real flows: provisioning an unknown service fails fast
    // (before any Docker/CLI work), and removing a nonexistent resource is a
    // no-op instead of an error. Full provisioning behavior is covered by
    // resources.provision.test.ts with the injectable CLI runner.
    await assert.rejects(
      () => supabase.provision(ctx, { serviceId: "no-such-service" }),
      /Service not found/
    );
    await supabase.remove(ctx, "no-such-resource");
  } finally {
    await gracefulShutdown(ctx);
  }
});
