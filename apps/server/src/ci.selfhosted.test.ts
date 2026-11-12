import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import type { AppContext } from "./types.js";
import {
  branchFromRef,
  isForkPullRequest,
  isSafeBranchName,
  laneForPullRequest,
  laneForPush,
  parseBranchPatterns,
  shouldRunPullRequest,
  shouldRunPush
} from "./services/ciTriggers.js";
import {
  flushCommitStatuses,
  reportCommitStatus,
  runTargetUrl,
  setStatusFetchForTests,
  statusContext
} from "./services/ciStatus.js";
import { admitJob, defaultMaxConcurrent, type CiCapacitySettings } from "./services/ciCapacity.js";
import { applyCiFirewall, ciFirewallRules } from "./services/ciNetwork.js";
import { buildCiContainerSpec, ciCpuCap } from "./services/ciDocker.js";
import { dirSize, pruneCaches, repoCacheKey } from "./services/ciCache.js";
import { encryptSecret } from "./security.js";

describe("CI triggers", () => {
  test("branches come from the full ref, and tags are not branches", () => {
    assert.equal(branchFromRef("refs/heads/main"), "main");
    assert.equal(branchFromRef("refs/heads/feature/login"), "feature/login");
    assert.equal(branchFromRef("refs/tags/main"), null);
    assert.equal(branchFromRef("main"), null);
    assert.equal(branchFromRef("refs/heads/-x"), null);
    assert.equal(isSafeBranchName("a..b"), false);
    assert.equal(isSafeBranchName("a b"), false);
  });

  test("the default runs the deploy branch only; patterns widen it", () => {
    assert.equal(shouldRunPush({}, "main", "main"), true);
    assert.equal(shouldRunPush({}, "feature/x", "main"), false);
    assert.equal(shouldRunPush({ trigger_branches: "*" }, "feature/x", "main"), true);
    assert.equal(shouldRunPush({ trigger_branches: "feature/*" }, "feature/x", "main"), true);
    assert.equal(shouldRunPush({ trigger_branches: "feature/*" }, "feature/x/y", "main"), false);
    assert.equal(shouldRunPush({ trigger_branches: "feature/**" }, "feature/x/y", "main"), true);
    // A pattern must match the whole name, not a suffix like the old split("/").pop().
    assert.equal(shouldRunPush({ trigger_branches: "x" }, "feature/x", "main"), false);
    assert.deepEqual(parseBranchPatterns("dev, release/*\nhotfix"), ["dev", "release/*", "hotfix"]);
    assert.throws(() => parseBranchPatterns("bad pattern!"));
  });

  test("pull requests: same-repo PRs into the deploy branch run, forks never do", () => {
    const pr = { action: "opened", baseBranch: "main", headBranch: "feature/x", isFork: false };
    assert.deepEqual(shouldRunPullRequest({}, pr, "main"), { run: true });
    assert.equal(shouldRunPullRequest({}, { ...pr, isFork: true }, "main").run, false);
    assert.deepEqual(shouldRunPullRequest({}, { ...pr, isFork: true }, "main"), {
      run: false,
      reason: "fork"
    });
    assert.deepEqual(shouldRunPullRequest({ trigger_pull_requests: 0 }, pr, "main"), {
      run: false,
      reason: "disabled"
    });
    assert.deepEqual(shouldRunPullRequest({}, { ...pr, baseBranch: "dev" }, "main"), {
      run: false,
      reason: "base-branch"
    });
    assert.equal(
      shouldRunPullRequest({ trigger_branches: "dev" }, { ...pr, baseBranch: "dev" }, "main").run,
      true
    );
    assert.deepEqual(shouldRunPullRequest({}, { ...pr, action: "labeled" }, "main"), {
      run: false,
      reason: "action"
    });
    assert.equal(shouldRunPullRequest({}, { ...pr, action: "synchronize" }, "main").run, true);
    assert.equal(isForkPullRequest("Org/Repo", "org/repo"), false);
    assert.equal(isForkPullRequest("someone/repo", "org/repo"), true);
    // A deleted fork has no head repo: treat it as a fork.
    assert.equal(isForkPullRequest(null, "org/repo"), true);
    assert.equal(laneForPush("main"), "push:main");
    assert.equal(laneForPullRequest(12), "pr:12");
  });
});

function statusCtx(token: string | null): AppContext {
  const settings = new Map<string, string>();
  const secretKey = "test-secret-key-32-bytes-not-for-prod";
  if (token) settings.set("github_pat", encryptSecret(token, secretKey));
  return {
    db: {
      prepare: () => ({
        get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined),
        run: () => ({ changes: 0 }),
        all: () => []
      })
    },
    config: { secretKey, publicUrl: "https://hoster.example.com/" }
  } as unknown as AppContext;
}

const SHA = "a".repeat(40);

describe("CI commit statuses", () => {
  test("posts the run state with context, target url and the saved token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setStatusFetchForTests(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 201 });
    });
    try {
      const ctx = statusCtx("ghp_secret_token_value");
      const target = {
        runId: "run1",
        repoUrl: "https://github.com/Org/Repo.git",
        commit: SHA,
        pipelineName: "Awaire CI"
      };
      const pending = reportCommitStatus(ctx, target, "pending", "Queued");
      const done = reportCommitStatus(ctx, target, "success", "Passed");
      assert.deepEqual(await pending, { ok: true });
      assert.deepEqual(await done, { ok: true });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, `https://api.github.com/repos/Org/Repo/statuses/${SHA}`);
      const first = JSON.parse(String(calls[0].init.body));
      const second = JSON.parse(String(calls[1].init.body));
      // Serialized per run: pending can never land after the final state.
      assert.equal(first.state, "pending");
      assert.equal(second.state, "success");
      assert.equal(first.context, "survhub-ci/Awaire CI");
      assert.equal(first.target_url, "https://hoster.example.com/ci?run=run1");
      assert.equal(
        (calls[0].init.headers as Record<string, string>).Authorization,
        "Bearer ghp_secret_token_value"
      );
    } finally {
      setStatusFetchForTests(null);
    }
  });

  test("a refusal is a redacted warning, never a throw, and missing inputs skip", async () => {
    setStatusFetchForTests(
      async () => new Response(JSON.stringify({ message: "bad ghp_secret_token_value" }), { status: 403 })
    );
    try {
      const ctx = statusCtx("ghp_secret_token_value");
      const target = { runId: "run2", repoUrl: "https://github.com/o/r", commit: SHA, pipelineName: "CI" };
      const result = await reportCommitStatus(ctx, target, "failure", "Step failed");
      assert.equal(result.ok, false);
      assert.ok("warning" in result);
      if ("warning" in result) {
        assert.match(result.warning, /403/);
        assert.match(result.warning, /Commit statuses: write/);
        assert.doesNotMatch(result.warning, /ghp_secret_token_value/);
      }
      setStatusFetchForTests(async () => {
        throw new Error("network down");
      });
      const offline = await reportCommitStatus(ctx, target, "error", "x");
      assert.ok("warning" in offline);
      assert.equal((await reportCommitStatus(statusCtx(null), target, "error", "x")).ok, false);
      assert.ok("skipped" in (await reportCommitStatus(ctx, { ...target, commit: "abc" }, "error", "x")));
      assert.ok(
        "skipped" in
          (await reportCommitStatus(ctx, { ...target, repoUrl: "https://gitlab.com/o/r" }, "error", "x"))
      );
      await flushCommitStatuses();
    } finally {
      setStatusFetchForTests(null);
    }
  });

  test("context and target url are sanitized", () => {
    assert.equal(statusContext("x".repeat(200)).length <= "survhub-ci/".length + 80, true);
    assert.equal(runTargetUrl("", "r"), undefined);
    assert.equal(runTargetUrl("javascript:alert(1)", "r"), undefined);
    assert.equal(runTargetUrl("http://h:8080", "a b"), "http://h:8080/ci?run=a%20b");
  });
});

const SETTINGS: CiCapacitySettings = {
  maxConcurrent: null,
  budgetPercent: 50,
  readonlyRootfs: true,
  cacheMaxMb: 5120,
  workspaceMaxMb: 10240
};

describe("CI scheduler capacity", () => {
  test("auto concurrency is about one job per 2 cores and 2.5 GB free, 1..4", () => {
    assert.equal(defaultMaxConcurrent({ cpus: 1, totalMemMb: 2048, freeMemMb: 1024 }), 1);
    assert.equal(defaultMaxConcurrent({ cpus: 8, totalMemMb: 16384, freeMemMb: 8000 }), 3);
    assert.equal(defaultMaxConcurrent({ cpus: 64, totalMemMb: 262144, freeMemMb: 200000 }), 4);
  });

  test("the first job always starts; later ones queue instead of overcommitting", () => {
    const small = { cpus: 2, totalMemMb: 4096, freeMemMb: 1000 };
    const job = { memoryMb: 2048, cpus: 1 };
    assert.deepEqual(admitJob([], { memoryMb: 8192, cpus: 4 }, small, SETTINGS), { admit: true });
    const big = { cpus: 16, totalMemMb: 32768, freeMemMb: 30000 };
    assert.equal(admitJob([job], job, big, SETTINGS).admit, true);
    assert.equal(admitJob([job, job, job, job], job, big, SETTINGS).admit, false);
    assert.equal(admitJob([job], job, big, { ...SETTINGS, maxConcurrent: 1 }).admit, false);
    // 50% of 8 GB = 4 GB: a third 2 GB job does not fit.
    const mid = { cpus: 16, totalMemMb: 8192, freeMemMb: 7000 };
    assert.equal(admitJob([job, job], job, { ...mid }, { ...SETTINGS, maxConcurrent: 4 }).admit, false);
    // CPU budget: 50% of 4 cores = 2.
    const cpuBound = { cpus: 4, totalMemMb: 65536, freeMemMb: 60000 };
    assert.equal(admitJob([job, job], job, cpuBound, { ...SETTINGS, maxConcurrent: 4 }).admit, false);
    // Free RAM headroom: the next job plus 1 GB must be free right now.
    const busy = { cpus: 16, totalMemMb: 32768, freeMemMb: 2500 };
    assert.equal(admitJob([job], job, busy, SETTINGS).admit, false);
  });
});

describe("CI container", () => {
  const base = {
    name: "survhub-ci-x",
    runId: "x",
    image: "node:22-bookworm-slim",
    workspace: "/data/ci-work/x",
    env: { FOO: "bar" },
    memoryMb: 2048,
    cpus: 1,
    hostCpus: 8,
    user: "1000:1000",
    cacheDir: "/data/ci-cache/abc",
    network: "survhub-ci",
    readonlyRootfs: true,
    blkioWeight: true
  };

  test("hard limits, low priority and a locked-down container", () => {
    const spec = buildCiContainerSpec(base);
    const host = spec.HostConfig!;
    assert.equal(host.Memory, 2048 * 1024 * 1024);
    assert.equal(host.MemorySwap, host.Memory);
    assert.equal(host.NanoCpus, 2e9);
    assert.equal(host.CpuShares, 256);
    assert.equal(host.BlkioWeight, 100);
    assert.equal(host.PidsLimit, 512);
    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.deepEqual(host.SecurityOpt, ["no-new-privileges:true"]);
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.Privileged, false);
    assert.equal(host.NetworkMode, "survhub-ci");
    assert.equal(host.ExtraHosts, undefined);
    assert.deepEqual(host.LogConfig, { Type: "none", Config: {} });
    assert.equal(host.Ulimits?.[0]?.Name, "nofile");
    assert.match(String(host.Tmpfs?.["/tmp"]), /size=1024m/);
    // Windows prefixes the drive (/d/data/...), so match the tail only.
    assert.ok(host.Binds?.some((bind) => bind.endsWith("/data/ci-cache/abc:/cache:rw")));
    assert.ok(!host.Binds?.some((bind) => bind.includes("docker.sock")));
    assert.equal(spec.User, "1000:1000");
    assert.ok(spec.Env?.includes("npm_config_cache=/cache/npm"));
    assert.ok(spec.Env?.includes("HOME=/tmp"));
    assert.ok(spec.Env?.includes("FOO=bar"));
    const plain = buildCiContainerSpec({
      ...base,
      cacheDir: null,
      blkioWeight: false,
      readonlyRootfs: false
    });
    assert.equal(plain.HostConfig?.BlkioWeight, undefined);
    assert.equal(plain.HostConfig?.ReadonlyRootfs, false);
    assert.equal(plain.HostConfig?.Binds?.length, 1);
    assert.ok(!plain.Env?.some((entry) => entry.startsWith("npm_config_cache=")));
  });

  test("CPU may burst to twice the request, never past 4 cores or the host", () => {
    assert.equal(ciCpuCap(1, 8), 2);
    assert.equal(ciCpuCap(3, 8), 4);
    assert.equal(ciCpuCap(1, 1), 1);
    assert.equal(ciCpuCap(0.5, 8), 1);
  });
});

describe("CI network firewall", () => {
  test("rules drop host and private traffic from the CI bridge, DNS excepted", () => {
    const rules = ciFirewallRules("survhub-ci0");
    assert.deepEqual(rules[0], { chain: "INPUT", spec: ["-i", "survhub-ci0", "-j", "DROP"] });
    const forward = rules.filter((rule) => rule.chain === "DOCKER-USER").map((rule) => rule.spec.join(" "));
    assert.ok(forward.some((spec) => spec.includes("10.0.0.0/8") && spec.endsWith("DROP")));
    assert.ok(forward.some((spec) => spec.includes("169.254.0.0/16")));
    const dns = forward.findIndex((spec) => spec.includes("--dport 53"));
    const drop = forward.findIndex((spec) => spec.endsWith("DROP"));
    assert.ok(dns >= 0 && dns < drop, "DNS RETURN comes before the drops");
  });

  test("applies only as root on Linux, idempotently, and never throws", async () => {
    assert.equal((await applyCiFirewall({ platform: "darwin", uid: 0 })).applied, false);
    assert.equal((await applyCiFirewall({ platform: "linux", uid: 1000 })).applied, false);
    const installed = new Set<string>();
    const calls: string[] = [];
    const run = async (_cmd: string, args: string[]) => {
      const [op, chain, ...rest] = args;
      const key = `${chain} ${rest.filter((part, index) => !(op === "-I" && index === 0)).join(" ")}`;
      calls.push(op);
      if (op === "-C" && !installed.has(key)) throw new Error("missing");
      if (op === "-D") {
        if (!installed.delete(key)) throw new Error("missing");
      }
      if (op === "-I") installed.add(key);
    };
    assert.equal((await applyCiFirewall({ platform: "linux", uid: 0, run })).applied, true);
    const inserted = calls.filter((op) => op === "-I").length;
    assert.equal(inserted, ciFirewallRules().length);
    calls.length = 0;
    await applyCiFirewall({ platform: "linux", uid: 0, run });
    assert.equal(calls.filter((op) => op === "-I").length, 0, "second apply adds nothing");
    const failing = await applyCiFirewall({
      platform: "linux",
      uid: 0,
      run: async () => {
        throw new Error("iptables: not found");
      }
    });
    assert.equal(failing.applied, false);
    assert.match(failing.note, /iptables/);
  });
});

describe("CI dependency cache", () => {
  test("keys ignore credentials and .git; prune enforces the cap but skips busy repos", async () => {
    assert.equal(
      repoCacheKey("https://x-access-token:abc@github.com/Org/Repo.git"),
      repoCacheKey("https://github.com/org/repo")
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-cache-"));
    try {
      const ctx = { config: { dataRoot: dir } } as unknown as AppContext;
      const root = path.join(dir, "ci-cache");
      for (const key of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) {
        fs.mkdirSync(path.join(root, key), { recursive: true });
        fs.writeFileSync(path.join(root, key, "blob"), Buffer.alloc(2 * 1024 * 1024));
      }
      assert.ok((await dirSize(path.join(root, "aaaaaaaaaaaaaaaa"))) >= 2 * 1024 * 1024);
      await pruneCaches(ctx, { maxMb: 1, busy: new Set(["bbbbbbbbbbbbbbbb"]) });
      assert.equal(fs.existsSync(path.join(root, "aaaaaaaaaaaaaaaa")), false);
      assert.equal(fs.existsSync(path.join(root, "bbbbbbbbbbbbbbbb")), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
