/**
 * findDeployDependents: which services get restarted after a service redeploys.
 *
 * A worker that runs from the app's checkout (e.g. `npm run worker` in the
 * app's folder) or inherits its env must restart after the app deploys, or it
 * keeps running the old code. Services built from the same repo are skipped
 * because they get their own deploy from the same push.
 */

import assert from "node:assert/strict";
import DatabaseSync from "better-sqlite3";
import test, { beforeEach, describe } from "node:test";

import { findDeployDependents } from "./services/deploy.js";
import type { AppContext } from "./types.js";

const SCHEMA = `
CREATE TABLE services (
  id TEXT PRIMARY KEY, working_dir TEXT, github_repo_url TEXT,
  env_from_service_id TEXT, depends_on TEXT
);
`;

let db: DatabaseSync.Database;
let ctx: AppContext;

function add(
  id: string,
  opts: { dir?: string; repo?: string; envFrom?: string; dependsOn?: string[] } = {}
): void {
  db.prepare(
    "INSERT INTO services (id, working_dir, github_repo_url, env_from_service_id, depends_on) VALUES (?, ?, ?, ?, ?)"
  ).run(
    id,
    opts.dir ?? null,
    opts.repo ?? null,
    opts.envFrom ?? null,
    opts.dependsOn ? JSON.stringify(opts.dependsOn) : null
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  ctx = { db } as unknown as AppContext;
  add("app", { dir: "/data/projects/app", repo: "https://github.com/acme/app" });
});

describe("findDeployDependents", () => {
  test("includes a worker sharing the app's checkout", () => {
    add("worker", { dir: "/data/projects/app" });
    add("sub", { dir: "/data/projects/app/apps/worker" });
    assert.deepEqual(findDeployDependents(ctx, "app").sort(), ["sub", "worker"]);
  });

  test("does not match a sibling folder with a shared prefix", () => {
    add("other", { dir: "/data/projects/app-two" });
    assert.deepEqual(findDeployDependents(ctx, "app"), []);
  });

  test("includes env inheritors and depends_on dependents", () => {
    add("envkid", { dir: "/data/projects/x", envFrom: "app" });
    add("dep", { dir: "/data/projects/y", dependsOn: ["app"] });
    assert.deepEqual(findDeployDependents(ctx, "app").sort(), ["dep", "envkid"]);
  });

  test("skips services deployed from the same repo (they deploy themselves)", () => {
    add("companion", { dir: "/data/projects/companion", repo: "https://www.github.com/Acme/app.git", envFrom: "app" });
    assert.deepEqual(findDeployDependents(ctx, "app"), []);
  });

  test("unknown or unrelated services yield nothing", () => {
    add("unrelated", { dir: "/data/projects/z", repo: "https://github.com/acme/z" });
    assert.deepEqual(findDeployDependents(ctx, "app"), []);
    assert.deepEqual(findDeployDependents(ctx, "missing"), []);
  });
});
