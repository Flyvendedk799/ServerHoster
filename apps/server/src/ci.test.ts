import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import {
  EXAMPLE_CI_YAML,
  buildCiEnv,
  parseCiConfig,
  planForPipeline,
  redactSecrets,
  stripGitCredentials
} from "./services/ciConfig.js";
import {
  enqueueCiRun,
  ensureCiSchema,
  executeCiRun,
  handleIncomingCommit,
  requestCancelCiRun,
  setCiAutostart,
  type CiRunDeps
} from "./services/ci.js";
import type { CiSandbox } from "./services/ciDocker.js";

// node:sqlite needs Node 22.5+. CI still runs Node 20, where the db tests skip
// instead of failing to load. The config tests below do not need it.
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  /* not available on this Node version */
}
const skip = sqlite ? false : "node:sqlite is not available on this Node version (needs 22.5+)";

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
    CREATE TABLE env_vars (
      id TEXT, service_id TEXT, key TEXT, value TEXT, is_secret INTEGER
    );
    CREATE TABLE project_env_vars (
      id TEXT, project_id TEXT, key TEXT, value TEXT, is_secret INTEGER
    );
    CREATE TABLE logs (
      id TEXT PRIMARY KEY, service_id TEXT, level TEXT, message TEXT, timestamp TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, kind TEXT, severity TEXT, title TEXT, body TEXT,
      service_id TEXT, read INTEGER, created_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureCiSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-ci-"));
  ctx = {
    db,
    app: { log: { error() {}, warn() {}, info() {} } },
    config: { dataRoot: dir, secretKey: "test-secret-key-32-bytes-not-for-prod", projectsDir: dir },
    wsSubscribers: new Set()
  } as unknown as AppContext;
});

afterEach(() => {
  setCiAutostart(false);
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seedService(): void {
  ctx.db
    .prepare(
      "INSERT INTO services (id, name, project_id, github_repo_url, github_branch) VALUES (?, ?, ?, ?, ?)"
    )
    .run("svc", "Awaire", "proj", "https://github.com/flyvende/awaire.git", "main");
}

function seedPipeline(opts: { gate?: boolean; source?: string; inline?: string | null } = {}): string {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO ci_pipelines
       (id, service_id, name, enabled, gate_deploy, config_source, inline_config, image, timeout_minutes, memory_mb, cpus, created_at, updated_at)
       VALUES ('pipe', 'svc', 'Awaire CI', 1, ?, ?, ?, 'node:22-bookworm', 20, 2048, 1, ?, ?)`
    )
    .run(
      opts.gate ? 1 : 0,
      opts.source ?? "inline",
      opts.inline === undefined ? INLINE : opts.inline,
      now,
      now
    );
  return "pipe";
}

const INLINE = `steps:
  - name: Test
    run: npm test
`;

function passingSandbox(): CiSandbox {
  return {
    async run(input) {
      input.onSetupLog("image ready\n");
      for (let index = 0; index < input.steps.length; index += 1) {
        input.onStep(index, "running", null);
        input.onLog(index, "ok\n");
        input.onStep(index, "passed", 0);
      }
      return { failedStep: null, cancelled: false, timedOut: false };
    }
  };
}

async function runQueued(id: string, deps: CiRunDeps = {}): Promise<void> {
  ctx.db
    .prepare("UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  await executeCiRun(ctx, id, {
    checkout: async () => undefined,
    sandbox: passingSandbox(),
    ...deps
  });
}

describe("CI config", () => {
  test("the example file parses and is not a GitHub Actions workflow", () => {
    const config = parseCiConfig(EXAMPLE_CI_YAML, {
      image: "node:22-bookworm",
      timeoutMinutes: 20,
      memoryMb: 2048,
      cpus: 1
    });
    assert.equal(config.steps.length, 3);
    assert.equal(config.image, "node:22-bookworm");
    assert.throws(() => parseCiConfig("on: push\njobs: {}\n", config), /GitHub Actions/);
  });

  test("secrets are opt-in and redacted", () => {
    const config = parseCiConfig(`secrets:\n  - NPM_TOKEN\nsteps:\n  - name: Install\n    run: npm ci\n`, {
      image: "node:22-bookworm",
      timeoutMinutes: 20,
      memoryMb: 2048,
      cpus: 1
    });
    const built = buildCiEnv(
      config,
      { NPM_TOKEN: "npm_secret_value", DATABASE_URL: "postgres://prod" },
      {
        commit: "abc",
        branch: "main",
        serviceName: "Awaire"
      }
    );
    assert.equal(built.env.NPM_TOKEN, "npm_secret_value");
    assert.equal(built.env.DATABASE_URL, undefined);
    assert.equal(built.env.CI, "true");
    const leaked = redactSecrets("clone https://x-access-token:npm_secret_value@github.com/a/b", [
      "npm_secret_value"
    ]);
    assert.equal(leaked.includes("npm_secret_value"), false);
    assert.equal(
      stripGitCredentials("https://x-access-token:abc@github.com/a/b.git"),
      "https://github.com/a/b.git"
    );
  });

  test("plan follows the dashboard gate, not the mere existence of CI", () => {
    assert.equal(planForPipeline(null), "deploy-only");
    assert.equal(planForPipeline({ enabled: 0, gate_deploy: 1 }), "deploy-only");
    assert.equal(planForPipeline({ enabled: 1, gate_deploy: 0 }), "deploy-and-ci");
    assert.equal(planForPipeline({ enabled: 1, gate_deploy: 1 }), "ci-then-deploy");
  });
});

describe("CI queue", { skip }, () => {
  test("a gated pipeline holds the deploy and a second event does not queue twice", () => {
    seedService();
    seedPipeline({ gate: true });
    const first = handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "a".repeat(40),
      trigger: "gitops-poller"
    });
    const second = handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "a".repeat(40),
      trigger: "webhook"
    });
    assert.equal(first, "ci-then-deploy");
    assert.equal(second, "ci-then-deploy");
    const rows = ctx.db.prepare("SELECT id, deploy_after, status FROM ci_runs").all() as Array<{
      id: string;
      deploy_after: number;
      status: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deploy_after, 1);
    assert.equal(rows[0].status, "queued");
  });

  test("without a gate the commit still deploys, and a newer commit supersedes the queued run", () => {
    seedService();
    seedPipeline();
    assert.equal(
      handleIncomingCommit(ctx, {
        serviceId: "svc",
        repoUrl: "https://github.com/flyvende/awaire.git",
        branch: "main",
        commit: "b".repeat(40),
        trigger: "webhook"
      }),
      "deploy-and-ci"
    );
    handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "c".repeat(40),
      trigger: "gitops-poller"
    });
    const rows = ctx.db
      .prepare("SELECT commit_hash, status FROM ci_runs ORDER BY created_at ASC")
      .all() as Array<{
      commit_hash: string;
      status: string;
    }>;
    assert.deepEqual(
      rows.map((row) => row.status),
      ["cancelled", "queued"]
    );
    assert.equal(rows[1].commit_hash, "c".repeat(40));
  });

  test("no pipeline leaves deploys alone", () => {
    seedService();
    assert.equal(
      handleIncomingCommit(ctx, {
        serviceId: "svc",
        repoUrl: "https://github.com/flyvende/awaire.git",
        branch: "main",
        commit: "d".repeat(40),
        trigger: "webhook"
      }),
      "deploy-only"
    );
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM ci_runs").get() as { n: number };
    assert.equal(count.n, 0);
  });
});

describe("CI runner", { skip }, () => {
  test("an inline pipeline passes without calling Docker or git", async () => {
    seedService();
    seedPipeline();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "e".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    let sandboxed = false;
    await runQueued(queued.id, {
      sandbox: {
        async run(input) {
          sandboxed = true;
          assert.equal(input.env.CI, "true");
          assert.equal(input.env.DATABASE_URL, undefined);
          assert.equal(input.steps[0].run, "npm test");
          input.onStep(0, "running", null);
          input.onLog(0, "1 passed\n");
          input.onStep(0, "passed", 0);
          return { failedStep: null, cancelled: false, timedOut: false };
        }
      }
    });
    assert.equal(sandboxed, true);
    const run = ctx.db.prepare("SELECT status, deploy_status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
      deploy_status: string | null;
    };
    assert.equal(run.status, "passed");
    assert.equal(run.deploy_status, null);
    const step = ctx.db.prepare("SELECT status, log FROM ci_run_steps WHERE run_id = ?").get(queued.id) as {
      status: string;
      log: string;
    };
    assert.equal(step.status, "passed");
    assert.match(step.log, /1 passed/);
  });

  test("a failed step does not deploy", async () => {
    seedService();
    seedPipeline({ gate: true });
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "f".repeat(40),
      branch: "main",
      trigger: "gitops-poller",
      deployAfter: true
    });
    let deployed = false;
    await runQueued(queued.id, {
      sandbox: {
        async run(input) {
          input.onStep(0, "running", null);
          input.onLog(0, "boom\n");
          input.onStep(0, "failed", 1);
          return { failedStep: 0, cancelled: false, timedOut: false };
        }
      },
      deploy: async () => {
        deployed = true;
      }
    });
    const run = ctx.db
      .prepare("SELECT status, failure_step, deploy_status FROM ci_runs WHERE id = ?")
      .get(queued.id) as {
      status: string;
      failure_step: string;
      deploy_status: string | null;
    };
    assert.equal(run.status, "failed");
    assert.equal(run.failure_step, "Test");
    assert.equal(run.deploy_status, null);
    assert.equal(deployed, false);
  });

  test("a green gated run deploys only when the branch still points at that commit", async () => {
    seedService();
    seedPipeline({ gate: true });
    const commit = "a".repeat(40);
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit,
      branch: "main",
      trigger: "gitops-poller",
      deployAfter: true
    });
    const deployed: string[] = [];
    await runQueued(queued.id, {
      remoteHead: async () => commit,
      deploy: async (input) => {
        deployed.push(input.serviceId);
      }
    });
    assert.deepEqual(deployed, ["svc"]);
    const run = ctx.db.prepare("SELECT status, deploy_status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
      deploy_status: string;
    };
    assert.equal(run.status, "passed");
    assert.equal(run.deploy_status, "success");
  });

  test("a green gated run waits when the branch has moved", async () => {
    seedService();
    seedPipeline({ gate: true });
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "1".repeat(40),
      branch: "main",
      trigger: "webhook",
      deployAfter: true
    });
    let deployed = false;
    await runQueued(queued.id, {
      remoteHead: async () => "2".repeat(40),
      deploy: async () => {
        deployed = true;
      }
    });
    assert.equal(deployed, false);
    const run = ctx.db.prepare("SELECT deploy_status FROM ci_runs WHERE id = ?").get(queued.id) as {
      deploy_status: string;
    };
    assert.equal(run.deploy_status, "skipped");
  });

  test("a missing repo file fails before the sandbox starts", async () => {
    seedService();
    seedPipeline({ source: "repo", inline: null });
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "9".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    let sandboxed = false;
    await runQueued(queued.id, {
      checkout: async () => undefined,
      sandbox: {
        async run() {
          sandboxed = true;
          return { failedStep: null, cancelled: false, timedOut: false };
        }
      }
    });
    assert.equal(sandboxed, false);
    const run = ctx.db.prepare("SELECT status, error FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
      error: string;
    };
    assert.equal(run.status, "failed");
    assert.match(run.error, /\.survhub\/ci\.yml/);
  });

  test("cancel before start does not enter the sandbox", async () => {
    seedService();
    seedPipeline();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: null,
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    requestCancelCiRun(ctx, queued.id);
    let sandboxed = false;
    await runQueued(queued.id, {
      sandbox: {
        async run() {
          sandboxed = true;
          return { failedStep: null, cancelled: false, timedOut: false };
        }
      }
    });
    assert.equal(sandboxed, false);
    const run = ctx.db.prepare("SELECT status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
    };
    assert.equal(run.status, "cancelled");
  });
});
