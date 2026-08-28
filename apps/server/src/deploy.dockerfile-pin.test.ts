import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileBuildType } from "./services/deploy.js";

function tmpRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `survhub-pin-${label}-`));
}

function withRoot(label: string, fn: (root: string) => void): void {
  const root = tmpRoot(label);
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A monorepo whose root is a node app but which also ships a worker image. */
function monorepoWithWorkerDockerfile(root: string): void {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  fs.mkdirSync(path.join(root, "worker"), { recursive: true });
  fs.writeFileSync(path.join(root, "worker", "Dockerfile"), "FROM scratch\n");
}

test("a docker service pinned to a subdirectory Dockerfile builds with docker", () => {
  withRoot("pinned", (root) => {
    monorepoWithWorkerDockerfile(root);
    // Detection only reads the repo root, which is a node app here.
    const detected = "node" as const;
    assert.equal(
      reconcileBuildType(detected, { type: "docker", dockerfile: "worker/Dockerfile" }, root),
      "docker"
    );
  });
});

test("a stale pin falls back to detection instead of failing the deploy", () => {
  withRoot("stale", (root) => {
    monorepoWithWorkerDockerfile(root);
    assert.equal(
      reconcileBuildType("node", { type: "docker", dockerfile: "gone/Dockerfile" }, root),
      "node"
    );
  });
});

test("the pin does not hijack a process service", () => {
  withRoot("process", (root) => {
    monorepoWithWorkerDockerfile(root);
    assert.equal(
      reconcileBuildType("node", { type: "process", dockerfile: "worker/Dockerfile" }, root),
      "node"
    );
  });
});

test("an unpinned docker service is left to detection", () => {
  withRoot("unpinned", (root) => {
    monorepoWithWorkerDockerfile(root);
    assert.equal(reconcileBuildType("node", { type: "docker", dockerfile: "" }, root), "node");
    assert.equal(reconcileBuildType("node", undefined, root), "node");
  });
});

// The pre-existing correction in the other direction must still hold: a process
// service with its own run command keeps the native pipeline even when the repo
// root has a Dockerfile.
test("a process service with a run command still overrides a root Dockerfile", () => {
  withRoot("downgrade", (root) => {
    fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "app", scripts: { start: "node ." } })
    );
    assert.equal(
      reconcileBuildType("docker", { type: "process", command: "npm start" }, root),
      "node"
    );
  });
});

test("a docker service is unaffected by the downgrade path", () => {
  withRoot("docker-keeps", (root) => {
    fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
    assert.equal(reconcileBuildType("docker", { type: "docker", command: "" }, root), "docker");
  });
});
