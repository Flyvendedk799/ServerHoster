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

function hasPnpm(): boolean {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initGitFixture(
  dir: string,
  pkgOrReadme: { kind: "package"; pkg: Record<string, unknown> } | { kind: "readme" },
  branch = "main"
): void {
  fs.mkdirSync(dir, { recursive: true });
  if (pkgOrReadme.kind === "readme") {
    fs.writeFileSync(path.join(dir, "README.md"), "# empty\n");
  } else {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgOrReadme.pkg, null, 2));
  }
  execSync(`git init -b ${JSON.stringify(branch)}`, { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "survhub-test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "SURVHub Test"', { cwd: dir, stdio: "ignore" });
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
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

test("deploy-from-github: minimal npm repo via file URL", { skip: !hasGit() }, async () => {
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
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
      .run();
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
        startAfterDeploy: false,
        enableQuickTunnel: true
      }
    });
    assert.equal(dep.statusCode, 200);
    const body = dep.json() as {
      deployment: { status: string };
      service: { id: string; status: string; github_repo_url: string; quick_tunnel_enabled: number };
    };
    assert.equal(body.deployment.status, "success");
    assert.equal(body.service.status, "stopped");
    assert.equal(body.service.github_repo_url, repoUrl);
    assert.equal(body.service.quick_tunnel_enabled, 1);

    cleanupDeployArtifacts(ctx, body.service.id, projectId);
  } finally {
    await gracefulShutdown(ctx);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "deploy-from-github: falls back to the remote default branch when main is missing",
  { skip: !hasGit() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-master-"));
    initGitFixture(
      tmp,
      {
        kind: "package",
        pkg: {
          name: "fixture-master-branch",
          version: "1.0.0",
          private: true,
          scripts: { start: 'node -e "process.exit(0)"' }
        }
      },
      "master"
    );
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
        .run();
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
        payload: { name: `deploy-master-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-master-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; branch: string; build_log: string };
        service: { id: string; github_branch: string };
      };
      assert.equal(body.deployment.status, "success");
      assert.equal(body.deployment.branch, "master");
      assert.equal(body.service.github_branch, "master");
      assert.match(body.deployment.build_log, /using remote default branch "master"/);

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "deploy-from-github: falls back to native node when a Dockerfile build fails",
  { skip: !hasGit() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-docker-fallback-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-fake-docker-"));
    const oldPath = process.env.PATH;
    initGitFixture(tmp, {
      kind: "package",
      pkg: {
        name: "fixture-bad-docker-good-node",
        version: "1.0.0",
        private: true,
        scripts: {
          build: 'node -e "process.exit(0)"',
          start: 'node -e "process.exit(0)"'
        }
      }
    });
    fs.writeFileSync(path.join(tmp, "Dockerfile"), "FROM node:20\nRUN exit 1\n");
    execSync("git add Dockerfile && git commit -m dockerfile", { cwd: tmp, stdio: "ignore" });
    const fakeDocker = path.join(fakeBin, "docker");
    fs.writeFileSync(fakeDocker, '#!/bin/sh\necho "fake docker build failed" >&2\nexit 1\n');
    fs.chmodSync(fakeDocker, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
        .run();
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
        payload: { name: `deploy-docker-fallback-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-docker-fallback-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; build_log: string };
        service: { id: string; type: string; command: string };
      };
      assert.equal(body.deployment.status, "success");
      assert.equal(body.service.type, "process");
      assert.equal(body.service.command, "npm run start");
      assert.match(body.deployment.build_log, /Docker build failed/);
      assert.match(body.deployment.build_log, /native node deployment pipeline/);

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      process.env.PATH = oldPath;
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  }
);

test(
  "deploy-from-github: pnpm workspace repo uses pnpm install",
  { skip: !hasGit() || !hasPnpm() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-pnpm-"));
    fs.mkdirSync(path.join(tmp, "packages/shared"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "fixture-pnpm-workspace",
          version: "1.0.0",
          private: true,
          packageManager: "pnpm@9.15.0",
          scripts: { build: 'node -e "process.exit(0)"', start: 'node -e "process.exit(0)"' },
          dependencies: { "@fixture/shared": "workspace:*" }
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(tmp, "packages/shared/package.json"),
      JSON.stringify({ name: "@fixture/shared", version: "1.0.0", main: "index.js" }, null, 2)
    );
    execSync("pnpm install --lockfile-only", { cwd: tmp, stdio: "ignore" });
    execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
    execSync('git config user.email "survhub-test@example.com"', { cwd: tmp, stdio: "ignore" });
    execSync('git config user.name "SURVHub Test"', { cwd: tmp, stdio: "ignore" });
    execSync("git add -A", { cwd: tmp, stdio: "ignore" });
    execSync("git commit -m init", { cwd: tmp, stdio: "ignore" });
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
        .run();
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
        payload: { name: `deploy-pnpm-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-pnpm-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; build_log: string };
        service: { id: string; command: string };
      };
      assert.equal(body.deployment.status, "success");
      assert.match(body.deployment.build_log, /Detected package manager: pnpm/);
      assert.match(body.deployment.build_log, /\$ pnpm install/);
      assert.equal(body.service.command, "pnpm run start");

      cleanupDeployArtifacts(ctx, body.service.id, projectId);
    } finally {
      await gracefulShutdown(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "deploy-from-github: pnpm electron workspace selects desktop package automatically",
  { skip: !hasGit() || !hasPnpm() },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-electron-"));
    fs.mkdirSync(path.join(tmp, "apps/desktop"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "fixture-electron-workspace",
          version: "1.0.0",
          private: true,
          packageManager: "pnpm@9.15.0",
          scripts: {
            build: 'node -e "process.exit(42)"',
            start: 'node -e "process.exit(0)"'
          }
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    fs.writeFileSync(
      path.join(tmp, "apps/desktop/package.json"),
      JSON.stringify(
        {
          name: "@fixture/desktop",
          version: "1.0.0",
          private: true,
          scripts: { dev: "electron-vite dev" }
        },
        null,
        2
      )
    );
    execSync("pnpm install --lockfile-only", { cwd: tmp, stdio: "ignore" });
    execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
    execSync('git config user.email "survhub-test@example.com"', { cwd: tmp, stdio: "ignore" });
    execSync('git config user.name "SURVHub Test"', { cwd: tmp, stdio: "ignore" });
    execSync("git add -A", { cwd: tmp, stdio: "ignore" });
    execSync("git commit -m init", { cwd: tmp, stdio: "ignore" });
    const repoUrl = pathToFileURL(tmp).href;

    const ctx = await buildApp();
    try {
      ctx.db.prepare("DELETE FROM sessions").run();
      ctx.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
        .run();
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
        payload: { name: `deploy-electron-${Date.now()}` }
      });
      const projectId = (proj.json() as { id: string }).id;

      const dep = await ctx.app.inject({
        method: "POST",
        url: "/services/deploy-from-github",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId,
          name: `svc-electron-${Date.now()}`,
          repoUrl,
          startAfterDeploy: false
        }
      });
      assert.equal(dep.statusCode, 200);
      const body = dep.json() as {
        deployment: { status: string; build_log: string };
        service: { id: string; command: string; working_dir: string };
      };
      assert.equal(body.deployment.status, "success");
      assert.match(body.deployment.build_log, /Selected launch target: apps\/desktop/);
      assert.match(body.deployment.build_log, /Skipping package build for Electron package apps\/desktop/);
      assert.equal(body.service.command, "pnpm run dev");
      assert.equal(path.basename(body.service.working_dir), "desktop");

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
      ctx.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
        .run();
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

test("deploy-from-github: unknown repo layout fails with clear log", { skip: !hasGit() }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-git-unknown-"));
  initGitFixture(tmp, { kind: "readme" });
  const repoUrl = pathToFileURL(tmp).href;

  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
      .run();
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
});

test("scan-local-project detects npm dev servers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-local-scan-"));
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify(
      {
        name: "scan-fixture",
        version: "1.0.0",
        private: true,
        scripts: {
          dev: "vite --host 0.0.0.0 --port 5177",
          start: "node server.js"
        },
        devDependencies: { vite: "^6.0.0" }
      },
      null,
      2
    )
  );

  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
      .run();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "test-pass" }
    });
    const token = login.json().token as string;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/services/scan-local-project",
      headers: { authorization: `Bearer ${token}` },
      payload: { localPath: tmp }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      name: string;
      buildType: string;
      candidates: Array<{ command: string; port?: number; recommended?: boolean }>;
    };
    assert.equal(body.name, path.basename(tmp).toLowerCase());
    assert.equal(body.buildType, "node");
    assert.ok(
      body.candidates.some(
        (candidate) => candidate.command === "npm run dev" && candidate.port === 5177 && candidate.recommended
      )
    );
    assert.ok(body.candidates.some((candidate) => candidate.command === "npm run start"));
  } finally {
    await gracefulShutdown(ctx);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deploy-from-local stores selected command and tunnel mode", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-local-deploy-"));
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify(
      {
        name: "local-deploy-fixture",
        version: "1.0.0",
        private: true,
        scripts: {
          dev: "node server.js",
          build: 'node -e "process.exit(0)"'
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(tmp, "server.js"), "console.log('fixture server');\n");

  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM sessions").run();
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
      .run();
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
      payload: { name: `local-deploy-${Date.now()}` }
    });
    assert.equal(proj.statusCode, 200);
    const projectId = (proj.json() as { id: string }).id;

    const dep = await ctx.app.inject({
      method: "POST",
      url: "/services/deploy-from-local",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        projectId,
        name: `local-svc-${Date.now()}`,
        localPath: tmp,
        command: "npm run dev",
        port: 5177,
        startAfterDeploy: false,
        enableQuickTunnel: true
      }
    });
    assert.equal(dep.statusCode, 200);
    const body = dep.json() as {
      deployment: { status: string };
      service: {
        id: string;
        command: string;
        working_dir: string;
        quick_tunnel_enabled: number;
        status: string;
      };
    };
    assert.equal(body.deployment.status, "success");
    assert.equal(body.service.command, "npm run dev");
    assert.equal(body.service.working_dir, tmp);
    assert.equal(body.service.quick_tunnel_enabled, 1);
    assert.equal(body.service.status, "stopped");

    cleanupDeployArtifacts(ctx, body.service.id, projectId);
  } finally {
    await gracefulShutdown(ctx);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
