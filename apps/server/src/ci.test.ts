import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import {
  EXAMPLE_CI_YAML,
  buildCiEnv,
  createLogRedactor,
  parseCiConfig,
  planForPipeline,
  redactSecrets,
  stripGitCredentials
} from "./services/ciConfig.js";
import {
  checkoutCiWorkspace,
  enqueueCiRun,
  ensureCiSchema,
  executeCiRun,
  handleIncomingCommit,
  requestCancelCiRun,
  setCiAutostart,
  startCiLoop,
  type CiRunDeps
} from "./services/ci.js";
import { ciContainerUser, dockerCiSandbox, type CiSandbox } from "./services/ciDocker.js";
import type Docker from "dockerode";

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
    assert.equal(redactSecrets("short ab stays out", ["ab"]), "short *** stays out");
    const redactor = createLogRedactor(["s3cret", "ab"]);
    const combined = redactor.push("token=s3") + redactor.push("cret ab") + redactor.flush();
    assert.equal(combined.includes("s3cret"), false);
    assert.equal(combined.includes("ab"), false);
    assert.match(combined, /token=\*\*\*/);
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

  test("the job user can write a checkout owned by a non-root host user", () => {
    assert.equal(ciContainerUser("linux", 1000, 1000), "1000:1000");
    assert.equal(ciContainerUser("linux", 0, 0), undefined);
    assert.equal(ciContainerUser("win32", 1000, 1000), undefined);
    assert.equal(ciContainerUser("linux", null, null), undefined);
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
        deployed.push(input.commit ?? "");
        return { status: "success" };
      }
    });
    assert.deepEqual(deployed, [commit]);
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

  test("a deploy request that arrives while the job is running is honored", async () => {
    seedService();
    seedPipeline({ gate: true });
    const commit = "b".repeat(40);
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit,
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    let seen: string | null = null;
    await runQueued(queued.id, {
      remoteHead: async () => commit,
      sandbox: {
        async run() {
          ctx.db.prepare("UPDATE ci_runs SET deploy_after = 1 WHERE id = ?").run(queued.id);
          return { failedStep: null, cancelled: false, timedOut: false };
        }
      },
      deploy: async (input) => {
        seen = input.commit;
        return { status: "success" };
      }
    });
    assert.equal(seen, commit);
    const run = ctx.db.prepare("SELECT status, deploy_status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
      deploy_status: string;
    };
    assert.equal(run.status, "passed");
    assert.equal(run.deploy_status, "success");
  });

  test("a failed deploy is not recorded as a success", async () => {
    seedService();
    seedPipeline({ gate: true });
    const commit = "c".repeat(40);
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit,
      branch: "main",
      trigger: "webhook",
      deployAfter: true
    });
    await runQueued(queued.id, {
      remoteHead: async () => commit,
      deploy: async () => ({ status: "failed" })
    });
    const run = ctx.db
      .prepare("SELECT status, deploy_status, error FROM ci_runs WHERE id = ?")
      .get(queued.id) as {
      status: string;
      deploy_status: string;
      error: string;
    };
    assert.equal(run.status, "passed");
    assert.equal(run.deploy_status, "failed");
    assert.match(run.error, /Deploy failed/);
  });

  test("shutdown does not start a queued job", async () => {
    seedService();
    seedPipeline();
    const stop = startCiLoop(ctx);
    await stop();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "d".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    const run = ctx.db.prepare("SELECT status FROM ci_runs WHERE id = ?").get(queued.id) as {
      status: string;
    };
    assert.equal(run.status, "queued");
  });
});

function runRow(id: string) {
  return ctx.db
    .prepare("SELECT status, error, commit_hash, deploy_status FROM ci_runs WHERE id = ?")
    .get(id) as {
    status: string;
    error: string | null;
    commit_hash: string | null;
    deploy_status: string | null;
  };
}

/** Resolve with how long `work` took, failing if it outlives `limitMs`. */
async function within<T>(limitMs: number, work: Promise<T>): Promise<number> {
  const begin = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still running after ${limitMs}ms`)), limitMs);
    })
  ]).finally(() => clearTimeout(timer));
  return Date.now() - begin;
}

describe("CI stop and timeout", { skip }, () => {
  test("cancel stops a checkout that never returns, and removes the workspace", async () => {
    seedService();
    seedPipeline();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "a".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    let workspace = "";
    let sawSignal = false;
    const running = runQueued(queued.id, {
      checkout: (input) => {
        workspace = input.dir;
        fs.mkdirSync(input.dir, { recursive: true });
        fs.writeFileSync(path.join(input.dir, "partial"), "x");
        input.signal?.addEventListener("abort", () => {
          sawSignal = true;
        });
        return new Promise<void>(() => undefined); // a stalled git server
      }
    });
    setTimeout(() => requestCancelCiRun(ctx, queued.id), 100);
    await within(3000, running);
    assert.equal(sawSignal, true);
    assert.equal(runRow(queued.id).status, "cancelled");
    assert.equal(fs.existsSync(workspace), false);
  });

  test("the run deadline covers checkout, so a stalled clone times out", async () => {
    seedService();
    seedPipeline();
    // 0.005 minutes = 300 ms. The column has INTEGER affinity but keeps a REAL.
    ctx.db.prepare("UPDATE ci_pipelines SET timeout_minutes = 0.005 WHERE id = 'pipe'").run();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "b".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    let sandboxed = false;
    await within(
      3000,
      runQueued(queued.id, {
        checkout: () => new Promise<void>(() => undefined),
        sandbox: {
          async run() {
            sandboxed = true;
            return { failedStep: null, cancelled: false, timedOut: false };
          }
        }
      })
    );
    assert.equal(sandboxed, false);
    const run = runRow(queued.id);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /Timed out/);
  });

  test("cancel frees the run even when the sandbox ignores the signal", async () => {
    seedService();
    seedPipeline();
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: "c".repeat(40),
      branch: "main",
      trigger: "manual",
      deployAfter: false
    });
    const running = runQueued(queued.id, {
      sandbox: { run: () => new Promise(() => undefined) }
    });
    setTimeout(() => requestCancelCiRun(ctx, queued.id), 100);
    await within(3000, running);
    assert.equal(runRow(queued.id).status, "cancelled");
  });
});

describe("CI commit handling", { skip }, () => {
  test("a commit that could be read as a git option is refused", () => {
    seedService();
    seedPipeline();
    assert.throws(
      () =>
        enqueueCiRun(ctx, {
          serviceId: "svc",
          commit: "--upload-pack=touch /tmp/pwned",
          branch: "main",
          trigger: "manual",
          deployAfter: false
        }),
      /Not a commit id/
    );
  });

  test("with the gate off a bad commit still deploys and still queues a run", () => {
    seedService();
    seedPipeline();
    const plan = handleIncomingCommit(ctx, {
      serviceId: "svc",
      repoUrl: "https://github.com/flyvende/awaire.git",
      branch: "main",
      commit: "--upload-pack=x",
      trigger: "webhook"
    });
    assert.equal(plan, "deploy-and-ci");
    const rows = ctx.db.prepare("SELECT commit_hash, status FROM ci_runs").all() as Array<{
      commit_hash: string | null;
      status: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].commit_hash, null);
    assert.equal(rows[0].status, "queued");
  });

  test("a run queued without a commit deploys the commit it actually tested", async () => {
    seedService();
    seedPipeline({ gate: true });
    const tested = "d".repeat(40);
    const queued = enqueueCiRun(ctx, {
      serviceId: "svc",
      commit: null,
      branch: "main",
      trigger: "webhook",
      deployAfter: true
    });
    const deployed: Array<string | null> = [];
    await runQueued(queued.id, {
      checkout: async () => tested,
      remoteHead: async () => "e".repeat(40),
      deploy: async (input) => {
        deployed.push(input.commit);
        return { status: "success" };
      }
    });
    // The branch moved past the tested commit, so nothing ships.
    assert.deepEqual(deployed, []);
    const run = runRow(queued.id);
    assert.equal(run.commit_hash, tested);
    assert.equal(run.deploy_status, "skipped");
  });

  test(
    "a repo ci.yml that links outside the checkout is not read",
    { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false },
    async () => {
      seedService();
      seedPipeline({ source: "repo", inline: null });
      const secret = path.join(dir, "host-secret.txt");
      fs.writeFileSync(secret, "HOST_SECRET_VALUE: [");
      const queued = enqueueCiRun(ctx, {
        serviceId: "svc",
        commit: "f".repeat(40),
        branch: "main",
        trigger: "manual",
        deployAfter: false
      });
      await runQueued(queued.id, {
        checkout: async (input) => {
          fs.mkdirSync(path.join(input.dir, ".survhub"), { recursive: true });
          fs.symlinkSync(secret, path.join(input.dir, ".survhub", "ci.yml"));
        }
      });
      const run = runRow(queued.id);
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /regular file/);
      assert.equal((run.error ?? "").includes("HOST_SECRET_VALUE"), false);
    }
  );
});

describe("CI setup stops", () => {
  test("git is killed when the run stops during a stalled clone", async () => {
    // A server that accepts the connection and never answers: git waits forever.
    const sockets = new Set<net.Socket>();
    const closed = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => closed.add(socket));
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-ci-git-"));
    const abort = new AbortController();
    try {
      const checkout = checkoutCiWorkspace({
        dir: path.join(work, "run"),
        repoUrl: `http://127.0.0.1:${port}/stalled.git`,
        branch: "main",
        commit: null,
        gitEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        redactions: [],
        signal: abort.signal
      });
      const outcome = checkout.then(
        () => "resolved",
        (error: Error) => error.name
      );
      // Wait until git has actually connected before stopping it.
      const connectedBy = Date.now() + 10_000;
      while (sockets.size === 0 && Date.now() < connectedBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(sockets.size > 0, "git never connected");
      abort.abort();
      await within(3000, outcome);
      assert.equal(await outcome, "CiAbortError");
      // The killed process group drops its connection.
      const closedBy = Date.now() + 3000;
      while (closed.size < sockets.size && Date.now() < closedBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(closed.size, sockets.size, "git still holds its connection");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test("an image pull that never answers is stopped by the run signal", async () => {
    const abort = new AbortController();
    let pullOptions: { abortSignal?: AbortSignal } | undefined;
    let created = false;
    const docker = {
      getImage: () => ({ inspect: () => Promise.reject(new Error("no such image")) }),
      pull: (_image: string, options: { abortSignal?: AbortSignal }) => {
        pullOptions = options;
        return new Promise(() => undefined); // registry never sends a byte
      },
      getContainer: () => ({ remove: () => Promise.resolve() }),
      createContainer: () => {
        created = true;
        return Promise.reject(new Error("must not be reached"));
      },
      modem: {}
    } as unknown as Docker;
    const running = dockerCiSandbox(docker).run({
      runId: "r1",
      image: "node:22-bookworm",
      workspace: os.tmpdir(),
      env: {},
      timeoutMs: 60_000,
      memoryMb: 512,
      cpus: 1,
      steps: [{ name: "Test", run: "true" }],
      onSetupLog: () => undefined,
      onLog: () => undefined,
      onStep: () => undefined,
      isCancelled: () => false,
      signal: abort.signal
    });
    setTimeout(() => abort.abort(), 50);
    let result: Awaited<typeof running> | undefined;
    await within(
      2000,
      running.then((value) => {
        result = value;
      })
    );
    assert.deepEqual(result, { failedStep: null, cancelled: false, timedOut: true });
    assert.equal(pullOptions?.abortSignal, abort.signal);
    assert.equal(created, false);
  });

  test("a container Docker creates after the stop is removed", async () => {
    const abort = new AbortController();
    let removed = false;
    let stopped = false;
    let land: (value: unknown) => void = () => undefined;
    const docker = {
      getImage: () => ({ inspect: () => Promise.resolve({}) }),
      getContainer: () => ({ remove: () => Promise.reject(new Error("no such container")) }),
      createContainer: () =>
        new Promise((resolve) => {
          land = resolve;
        }),
      modem: {}
    } as unknown as Docker;
    const running = dockerCiSandbox(docker).run({
      runId: "r2",
      image: "node:22-bookworm",
      workspace: os.tmpdir(),
      env: {},
      timeoutMs: 60_000,
      memoryMb: 512,
      cpus: 1,
      steps: [{ name: "Test", run: "true" }],
      onSetupLog: () => undefined,
      onLog: () => undefined,
      onStep: () => undefined,
      isCancelled: () => stopped,
      signal: abort.signal
    });
    setTimeout(() => {
      stopped = true;
      abort.abort();
    }, 50);
    const result = await running;
    assert.equal(result.cancelled, true);
    land({
      remove: async () => {
        removed = true;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(removed, true);
  });
});
