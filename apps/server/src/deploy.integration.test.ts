import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";

function hasGit(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initGitFixture(dir: string, pkgOrReadme: { kind: "package"; pkg: Record<string, unknown> } | { kind: "readme" }): void {
  fs.mkdirSync(dir, { recursive: true });
  if (pkgOrReadme.kind === "readme") {
    fs.writeFileSync(path.join(dir, "README.md"), "# empty\n");
  } else {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgOrReadme.pkg, null, 2));
  }
  // Force branch to `main` regardless of the host's `init.defaultBranch`
  // setting so the deploy pipeline (which checks out `main` by default)
  // can find it.
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "survhub-test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "SURVHub Test"', { cwd: dir, stdio: "ignore" });
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m init', { cwd: dir, stdio: "ignore" });
}

function cleanupDeployArtifacts(
  ctx: Awaited<ReturnType<typeof buildApp>>,
  serviceId: string,
  projectId: string
): void {
  try {
    fs.rmSync(path.join(ctx.config.projectsDir, serviceId), { recursive: true, force: true });
  } catch {
    // ignore
  }
  ctx.db.prepare("DELETE FROM deployments WHERE service_id = ?").run(serviceId);
  ctx.db.prepare("DELETE FROM logs WHERE service_id = ?").run(serviceId);
  ctx.db.prepare("DELETE FROM services WHERE id = ?").run(serviceId);
  ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}

test(
  "deploy-from-github: minimal npm repo via file URL",
  { skip: !hasGit() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-ok-"));
    initGitFixture(tmp, {
      kind: "package",
      pkg: {
        name: "fixture-minimal",
        version: "1.0.0",
        private: true,
        scripts: { start: 'node -e "process.exit(0)"' }
      }
    });
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: "test-pass" }
      });
      assert.equal(login.statusCode, 200);
      const token = login.json().token as string;

      const proj = await ctx.app.inject({
        method: "POST",
        url: "/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `deploy-ok-${Date.now()}` }
      });
      assert.equal(proj.statusCode, 200);
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-ok-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string };
        service: { id: string; status: string };
      };
      assert.equal(body.deployment.status, "success");
      assert.equal(body.service.status, "stopped");

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "deploy-from-github: failing npm build marks deployment failed and service stopped",
  { skip: !hasGit() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-fail-"));
    initGitFixture(tmp, {
      kind: "package",
      pkg: {
        name: "fixture-bad-build",
        version: "1.0.0",
        scripts: {
          build: 'node -e "process.exit(1)"',
          start: 'node -e "process.exit(0)"'
        }
      }
    });
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: "test-pass" }
      });
      const token = login.json().token as string;

      const proj = await ctx.app.inject({
        method: "POST",
        url: "/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `deploy-fail-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-fail-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; build_log: string };
        service: { id: string; status: string };
      };
      assert.equal(body.deployment.status, "failed");
      assert.match(body.deployment.build_log, /npm run build/i);
      assert.equal(body.service.status, "stopped");

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "deploy-from-github: unknown repo layout fails with clear log",
  { skip: !hasGit() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-unknown-"));
    initGitFixture(tmp, { kind: "readme" });
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')").run();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: "test-pass" }
      });
      const token = login.json().token as string;

      const proj = await ctx.app.inject({
        method: "POST",
        url: "/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `deploy-unknown-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-unknown-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; build_log: string };
        service: { id: string; status: string };
      };
      assert.equal(body.deployment.status, "failed");
      assert.match(body.deployment.build_log, /repository layout/i);
      assert.equal(body.service.status, "stopped");

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);
