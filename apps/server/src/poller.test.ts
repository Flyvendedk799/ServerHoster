import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { getGithubSyncStatus, getGithubSyncStatuses, pollGitUpdatesOnce } from "./services/poller.js";
import { gracefulShutdown } from "./services/runtime.js";

function hasGit(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commitRepo(dir: string, message: string): string {
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: dir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "poller-fixture",
        version: "1.0.0",
        private: true,
        scripts: { start: 'node -e "setTimeout(() => {}, 1000)"' }
      },
      null,
      2
    )
  );
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "survhub-test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "SURVHub Test"', { cwd: dir, stdio: "ignore" });
  return commitRepo(dir, "init");
}

function seedGitService(
  ctx: Awaited<ReturnType<typeof buildApp>>,
  repoUrl: string,
  overrides: { lastAttempted?: string | null } = {}
): { projectId: string; serviceId: string } {
  const projectId = nanoid();
  const serviceId = nanoid();
  const now = nowIso();
  ctx.db
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(projectId, "poller-project", now, now);
  ctx.db
    .prepare(
      `INSERT INTO services (
        id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at,
        github_repo_url, github_branch, github_auto_pull, last_attempted_commit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      serviceId,
      projectId,
      "poller-service",
      "process",
      "",
      "",
      "",
      "",
      0,
      "stopped",
      1,
      0,
      5,
      "manual",
      now,
      now,
      repoUrl,
      "main",
      1,
      overrides.lastAttempted ?? null
    );
  return { projectId, serviceId };
}

function deploymentCount(ctx: Awaited<ReturnType<typeof buildApp>>, serviceId: string): number {
  return (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE service_id = ?").get(serviceId) as {
      n: number;
    }
  ).n;
}

function isWindowsCleanupRace(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function rmTreeWithRetry(target: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts || !isWindowsCleanupRace(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

test("git poller deploys when a service has no commit baseline", { skip: !hasGit() }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-poller-repo-"));
  const firstHash = initRepo(repo);
  const repoUrl = pathToFileURL(repo).href;
  const ctx = await buildApp();
  const projectId = nanoid();
  const serviceId = nanoid();
  try {
    const now = nowIso();
    ctx.db
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(projectId, "poller-project", now, now);
    ctx.db
      .prepare(
        `INSERT INTO services (
          id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
          auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at,
          github_repo_url, github_branch, github_auto_pull
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        serviceId,
        projectId,
        "poller-service",
        "process",
        "",
        "",
        "",
        "",
        0,
        "stopped",
        1,
        0,
        5,
        "manual",
        now,
        now,
        repoUrl,
        "main",
        1
      );

    const before = await getGithubSyncStatus(ctx, serviceId);
    assert.equal(before.remoteHash, firstHash);
    assert.equal(before.latestCommitHash, null);
    assert.equal(before.updateAvailable, true);

    await pollGitUpdatesOnce(ctx);

    const deployment = ctx.db
      .prepare(
        "SELECT commit_hash, trigger_source FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(serviceId) as { commit_hash?: string; trigger_source?: string } | undefined;
    assert.equal(deployment?.commit_hash, firstHash);
    assert.equal(deployment?.trigger_source, "gitops-poller");

    const after = await getGithubSyncStatus(ctx, serviceId);
    assert.equal(after.remoteHash, firstHash);
    assert.equal(after.latestCommitHash, firstHash);
    assert.equal(after.updateAvailable, false);
    assert.equal(after.requiresRestart, false);

    fs.writeFileSync(path.join(repo, "change.txt"), "new remote change\n");
    const secondHash = commitRepo(repo, "second change");
    ctx.db.prepare("UPDATE services SET status = 'running' WHERE id = ?").run(serviceId);

    const pending = await getGithubSyncStatus(ctx, serviceId);
    assert.equal(pending.remoteHash, secondHash);
    assert.equal(pending.latestCommitHash, firstHash);
    assert.equal(pending.updateAvailable, true);
    assert.equal(pending.requiresRestart, true);

    const batched = await getGithubSyncStatuses(ctx, [serviceId]);
    assert.equal(batched[0]?.remoteHash, secondHash);
    assert.equal(batched[0]?.requiresRestart, true);
  } finally {
    await gracefulShutdown(ctx);
    await rmTreeWithRetry(repo);
    await rmTreeWithRetry(path.join(ctx.config.projectsDir, serviceId));
  }
});

test(
  "git poller does NOT redeploy a commit it already attempted (no infinite loop)",
  { skip: !hasGit() },
  async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-poller-attempted-"));
    const firstHash = initRepo(repo);
    const repoUrl = pathToFileURL(repo).href;
    const ctx = await buildApp();
    // Simulate a commit we already tried (e.g. it failed to build last tick).
    const { serviceId } = seedGitService(ctx, repoUrl, { lastAttempted: firstHash });
    try {
      await pollGitUpdatesOnce(ctx);
      assert.equal(
        deploymentCount(ctx, serviceId),
        0,
        "poller should skip a commit already recorded in last_attempted_commit"
      );
    } finally {
      await gracefulShutdown(ctx);
      await rmTreeWithRetry(repo);
      await rmTreeWithRetry(path.join(ctx.config.projectsDir, serviceId));
    }
  }
);

test(
  "git poller skips a service whose action lock is held",
  { skip: !hasGit() },
  async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-poller-locked-"));
    initRepo(repo);
    const repoUrl = pathToFileURL(repo).href;
    const ctx = await buildApp();
    const { serviceId } = seedGitService(ctx, repoUrl);
    ctx.actionLocks.add(serviceId); // a deploy/start/stop is "in progress"
    try {
      await pollGitUpdatesOnce(ctx);
      assert.equal(
        deploymentCount(ctx, serviceId),
        0,
        "poller must not start a deploy while another action holds the lock"
      );
    } finally {
      ctx.actionLocks.delete(serviceId);
      await gracefulShutdown(ctx);
      await rmTreeWithRetry(repo);
      await rmTreeWithRetry(path.join(ctx.config.projectsDir, serviceId));
    }
  }
);

test("getGithubSyncStatus: no deploy record but a clone at HEAD is NOT 'update available'", async () => {
  if (!hasGit()) return;
  const ctx = await buildApp();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "poller-remote-"));
  let serviceId = "";
  try {
    const head = initRepo(remoteDir);
    // No deployment row is seeded — mirrors an adopted/running service whose
    // "deployed" commit would otherwise read as "none".
    ({ serviceId } = seedGitService(ctx, pathToFileURL(remoteDir).href));
    // Clone into the dir the poller inspects, checked out at the remote HEAD.
    const cloneDir = path.join(ctx.config.projectsDir, serviceId);
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    execSync(`git clone ${JSON.stringify(remoteDir)} ${JSON.stringify(cloneDir)}`, { stdio: "ignore" });

    const status = await getGithubSyncStatus(ctx, serviceId);
    assert.equal(status.latestCommitHash, head, "baseline should fall back to the clone HEAD");
    assert.equal(status.updateAvailable, false, "a clone already at remote HEAD must not report an update");

    // Advance the remote — now the clone is genuinely behind and an update is real.
    fs.writeFileSync(path.join(remoteDir, "feature.txt"), "x");
    commitRepo(remoteDir, "feature");
    const after = await getGithubSyncStatus(ctx, serviceId);
    assert.equal(after.updateAvailable, true, "a genuinely-behind clone should report an update");
  } finally {
    fs.rmSync(remoteDir, { recursive: true, force: true });
    await rmTreeWithRetry(path.join(ctx.config.projectsDir, serviceId));
    await gracefulShutdown(ctx);
  }
});
