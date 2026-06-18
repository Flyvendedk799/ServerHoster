import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown, reconcileRuntimeStateOnBoot } from "./services/runtime.js";

function seedProcessService(ctx: Awaited<ReturnType<typeof buildApp>>, status: string, pgid: number | null): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at, runtime_pgid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "p1", "adopt-me", "process", "x", "/tmp", "", "", 0, status, 0, 0, 5, "manual", nowIso(), nowIso(), pgid);
  return id;
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

test("reconcileRuntimeStateOnBoot: adopts a surviving process (live pgid) instead of marking it stopped", async () => {
  if (process.platform === "win32") return; // pgid adoption is POSIX-only
  const ctx = await buildApp();
  // A detached child becomes its own process-group leader, so pid === pgid.
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pgid = child.pid!;
  try {
    // Simulates the post-restart state: the DB says "stopped" (the new server
    // doesn't track the old child) but the child is actually still alive.
    const id = seedProcessService(ctx, "stopped", pgid);
    await reconcileRuntimeStateOnBoot(ctx);
    const status = (ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(id) as { status: string })
      .status;
    assert.equal(status, "running", "a live surviving process should be adopted as running");
  } finally {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await gracefulShutdown(ctx);
  }
});

test("reconcileRuntimeStateOnBoot: a dead pgid is NOT adopted (stays stopped, pgid cleared)", async () => {
  if (process.platform === "win32") return;
  const ctx = await buildApp();
  try {
    // A pgid that surely isn't alive.
    const id = seedProcessService(ctx, "running", 2147480000);
    await reconcileRuntimeStateOnBoot(ctx);
    const row = ctx.db.prepare("SELECT status, runtime_pgid FROM services WHERE id = ?").get(id) as {
      status: string;
      runtime_pgid: number | null;
    };
    assert.equal(row.status, "stopped");
    assert.equal(row.runtime_pgid, null, "a stale pgid should be cleared");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("gracefulShutdown: leaves stop_with_hoster=0 process services running for adoption", async () => {
  if (process.platform === "win32") return;
  const ctx = await buildApp();
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const pgid = child.pid!;
  let id: string | null = null;
  try {
    id = nanoid();
    ctx.db
      .prepare(
        `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, stop_with_hoster, created_at, updated_at, runtime_pgid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        "p1",
        "survive-shutdown",
        "process",
        "node server.js",
        "/tmp",
        "",
        "",
        0,
        "running",
        1,
        0,
        5,
        "auto",
        0,
        nowIso(),
        nowIso(),
        pgid
      );
    ctx.runtimeProcesses.set(id, {
      process: child as any,
      serviceId: id,
      processGroupPid: pgid,
      instanceId: "test-durable"
    });
    await gracefulShutdown(ctx);
    assert.equal(processGroupAlive(pgid), true, "durable process should survive ServerHoster shutdown");
  } finally {
    if (id) ctx.db.prepare("DELETE FROM services WHERE id = ?").run(id);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await gracefulShutdown(ctx);
  }
});
