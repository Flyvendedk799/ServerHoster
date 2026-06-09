import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectNodeLaunchTarget,
  findDockerfile,
  nodeInstallCommands,
  nodeVersionWarning,
  pythonEntryCommand,
  resolveBuildType,
  resolveInstallCwd
} from "./services/deploy.js";

function tmpRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `survhub-deploy-${label}-`));
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

const VITE_APP = {
  name: "stellar-shimmer-folio",
  scripts: { dev: "vite", build: "vite build" },
  devDependencies: { vite: "^5.0.0" }
};

test("resolveInstallCwd: app at repo root installs at root", () => {
  const root = tmpRoot("root-app");
  try {
    writeJson(root, "package.json", VITE_APP);
    assert.equal(resolveInstallCwd(root, root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveInstallCwd: nested app (no workspace) installs inside the app dir", () => {
  // Reproduces the GitHub-import bug: a vite app nested under project/uploads/*
  // must install in its own folder, not the clone root, or `vite` is unresolved.
  const root = tmpRoot("nested-app");
  try {
    writeJson(root, "package.json", { name: "repo-root", scripts: {} });
    const appDir = path.join(root, "project", "uploads", "stellar-shimmer-folio-main");
    writeJson(appDir, "package.json", VITE_APP);
    assert.equal(resolveInstallCwd(root, appDir), appDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveInstallCwd: workspace member installs at the workspace root", () => {
  const root = tmpRoot("workspace");
  try {
    writeJson(root, "package.json", { name: "monorepo", workspaces: ["apps/*"] });
    const appDir = path.join(root, "apps", "web");
    writeJson(appDir, "package.json", VITE_APP);
    assert.equal(resolveInstallCwd(root, appDir), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveInstallCwd: pnpm-workspace member installs at the workspace root", () => {
  const root = tmpRoot("pnpm-workspace");
  try {
    writeJson(root, "package.json", { name: "monorepo" });
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
    const appDir = path.join(root, "apps", "web");
    writeJson(appDir, "package.json", VITE_APP);
    assert.equal(resolveInstallCwd(root, appDir), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nodeInstallCommands: existing node_modules adds a non-destructive npm rebuild", () => {
  // The better-sqlite3 case: a repo committed node_modules with foreign native
  // binaries; `npm install` no-ops, so `npm rebuild` recompiles for this host.
  // Crucially NON-destructive — never `npm ci` (which would wipe a working tree
  // on a failed redeploy).
  const root = tmpRoot("nic-committed");
  try {
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    assert.deepEqual(nodeInstallCommands("npm", root), ["npm install", "npm rebuild"]);
    assert.deepEqual(nodeInstallCommands("pnpm", root), [
      "pnpm install --frozen-lockfile=false",
      "pnpm rebuild"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nodeInstallCommands: clean dir → a single install, no ci", () => {
  const clean = tmpRoot("nic-clean");
  try {
    assert.deepEqual(nodeInstallCommands("npm", clean), ["npm install"]);
    assert.deepEqual(nodeInstallCommands("pnpm", clean), ["pnpm install --frozen-lockfile=false"]);
  } finally {
    fs.rmSync(clean, { recursive: true, force: true });
  }
});

test("nodeVersionWarning: flags a host/.nvmrc major mismatch, silent when matching", () => {
  const root = tmpRoot("nvw");
  try {
    const hostMajor = process.versions.node.split(".")[0];
    const otherMajor = String(Number(hostMajor) + 2);
    fs.writeFileSync(path.join(root, ".nvmrc"), otherMajor);
    const warn = nodeVersionWarning(root);
    assert.ok(warn, "expected a warning for a mismatched Node major");
    assert.match(warn, new RegExp(`Node ${otherMajor}`));
    fs.writeFileSync(path.join(root, ".nvmrc"), hostMajor);
    assert.equal(nodeVersionWarning(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pythonEntryCommand: framework-aware commands bind 0.0.0.0:$PORT via the venv python", () => {
  const fastapi = tmpRoot("py-fastapi");
  try {
    fs.writeFileSync(path.join(fastapi, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
    const cmd = pythonEntryCommand(fastapi);
    assert.match(cmd, /\.venv\/bin\/python -m uvicorn main:app --host 0\.0\.0\.0 --port \$PORT/);
  } finally {
    fs.rmSync(fastapi, { recursive: true, force: true });
  }
  const flask = tmpRoot("py-flask");
  try {
    fs.writeFileSync(path.join(flask, "app.py"), "from flask import Flask\napp = Flask(__name__)\n");
    assert.match(pythonEntryCommand(flask), /-m gunicorn app:app --bind 0\.0\.0\.0:\$PORT/);
  } finally {
    fs.rmSync(flask, { recursive: true, force: true });
  }
  const django = tmpRoot("py-django");
  try {
    fs.writeFileSync(path.join(django, "manage.py"), "# django\n");
    assert.match(pythonEntryCommand(django), /manage\.py runserver 0\.0\.0\.0:\$PORT/);
  } finally {
    fs.rmSync(django, { recursive: true, force: true });
  }
});

test("findDockerfile + resolveBuildType: a subdir-only Dockerfile deploys as docker", () => {
  const root = tmpRoot("docker-subdir");
  try {
    const apiDir = path.join(root, "services", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "Dockerfile"), "FROM node:20\n");
    assert.equal(findDockerfile(root), path.join("services", "api", "Dockerfile"));
    assert.equal(resolveBuildType(root), "docker");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBuildType: nested vite app with no root markers is detected as node, not static", () => {
  // The exact misdetection class: a Vite app nested under project/uploads/* ships
  // an index.html, so root-only detection would call it "static" and serve raw
  // source. resolveBuildType must widen to "node" so the build/install runs.
  const root = tmpRoot("rbt-nested-node");
  try {
    const appDir = path.join(root, "project", "uploads", "stellar-shimmer-folio-main");
    writeJson(appDir, "package.json", VITE_APP);
    fs.writeFileSync(path.join(appDir, "index.html"), "<div id=root></div>");
    assert.equal(resolveBuildType(root), "node");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBuildType: nested python app with no root markers is detected as python", () => {
  const root = tmpRoot("rbt-nested-py");
  try {
    const appDir = path.join(root, "backend");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "requirements.txt"), "flask\n");
    fs.writeFileSync(path.join(appDir, "app.py"), "print('hi')\n");
    assert.equal(resolveBuildType(root), "python");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBuildType: a genuine static site (no app package) stays static", () => {
  const root = tmpRoot("rbt-static");
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
    assert.equal(resolveBuildType(root), "static");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectNodeLaunchTarget: service-name match beats a stray nested web app", () => {
  // The real Mast3kMedia case: the repo root IS the user's app (named to match
  // the service), and a stray Vite export sits under project/uploads/. The root
  // must win over the higher-base-score web app it's competing with.
  const root = tmpRoot("name-match");
  try {
    writeJson(root, "package.json", {
      name: "mast3kmedia",
      scripts: { start: "node server.js", dev: "node --watch server.js" },
      dependencies: { express: "^4.18.0" }
    });
    fs.writeFileSync(path.join(root, "server.js"), "console.log('app')");
    const strayApp = path.join(root, "project", "uploads", "stellar-shimmer-folio-main");
    writeJson(strayApp, "package.json", VITE_APP);
    fs.writeFileSync(path.join(strayApp, "index.html"), "<div id=root></div>");

    const target = detectNodeLaunchTarget(root, "Mast3kMedia");
    assert.equal(path.resolve(target.workingDir), path.resolve(root), "should pick the root app");
    assert.match(target.command, /npm run start/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectNodeLaunchTarget: an app under uploads/ loses to the repo's own root app", () => {
  // Even with NO name match, a stray app under uploads/ should not beat a normal
  // root node app.
  const root = tmpRoot("uploads-penalty");
  try {
    writeJson(root, "package.json", {
      name: "my-server",
      scripts: { start: "node server.js" },
      dependencies: { express: "^4.18.0" }
    });
    fs.writeFileSync(path.join(root, "server.js"), "console.log('app')");
    const strayApp = path.join(root, "uploads", "some-vite-thing");
    writeJson(strayApp, "package.json", VITE_APP);

    const target = detectNodeLaunchTarget(root, "unrelated-service-name");
    assert.equal(path.resolve(target.workingDir), path.resolve(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectNodeLaunchTarget: picks the nested vite app as a web launch target", () => {
  const root = tmpRoot("detect-nested");
  try {
    writeJson(root, "package.json", { name: "repo-root", scripts: {} });
    const appDir = path.join(root, "project", "uploads", "stellar-shimmer-folio-main");
    writeJson(appDir, "package.json", VITE_APP);
    const target = detectNodeLaunchTarget(root, "stellar-shimmer-folio");
    assert.equal(path.resolve(target.workingDir), path.resolve(appDir));
    assert.equal(target.kind, "web");
    // Nested standalone app with no lockfile → npm, and the dev command binds host/port.
    assert.match(target.command, /npm run dev .*--host 0\.0\.0\.0 --port \$PORT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
