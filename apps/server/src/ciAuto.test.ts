import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import {
  deleteCiPipeline,
  ensureCiSchema,
  executeCiRun,
  handleBranchPush,
  handleIncomingCommit,
  enqueueCiRun,
  setCiAutostart,
  updateCiPipeline,
  type CiRunDeps
} from "./services/ci.js";
import {
  autoWebhookReadiness,
  repoHasCiConfig,
  setAutoCiEnabled,
  setAutoCiFetchForTests,
  syncAutoCiPipelines,
  syncAutoCiWebhooks
} from "./services/ciAuto.js";
import type { CiSandbox } from "./services/ciDocker.js";
import { flushCommitStatuses, setStatusFetchForTests } from "./services/ciStatus.js";
import { encryptSecret } from "./security.js";

let sqlite: { DatabaseSync: typeof import("better-sqlite3") } | null = null;
try {
  const mod = await import("better-sqlite3");
  new mod.default(":memory:").close();
  sqlite = { DatabaseSync: mod.default };
} catch {
  /* native module not built for this Node version */
}
const skip = sqlite ? false : "better-sqlite3 is not available on this Node version";
const KEY = "test-secret-key-32-bytes-not-for-prod";

let ctx: AppContext;
let dir = "";

beforeEach(() => {
  if (!sqlite) return;
  setCiAutostart(false);
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY, name TEXT, project_id TEXT, github_repo_url TEXT, github_branch TEXT
    );
    CREATE TABLE env_vars (id TEXT, service_id TEXT, key TEXT, value TEXT, is_secret INTEGER);
    CREATE TABLE project_env_vars (id TEXT, project_id TEXT, key TEXT, value TEXT, is_secret INTEGER);
    CREATE TABLE logs (id TEXT PRIMARY KEY, service_id TEXT, level TEXT, message TEXT, timestamp TEXT);
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, kind TEXT, severity TEXT, title TEXT, body TEXT,
      service_id TEXT, read INTEGER, created_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureCiSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-ciauto-"));
  ctx = {
    db,
    app: { log: { error() {}, warn() {}, info() {} } },
    config: {
      dataRoot: dir,
      secretKey: KEY,
      projectsDir: dir,
      webhookSecret: "",
      webhookInsecure: false,
      publicUrl: ""
    },
    wsSubscribers: new Set()
  } as unknown as AppContext;
});

afterEach(() => {
  setCiAutostart(false);
  setAutoCiFetchForTests(null);
  setStatusFetchForTests(null);
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seedServices(): void {
  const insert = ctx.db.prepare(
    "INSERT INTO services (id, name, project_id, github_repo_url, github_branch) VALUES (?, ?, 'proj', ?, 'main')"
  );
  insert.run("svc", "Awaire", "https://github.com/flyvende/awaire.git");
  insert.run("svc2", "Boared", "https://github.com/flyvende/boared");
  insert.run("local", "Local only", null);
}

function saveToken(): void {
  ctx.db
    .prepare("INSERT INTO settings (key, value) VALUES ('github_pat', ?)")
    .run(encryptSecret("ghp_token", KEY));
}

function pipelineOf(serviceId: string) {
  return ctx.db.prepare("SELECT * FROM ci_pipelines WHERE service_id = ?").get(serviceId) as
    | { id: string; auto_created: number; gate_deploy: number; config_source: string }
    | undefined;
}

function runCount(): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM ci_runs").get() as { n: number }).n;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function contentsFetch(found: boolean, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return found
      ? new Response(JSON.stringify({ type: "file" }), { status: 200 })
      : new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function passingSandbox(): CiSandbox {
  return {
    async run(input) {
      for (let index = 0; index < input.steps.length; index += 1) {
        input.onStep(index, "running", null);
        input.onStep(index, "passed", 0);
      }
      return { failedStep: null, cancelled: false, timedOut: false };
    }
  };
}

async function runQueued(id: string, deps: CiRunDeps): Promise<void> {
  ctx.db
    .prepare("UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  await executeCiRun(ctx, id, { sandbox: passingSandbox(), ...deps });
}

describe("CI for every repository: pipelines", { skip }, () => {
  test("off by default; on, every GitHub service gets a repo-config pipeline that never holds deploys", async () => {
    seedServices();
    assert.equal(await syncAutoCiPipelines(ctx), 0);
    setAutoCiEnabled(ctx, true);
    assert.equal(await syncAutoCiPipelines(ctx), 2);
    const pipe = pipelineOf("svc");
    assert.equal(pipe?.auto_created, 1);
    assert.equal(pipe?.gate_deploy, 0);
    assert.equal(pipe?.config_source, "repo");
    assert.equal(pipelineOf("local"), undefined);
    // Idempotent.
    assert.equal(await syncAutoCiPipelines(ctx), 0);
  });

  test("a deleted pipeline is not recreated, and an edited one becomes a normal pipeline", async () => {
    seedServices();
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    deleteCiPipeline(ctx, pipelineOf("svc")!.id);
    assert.equal(await syncAutoCiPipelines(ctx), 0);
    assert.equal(pipelineOf("svc"), undefined);

    updateCiPipeline(ctx, pipelineOf("svc2")!.id, { gateDeploy: true });
    assert.equal(pipelineOf("svc2")?.auto_created, 0);
    assert.equal(pipelineOf("svc2")?.gate_deploy, 1);
  });
});

describe("CI for every repository: triggers", { skip }, () => {
  test("a repo without ci.yml is not queued and not cloned", async () => {
    seedServices();
    saveToken();
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    const calls: string[] = [];
    setAutoCiFetchForTests(contentsFetch(false, calls));
    const plan = handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "a".repeat(40),
      trigger: "webhook"
    });
    assert.equal(plan, "deploy-and-ci");
    await settle();
    assert.equal(runCount(), 0);
    assert.match(calls[0], /repos\/flyvende\/awaire\/contents\/\.survhub\/ci\.yml\?ref=a{40}/);
  });

  test("a repo with ci.yml is queued, also for other branches", async () => {
    seedServices();
    saveToken();
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    ctx.db.prepare("UPDATE ci_pipelines SET trigger_branches = '*' WHERE service_id = 'svc'").run();
    setAutoCiFetchForTests(contentsFetch(true));
    handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "b".repeat(40),
      trigger: "gitops-poller"
    });
    const outcome = handleBranchPush(ctx, { serviceId: "svc", branch: "feature/x", commit: "c".repeat(40) });
    assert.equal(outcome.queued, false);
    await settle();
    assert.equal(runCount(), 2);
    const run = ctx.db
      .prepare("SELECT deploy_after FROM ci_runs WHERE commit_hash = ?")
      .get("b".repeat(40)) as {
      deploy_after: number;
    };
    assert.equal(run.deploy_after, 0);
  });

  test("without a token the check cannot tell, so the run is queued", async () => {
    seedServices();
    assert.equal(await repoHasCiConfig(ctx, "https://github.com/flyvende/awaire.git", "main"), null);
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "d".repeat(40),
      trigger: "webhook"
    });
    await settle();
    assert.equal(runCount(), 1);
  });
});

describe("CI for every repository: runs", { skip }, () => {
  test("a checkout without ci.yml ends as skipped and posts nothing to GitHub", async () => {
    seedServices();
    saveToken();
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    const states: string[] = [];
    setStatusFetchForTests(async (_url, init) => {
      states.push(JSON.parse(String(init?.body)).state);
      return new Response("{}", { status: 201 });
    });
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "e".repeat(40),
      branch: "main",
      trigger: "webhook",
      deployAfter: false,
      quietStatus: true
    });
    await runQueued(queued.id, { checkout: async () => undefined });
    await flushCommitStatuses();
    const run = ctx.db.prepare("SELECT status, error FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
      error: string;
    };
    assert.equal(run.status, "skipped");
    assert.match(run.error, /No \.survhub\/ci\.yml/);
    assert.deepEqual(states, []);
  });

  test("a checkout with ci.yml runs and reports to GitHub", async () => {
    seedServices();
    saveToken();
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    const states: string[] = [];
    setStatusFetchForTests(async (_url, init) => {
      states.push(JSON.parse(String(init?.body)).state);
      return new Response("{}", { status: 201 });
    });
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "f".repeat(40),
      branch: "main",
      trigger: "webhook",
      deployAfter: false,
      quietStatus: true
    });
    await runQueued(queued.id, {
      checkout: async (input) => {
        fs.mkdirSync(path.join(input.dir, ".survhub"), { recursive: true });
        fs.writeFileSync(
          path.join(input.dir, ".survhub", "ci.yml"),
          "steps:\n  - name: Test\n    run: npm test\n"
        );
      }
    });
    await flushCommitStatuses();
    const run = ctx.db.prepare("SELECT status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
    };
    assert.equal(run.status, "passed");
    assert.equal(states[0], "pending");
    assert.equal(states.at(-1), "success");
  });
});

describe("CI for every repository: webhooks", { skip }, () => {
  test("not ready without a token, a secret and a public URL", () => {
    setAutoCiEnabled(ctx, true);
    let state = autoWebhookReadiness(ctx);
    assert.equal(state.ready, false);
    saveToken();
    state = autoWebhookReadiness(ctx);
    assert.ok(!state.ready && /WEBHOOK_SECRET/.test(state.reason));
    (ctx.config as { webhookSecret: string }).webhookSecret = "s3cret";
    state = autoWebhookReadiness(ctx);
    assert.ok(!state.ready && /PUBLIC_URL/.test(state.reason));
    (ctx.config as { publicUrl: string }).publicUrl = "https://hoster.example.com";
    state = autoWebhookReadiness(ctx);
    assert.deepEqual(state, { ready: true, url: "https://hoster.example.com/webhooks/github" });
  });

  test("each repo gets one signed hook, and is not contacted again", async () => {
    seedServices();
    saveToken();
    (ctx.config as { webhookSecret: string }).webhookSecret = "s3cret";
    (ctx.config as { publicUrl: string }).publicUrl = "https://hoster.example.com";
    setAutoCiEnabled(ctx, true);
    await syncAutoCiPipelines(ctx);
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      if ((init?.method ?? "GET") === "GET") return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as typeof fetch;
    try {
      const first = await syncAutoCiWebhooks(ctx);
      assert.deepEqual(first.ensured.sort(), ["flyvende/awaire", "flyvende/boared"]);
      const created = calls.filter((call) => call.method === "POST");
      assert.equal(created.length, 2);
      const body = JSON.parse(created[0].body!);
      assert.deepEqual(body.events, ["push", "pull_request"]);
      assert.equal(body.config.secret, "s3cret");
      assert.equal(body.config.url, "https://hoster.example.com/webhooks/github");
      calls.length = 0;
      const second = await syncAutoCiWebhooks(ctx);
      assert.deepEqual(second.ensured, []);
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
