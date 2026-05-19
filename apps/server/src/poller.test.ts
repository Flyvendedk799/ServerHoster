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
