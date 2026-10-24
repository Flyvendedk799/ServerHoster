import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown, restartService, startService, stopService } from "./services/runtime.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

const posix = process.platform !== "win32";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function seedService(ctx: Ctx, command: string, port: number): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
       (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
       VALUES (?, 'p1', 'restart-me', 'process', ?, ?, '', '', ?, 'stopped', 1, 0, 5, 'manual', ?, ?)`
    )
    .run(id, command, os.tmpdir(), port, nowIso(), nowIso());
  return id;
}

/** Process groups holding a live process whose command line contains `marker`. */
function groupsWithMarker(marker: string): number[] {
  const out = execFileSync("ps", ["-axo", "pgid=,stat=,args="], { encoding: "utf8" });
  const groups = out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && !m[2].startsWith("Z") && m[3].includes(marker))
    .map((m) => Number(m[1]));
  return [...new Set(groups)];
}

function serviceRow(ctx: Ctx, id: string) {
  return ctx.db.prepare("SELECT status, restart_count FROM services WHERE id = ?").get(id) as {
    status: string;
    restart_count: number;
  };
}

function crashLogged(ctx: Ctx, id: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM logs WHERE service_id = ? AND message LIKE 'Service crashed%'")
    .get(id);
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(50);
  }
}

test("restart: exactly one live process and no crash-restart", { skip: !posix }, async () => {
  const ctx = await buildApp();
  const marker = `restart-${nanoid(8)}`;
  const id = seedService(ctx, `node -e "setInterval(() => {}, 1000)" ${marker}`, await freePort());
  try {
    await startService(ctx, id);
    const firstPid = ctx.runtimeProcesses.get(id)!.process.pid!;
    await restartService(ctx, id);
    const current = ctx.runtimeProcesses.get(id)!;
    assert.notEqual(current.process.pid, firstPid);

    // Past the 500ms exit-handling window and the first crash backoff (2s).
    await sleep(3000);

    assert.equal(ctx.runtimeProcesses.get(id), current, "the restarted instance must stay tracked");
    assert.deepEqual(groupsWithMarker(marker), [current.processGroupPid]);
    assert.equal(crashLogged(ctx, id), false, "the old instance's exit must not be treated as a crash");
    assert.deepEqual(serviceRow(ctx, id), { status: "running", restart_count: 0 });
  } finally {
    await stopService(ctx, id).catch(() => {});
    await gracefulShutdown(ctx);
  }
});

test("crash: a real crash of the tracked instance still auto-restarts", { skip: !posix }, async () => {
  const ctx = await buildApp();
  const marker = `crash-${nanoid(8)}`;
  const flag = path.join(os.tmpdir(), `${marker}.flag`);
  const script =
    "const fs = require('fs'); const f = process.argv[1];" +
    " if (!fs.existsSync(f)) { fs.writeFileSync(f, ''); process.exit(1); }" +
    " setInterval(() => {}, 1000);";
  const id = seedService(ctx, `node -e "${script}" ${flag} ${marker}`, await freePort());
  try {
    await startService(ctx, id);
    const crashed = ctx.runtimeProcesses.get(id)!;
    await waitFor(() => {
      const current = ctx.runtimeProcesses.get(id);
      return !!current && current !== crashed && serviceRow(ctx, id).status === "running";
    }, 8000);

    assert.equal(crashLogged(ctx, id), true);
    assert.equal(serviceRow(ctx, id).restart_count, 1);
    assert.deepEqual(groupsWithMarker(marker), [ctx.runtimeProcesses.get(id)!.processGroupPid]);
  } finally {
    await stopService(ctx, id).catch(() => {});
    fs.rmSync(flag, { force: true });
    await gracefulShutdown(ctx);
  }
});

test("stop: waits for the whole process group, including a sh -c grandchild", { skip: !posix }, async () => {
  const ctx = await buildApp();
  const marker = `stop-${nanoid(8)}`;
  const id = seedService(
    ctx,
    `sh -c 'node -e "setInterval(() => {}, 1000)" ${marker} & wait'`,
    await freePort()
  );
  try {
    await startService(ctx, id);
    const pgid = ctx.runtimeProcesses.get(id)!.processGroupPid!;
    await waitFor(() => groupsWithMarker(marker).length === 1, 3000);

    await stopService(ctx, id);

    assert.deepEqual(groupsWithMarker(marker), []);
    assert.equal(groupAlive(pgid), false);
    assert.equal(ctx.runtimeProcesses.has(id), false);
    await sleep(800);
    assert.equal(ctx.runtimeProcesses.has(id), false, "a stopped service must not be resurrected");
    assert.equal(serviceRow(ctx, id).status, "stopped");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test(
  "stop: gives SIGTERM a grace period, then SIGKILLs a process that ignores it",
  { skip: !posix },
  async () => {
    const ctx = await buildApp();
    const marker = `stubborn-${nanoid(8)}`;
    const id = seedService(
      ctx,
      `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" ${marker}`,
      await freePort()
    );
    try {
      await startService(ctx, id);
      await waitFor(() => groupsWithMarker(marker).length === 1, 3000);
      await sleep(300); // let node install its SIGTERM handler

      const startedAt = Date.now();
      await stopService(ctx, id);

      assert.ok(Date.now() - startedAt >= 4500, "SIGKILL must wait for the SIGTERM grace period");
      assert.deepEqual(groupsWithMarker(marker), []);
      assert.equal(serviceRow(ctx, id).status, "stopped");
    } finally {
      await gracefulShutdown(ctx);
    }
  }
);
