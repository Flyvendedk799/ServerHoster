import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  ensurePersistedPaths,
  resolvePersistedRelPaths,
  unlinkPersistedSymlinks,
  readPersistedConfig
} from "./services/persistence.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function seedService(ctx: Ctx, persistedConfig?: object): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at, persisted_paths_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "p1",
      "svc",
      "process",
      "node x.js",
      "/tmp",
      "",
      "",
      0,
      "stopped",
      1,
      0,
      5,
      "manual",
      nowIso(),
      nowIso(),
      persistedConfig ? JSON.stringify(persistedConfig) : null
    );
  return id;
}

/** Lay down a clone dir at projectsDir/<id> with the given relative files. */
function makeClone(ctx: Ctx, id: string, files: Record<string, string>): string {
  const dir = path.join(ctx.config.projectsDir, id);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("ensurePersistedPaths: seeds committed files into the volume and symlinks the dir", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { paths: ["app/static/images"] });
    const clone = makeClone(ctx, id, { "app/static/images/logo.png": "PNGDATA" });

    const linked = ensurePersistedPaths(ctx, id, clone);
    assert.deepEqual(linked, ["app/static/images"]);

    const inClone = path.join(clone, "app/static/images");
    assert.ok(fs.lstatSync(inClone).isSymbolicLink(), "in-clone path is now a symlink");

    const volFile = path.join(ctx.config.serviceDataDir, id, "persisted/app/static/images/logo.png");
    assert.equal(fs.readFileSync(volFile, "utf8"), "PNGDATA", "committed file seeded into the volume");
    // The committed file is still readable through the symlink.
    assert.equal(fs.readFileSync(path.join(inClone, "logo.png"), "utf8"), "PNGDATA");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensurePersistedPaths: PERSISTENT WINS — a deploy never overwrites a runtime file", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { paths: ["app/static/images"] });
    // Volume already holds an admin-edited image with the same name as a committed one.
    const volDir = path.join(ctx.config.serviceDataDir, id, "persisted/app/static/images");
    fs.mkdirSync(volDir, { recursive: true });
    fs.writeFileSync(path.join(volDir, "logo.png"), "ADMIN_EDITED");
    fs.writeFileSync(path.join(volDir, "uploaded.png"), "RUNTIME_UPLOAD");

    // A fresh deploy restores the committed (old) version of logo.png in the clone.
    const clone = makeClone(ctx, id, { "app/static/images/logo.png": "OLD_COMMITTED" });
    ensurePersistedPaths(ctx, id, clone);

    assert.equal(
      fs.readFileSync(path.join(volDir, "logo.png"), "utf8"),
      "ADMIN_EDITED",
      "the runtime/admin copy must survive the deploy — git must not overwrite it"
    );
    assert.equal(
      fs.readFileSync(path.join(volDir, "uploaded.png"), "utf8"),
      "RUNTIME_UPLOAD",
      "a runtime-only upload must survive"
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensurePersistedPaths: idempotent across repeated deploys, uploads persist", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { paths: ["uploads"] });
    const clone = makeClone(ctx, id, { "uploads/seed.txt": "SEED" });

    ensurePersistedPaths(ctx, id, clone);
    // Simulate a runtime upload written through the symlink.
    fs.writeFileSync(path.join(clone, "uploads/runtime.txt"), "LIVE");

    // Next deploy: unlink, restore committed tree, re-establish.
    unlinkPersistedSymlinks(ctx, id, clone);
    fs.mkdirSync(path.join(clone, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(clone, "uploads/seed.txt"), "SEED");
    const linked = ensurePersistedPaths(ctx, id, clone);

    assert.deepEqual(linked, ["uploads"]);
    assert.ok(fs.lstatSync(path.join(clone, "uploads")).isSymbolicLink());
    assert.equal(
      fs.readFileSync(path.join(clone, "uploads/runtime.txt"), "utf8"),
      "LIVE",
      "the runtime upload survives a second deploy"
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("resolvePersistedRelPaths: auto-detects conventional dirs, honors config + exclude", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { auto: true, paths: ["app/static/images"], exclude: ["media"] });
    const clone = makeClone(ctx, id, {
      "uploads/.keep": "",
      "media/.keep": "",
      "app/static/images/.keep": ""
    });
    const resolved = resolvePersistedRelPaths(ctx, id, clone);
    assert.ok(resolved.includes("uploads"), "auto-detects an existing conventional upload dir");
    assert.ok(resolved.includes("app/static/images"), "includes the configured custom path");
    assert.ok(!resolved.includes("media"), "excluded path is dropped even though it exists");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("resolvePersistedRelPaths: auto can be disabled", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { auto: false });
    const clone = makeClone(ctx, id, { "uploads/.keep": "" });
    assert.deepEqual(resolvePersistedRelPaths(ctx, id, clone), [], "no auto-detect when auto:false and no paths");
    assert.equal(readPersistedConfig(ctx, id).auto, false);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("normalizeRel safety: absolute and traversal paths are rejected", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, { auto: false, paths: ["../escape", "/etc/passwd", "ok/dir"] });
    const clone = makeClone(ctx, id, {});
    const resolved = resolvePersistedRelPaths(ctx, id, clone);
    assert.deepEqual(resolved, ["ok/dir"], "only the safe relative path is kept");
  } finally {
    await gracefulShutdown(ctx);
  }
});
