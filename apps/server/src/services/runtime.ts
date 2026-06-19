import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  appendDeploymentLog,
  broadcast,
  getService,
  getServiceEnv,
  insertLog,
  sanitizedHostEnv,
  serializeError,
  updateServiceStatus
} from "../lib/core.js";
import { nanoid } from "nanoid";
import type { AppContext, RuntimeProcess } from "../types.js";
import { createNotification } from "./notifications.js";

const exec = promisify(execFile);
import { buildConnectionString, getDatabase } from "./databases.js";
import { getResourceEnvForService } from "./resources/runtimeEnv.js";
import { getSetting, setSetting, deleteSetting } from "./settings.js";
import { ensurePersistedPaths, resolvePersistedDockerBinds } from "./persistence.js";
import { decryptSecret } from "../security.js";

type DockerRestartPolicy = "no" | "unless-stopped";

/**
 * Setting key holding the JSON list of service ids that were running when the
 * server last shut down gracefully. reconcileRuntimeStateOnBoot consumes it to
 * bring those services back regardless of start_mode — "it was serving traffic"
 * is a stronger signal of desired state than the manual/auto flag. Cleared once
 * consumed; an ungraceful crash falls back to the stale 'running' DB status.
 */
const SHUTDOWN_RUNNING_MARKER = "services_running_at_shutdown";

/**
 * Decide whether a non-adopted service should be (re)started during boot
 * reconcile. We restore services that were running at the last *graceful*
 * shutdown (marker) so a planned restart doesn't silently drop live services,
 * and otherwise honor an explicit auto start_mode. An ungraceful crash (stale
 * 'running' status, no marker) deliberately stays stopped — matching the
 * long-standing adoption contract — so a crash-looping service isn't relaunched
 * blindly on every boot.
 */
export function shouldRestoreServiceOnBoot(opts: {
  startMode?: string | null;
  wasRunningAtShutdown: boolean;
}): boolean {
  if (opts.wasRunningAtShutdown) return true;
  return opts.startMode === "auto";
}

/**
 * How long a process must stay up before we clear its crash counter. A service
 * that runs cleanly past this window earns a fresh set of restart attempts; one
 * that keeps crashing faster than this exhausts max_restarts and gives up.
 */
const RESTART_STABILITY_MS = 30_000;

/**
 * Merge project env, resource env, service env, and auto-injected database URLs.
 * Precedence (low → high):
 *   project env → active resource links → legacy linked DB URL → DATA_DIR → service env.
 * Service-level values always win so users can override project defaults,
 * system-managed resource env, and linked database auto-injection. Used by
 * both runtime and deploy — keep it the single env merge path.
 */
export function getServiceEnvWithLinks(ctx: AppContext, serviceId: string): Record<string, string> {
  const service = ctx.db
    .prepare("SELECT project_id, linked_database_id, type FROM services WHERE id = ?")
    .get(serviceId) as { project_id?: string; linked_database_id?: string; type?: string } | undefined;

  const projectEnv: Record<string, string> = {};
  if (service?.project_id) {
    const rows = ctx.db
      .prepare("SELECT key, value, is_secret FROM project_env_vars WHERE project_id = ?")
      .all(service.project_id) as Array<{ key: string; value: string; is_secret: number }>;
    for (const r of rows) {
      projectEnv[r.key] = r.is_secret ? decryptSecret(r.value, ctx.config.secretKey) : r.value;
    }
  }
  // A project-wide PORT must never leak into individual services: each service
  // has its own port column that the proxy and healthchecks target. A shared
  // project PORT would force every service onto one port and break routing.
  delete projectEnv.PORT;

  const serviceEnv = getServiceEnv(ctx, serviceId);
  // System-managed env from linked managed resources (local Supabase, managed
  // Postgres, …). Overrides project env, never service env.
  const resourceEnv = getResourceEnvForService(ctx, serviceId);
  const merged: Record<string, string> = { ...projectEnv, ...resourceEnv };

  if (service?.linked_database_id) {
    const db = getDatabase(ctx, service.linked_database_id);
    const envKey = db?.engine === "redis" ? "REDIS_URL" : "DATABASE_URL";
    if (db && !serviceEnv[envKey]) {
      const host = service.type === "docker" ? "host.docker.internal" : "localhost";
      merged[envKey] = buildConnectionString(db, host);
    }
  }

  // Every service gets a persistent DATA_DIR that survives redeploys (the git
  // clone is hard-reset to remote on every deploy, so data kept inside it —
  // e.g. a SQLite file — gets wiped). Docker services see it at /data via a
  // bind mount; process/static services get the host path directly. A service
  // env var named DATA_DIR overrides this default.
  if (!serviceEnv.DATA_DIR && !merged.DATA_DIR) {
    merged.DATA_DIR = service?.type === "docker" ? "/data" : serviceDataDirFor(ctx, serviceId);
  }
  return { ...merged, ...serviceEnv };
}

/** Host path of a service's persistent data dir; created on first use. */
export function serviceDataDirFor(ctx: AppContext, serviceId: string): string {
  const dir = path.join(ctx.config.serviceDataDir, serviceId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* surfaced when the service actually writes */
  }
  return dir;
}

async function pullImage(ctx: AppContext, image: string): Promise<void> {
  const stream = await ctx.docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    ctx.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
}

function shouldPullImage(image: string): boolean {
  return !image.startsWith("survhub-build-");
}

/**
 * Guard against starting a docker service whose locally-built image was pruned
 * or never finished building. Without this the daemon raises a cryptic
 * "No such image" 404 at container-create time; here we fail early with an
 * actionable message. Registry images are skipped — the pull path covers them.
 */
export async function ensureLocalImagePresent(
  docker: { getImage: (image: string) => { inspect: () => Promise<unknown> } },
  image: string
): Promise<void> {
  if (shouldPullImage(image)) return;
  try {
    await docker.getImage(image).inspect();
  } catch {
    throw new Error(
      `Docker image "${image}" is missing locally — it was removed (e.g. docker prune) or never finished building. ` +
        `Redeploy this service to rebuild the image, then start it again.`
    );
  }
}

async function getContainerPort(ctx: AppContext, image: string, hostPort: number): Promise<number> {
  if (!hostPort) return 0;
  try {
    const imageInfo = await ctx.docker.getImage(image).inspect();
    const exposedPorts = Object.keys(imageInfo.Config?.ExposedPorts ?? {})
      .map((key) => Number(key.split("/")[0]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (exposedPorts.includes(hostPort)) return hostPort;
    if (exposedPorts.length === 1) return exposedPorts[0];
  } catch {
    // If image inspection fails, fall back to the user-facing port.
  }
  return hostPort;
}

function desiredDockerRestartPolicy(stopWithHoster: unknown): DockerRestartPolicy {
  return Number(stopWithHoster ?? 1) ? "no" : "unless-stopped";
}

async function ensureDockerRestartPolicy(
  ctx: AppContext,
  serviceId: string,
  container: { inspect: () => Promise<any>; update: (opts: any) => Promise<unknown> },
  restartPolicyName: DockerRestartPolicy,
  info?: any
): Promise<void> {
  const containerInfo = info ?? (await container.inspect());
  const currentPolicy = containerInfo.HostConfig?.RestartPolicy?.Name ?? "no";
  if (currentPolicy === restartPolicyName) return;
  try {
    await container.update({ RestartPolicy: { Name: restartPolicyName } } as any);
    insertLog(ctx, serviceId, "info", `Updated Docker restart policy to ${restartPolicyName}.`);
  } catch (error) {
    insertLog(ctx, serviceId, "warn", `Could not update Docker restart policy: ${serializeError(error)}`);
  }
}

async function getOrCreateContainer(
  ctx: AppContext,
  serviceId: string,
  image: string,
  command: string,
  hostPort: number,
  containerPort: number,
  envList: string[],
  restartPolicyName: DockerRestartPolicy,
  persistedBinds: string[] = []
) {
  const containerName = `survhub-${serviceId}`;
  const exposedPort = containerPort ? `${containerPort}/tcp` : undefined;
  const agentHomeHostPath = path.join(ctx.config.agentHomeDir, "services", serviceId, "docker-home");
  fs.mkdirSync(agentHomeHostPath, { recursive: true });
  const agentHomeBind = `${agentHomeHostPath}:/home/survhub-agent`;
  // Persistent data: the host-side service-data dir mounts at /data so anything
  // the container keeps there (SQLite, uploads) survives recreation/redeploys.
  // DATA_DIR=/data is injected via getServiceEnvWithLinks.
  const dataBind = `${serviceDataDirFor(ctx, serviceId)}:/data`;
  // Per-path persisted binds (persistence.ts): map configured container paths to
  // host dirs under the data volume so uploads written there survive redeploys.
  const binds = [agentHomeBind, dataBind, ...persistedBinds];
  const extraHosts = process.platform === "linux" ? ["host.docker.internal:host-gateway"] : undefined;
  const createConfig = {
    Image: image,
    name: containerName,
    Cmd: command ? command.split(/\s+/) : undefined,
    Env: envList,
    ExposedPorts: exposedPort ? { [exposedPort]: {} } : undefined,
    Healthcheck: exposedPort ? undefined : { Test: ["NONE"] },
    HostConfig: {
      PortBindings: exposedPort && hostPort ? { [exposedPort]: [{ HostPort: String(hostPort) }] } : undefined,
      RestartPolicy: { Name: restartPolicyName },
      Binds: binds,
      ExtraHosts: extraHosts
    }
  };

  try {
    const existing = ctx.docker.getContainer(containerName);
    const info = await existing.inspect();
    const state = info.State?.Status;
    // A container mid-removal or dead can't be (re)started — Docker answers 409
    // "marked for removal" or 404 if it vanishes. Drop it and recreate fresh
    // rather than returning a corpse the caller will fail to start.
    if (state === "removing" || state === "dead") {
      try {
        await existing.remove({ force: true });
      } catch {
        /* already gone */
      }
    } else {
      const bindings = exposedPort ? info.HostConfig?.PortBindings?.[exposedPort] : undefined;
      const mappedToRequestedPort =
        !hostPort ||
        bindings?.some((binding: { HostPort?: string }) => binding.HostPort === String(hostPort));
      // A pre-DATA_DIR container lacks the /data mount, but its env now claims
      // DATA_DIR=/data — data written there would die with the container. Treat
      // a missing data bind (or a newly-added persisted bind) like a port
      // mismatch: recreate so the mounts match the current config.
      const existingBinds = info.HostConfig?.Binds ?? [];
      const hasDataBind = existingBinds.includes(dataBind);
      const hasAllPersistedBinds = persistedBinds.every((b) => existingBinds.includes(b));
      if (mappedToRequestedPort && hasDataBind && hasAllPersistedBinds) {
        await ensureDockerRestartPolicy(ctx, serviceId, existing, restartPolicyName, info);
        return existing;
      }
      try {
        await existing.stop({ t: 10 });
      } catch {}
      await existing.remove({ force: true });
      insertLog(
        ctx,
        serviceId,
        "info",
        hasDataBind
          ? `Recreated Docker container to publish host port ${hostPort} to container port ${containerPort}.`
          : "Recreated Docker container to attach the persistent /data mount."
      );
    }
  } catch {
    // Container does not exist yet.
  }

  try {
    return await ctx.docker.createContainer(createConfig);
  } catch (error) {
    // A leftover container holding the name (e.g. one we couldn't inspect above)
    // makes create 409 "name already in use" — force-remove it and retry once.
    if (/already in use|name.*in use/i.test(serializeError(error))) {
      try {
        await ctx.docker.getContainer(containerName).remove({ force: true });
      } catch {
        /* already gone */
      }
      return await ctx.docker.createContainer(createConfig);
    }
    throw error;
  }
}

async function waitForContainerReadiness(
  ctx: AppContext,
  serviceId: string,
  container: Awaited<ReturnType<typeof getOrCreateContainer>>
): Promise<void> {
  const deadline = Date.now() + 30000;
  let lastHealth = "";

  while (Date.now() < deadline) {
    const info = await container.inspect();
    const health = info.State?.Health?.Status;
    if (health && health !== lastHealth) {
      lastHealth = health;
      insertLog(ctx, serviceId, health === "unhealthy" ? "warn" : "info", `Docker healthcheck: ${health}`);
      broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "healthcheck", status: health });
    }
    if (health === "healthy") return;
    if (!health && info.State?.Running) return;
    if (info.State?.Status === "exited" || info.State?.Status === "dead") {
      throw new Error(`Container exited during startup (${info.State.Status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  insertLog(
    ctx,
    serviceId,
    "warn",
    "Docker container started, but health did not report healthy within 30s."
  );
}

export async function withLock<T>(ctx: AppContext, serviceId: string, task: () => Promise<T>): Promise<T> {
  if (ctx.actionLocks.has(serviceId)) throw new Error("Service action already in progress");
  ctx.actionLocks.add(serviceId);
  return task().finally(() => ctx.actionLocks.delete(serviceId));
}

async function hasLiveProcessGroup(processGroupPid: number | undefined): Promise<boolean> {
  if (!processGroupPid || process.platform === "win32") return false;
  try {
    const { stdout } = await exec("ps", ["-axo", "pgid="], { timeout: 1500, maxBuffer: 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .some((pgid) => pgid === processGroupPid);
  } catch {
    return false;
  }
}

/** Clear the persisted process-group id for a service. */
function clearRuntimePgid(ctx: AppContext, serviceId: string): void {
  try {
    ctx.db.prepare("UPDATE services SET runtime_pgid = NULL WHERE id = ?").run(serviceId);
  } catch {
    /* column may not exist on a very old DB */
  }
}

/** SIGKILL a persisted process group (a survivor not tracked in-memory). */
function killPersistedPgid(ctx: AppContext, serviceId: string): void {
  if (process.platform === "win32") return;
  const row = ctx.db.prepare("SELECT runtime_pgid FROM services WHERE id = ?").get(serviceId) as
    | { runtime_pgid?: number | null }
    | undefined;
  const pgid = row?.runtime_pgid;
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** The process-group id of a pid (POSIX), or null if it can't be resolved. */
async function pgidOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await exec("ps", ["-o", "pgid=", "-p", String(pid)], {
      timeout: 1500,
      maxBuffer: 1024 * 1024
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Clear a port the force-restart path needs — but ONLY by killing a process that
 * belongs to THIS service's own process group (`ownPgid`). Killing whatever
 * happens to LISTEN on the port (the old behaviour) meant force-restarting
 * service A could SIGKILL service B, or an unrelated host daemon, that held A's
 * recorded port. A holder we can't prove is ours is left alone with a warning.
 */
async function freeServicePort(
  ctx: AppContext,
  serviceId: string,
  port: number | undefined,
  ownPgid: number | null
): Promise<void> {
  if (!port || process.platform === "win32") return;
  let stdout = "";
  try {
    ({ stdout } = await exec("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      timeout: 2000,
      maxBuffer: 1024 * 1024
    }));
  } catch {
    return; // nothing listening / lsof unavailable
  }
  for (const pid of stdout
    .split(/\s+/)
    .map((s) => Number(s.trim()))
    .filter(Boolean)) {
    if (pid === process.pid) continue; // never kill ourselves
    const pgid = await pgidOf(pid);
    if (ownPgid && pgid === ownPgid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    } else {
      insertLog(
        ctx,
        serviceId,
        "warn",
        `Port ${port} is held by an unmanaged process (pid ${pid}); leaving it alone to avoid killing another service. Free it manually if the restart fails.`
      );
    }
  }
}

/** Reject if `promise` hasn't settled within `ms`; clears its timer either way. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * SIGKILL a runtime immediately — no SIGTERM grace period. Used by the
 * force-stop path to recover a process that ignored or stalled on a graceful
 * stop. Kills the whole process group when we have one, else the direct child.
 */
function killRuntimeProcessNow(runtime: {
  process: { kill(signal?: NodeJS.Signals): boolean };
  processGroupPid?: number;
}): void {
  if (process.platform !== "win32" && runtime.processGroupPid) {
    try {
      process.kill(-runtime.processGroupPid, "SIGKILL");
      return;
    } catch {
      /* process group already exited — fall back to the direct child */
    }
  }
  try {
    runtime.process.kill("SIGKILL");
  } catch {
    /* process already exited */
  }
}

function terminateRuntimeProcess(runtime: {
  process: { kill(signal?: NodeJS.Signals): boolean };
  processGroupPid?: number;
}): void {
  if (process.platform !== "win32" && runtime.processGroupPid) {
    try {
      process.kill(-runtime.processGroupPid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-runtime.processGroupPid!, "SIGKILL");
        } catch {
          /* process group already exited */
        }
      }, 5000);
      return;
    } catch {
      /* fall back to the direct child below */
    }
  }
  try {
    runtime.process.kill("SIGTERM");
    setTimeout(() => {
      try {
        runtime.process.kill("SIGKILL");
      } catch {
        /* process already exited */
      }
    }, 5000);
  } catch {
    /* process already exited */
  }
}

async function startProcessService(
  ctx: AppContext,
  serviceId: string,
  options: { resetRestartCount?: boolean } = {}
): Promise<void> {
  // resetRestartCount is true for explicit/user starts and false on the
  // auto-restart path — otherwise the counter resets to 0 every crash cycle and
  // max_restarts is never reached, producing an endless "attempt 1" loop.
  const { resetRestartCount = true } = options;
  const service = getService(ctx, serviceId);
  if (ctx.runtimeProcesses.has(serviceId)) return;
  if (service.type !== "process" && service.type !== "static")
    throw new Error("Service is not a process service");

  const command = String(service.command ?? "").trim();
  if (!command) throw new Error("Missing command for service");
  const cwd = String(service.working_dir || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

  // Re-establish persisted-upload symlinks on start too, so services adopted or
  // started without a redeploy still get their upload dirs backed by the volume.
  // Keyed off the clone root (where repo-relative persisted paths live).
  const cloneDir = path.join(ctx.config.projectsDir, serviceId);
  if (fs.existsSync(cloneDir)) {
    ensurePersistedPaths(ctx, serviceId, cloneDir, (rel, err) =>
      insertLog(ctx, serviceId, "warn", `Persistent uploads: could not link ${rel}: ${serializeError(err)}`)
    );
  }

  updateServiceStatus(ctx, serviceId, "starting");
  insertLog(ctx, serviceId, "info", `Starting process service from ${cwd}`);
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "starting", message: `Starting ${command}` });
  ctx.manuallyStopped.delete(serviceId);
  const serviceEnvFromLinks = getServiceEnvWithLinks(ctx, serviceId);
  const portEnv = service.port && !serviceEnvFromLinks.PORT ? { PORT: String(service.port) } : {};
  // Nudge frameworks that read HOST (e.g. CRA, some Node servers) to bind all
  // interfaces so the proxy/tunnel can reach them — without overriding an
  // explicit service-level HOST.
  const hostEnv = serviceEnvFromLinks.HOST ? {} : { HOST: "0.0.0.0" };
  const child = spawn(command, {
    cwd,
    // sanitizedHostEnv() omits the control-plane secrets (SURVHUB_SECRET_KEY et
    // al.) so a deployed app can't read the master key that decrypts every other
    // service's data. SURVHUB_SERVICE_ID marks the process group as ours so the
    // port/pgid kills below can confirm ownership before SIGKILL.
    env: {
      ...sanitizedHostEnv(),
      SURVHUB_SERVICE_ID: serviceId,
      ...portEnv,
      ...hostEnv,
      ...serviceEnvFromLinks
    },
    shell: true,
    detached: process.platform !== "win32"
  });
  const instanceId = nanoid();
  const runtime: RuntimeProcess = { process: child, serviceId, processGroupPid: child.pid, instanceId };
  ctx.runtimeProcesses.set(serviceId, runtime);
  // Persist the process-group id so a child that survives a ServerHoster restart
  // (detached) can be adopted on boot instead of mis-shown as stopped.
  ctx.db.prepare("UPDATE services SET runtime_pgid = ? WHERE id = ?").run(child.pid ?? null, serviceId);
  if (resetRestartCount) {
    ctx.db.prepare("UPDATE services SET restart_count = 0 WHERE id = ?").run(serviceId);
  }
  updateServiceStatus(ctx, serviceId, "running");
  insertLog(ctx, serviceId, "info", `Started command: ${command}`);

  // Once this instance has stayed up past the stability window, clear the crash
  // counter so a later crash gets a fresh set of attempts. Guarded by instanceId
  // so a process that was already replaced can't reset a newer instance's count.
  runtime.stabilityTimer = setTimeout(() => {
    const current = ctx.runtimeProcesses.get(serviceId);
    if (current?.instanceId === instanceId) {
      ctx.db.prepare("UPDATE services SET restart_count = 0 WHERE id = ?").run(serviceId);
    }
  }, RESTART_STABILITY_MS);

  // Auto-start quick tunnel if enabled (dynamic import avoids circular dependency)
  const qtRow = ctx.db
    .prepare("SELECT quick_tunnel_enabled, port FROM services WHERE id = ?")
    .get(serviceId) as { quick_tunnel_enabled?: number; port?: number } | undefined;
  if (qtRow?.quick_tunnel_enabled && qtRow.port) {
    import("./cloudflare.js")
      .then(({ startQuickTunnel }) => {
        try {
          startQuickTunnel(ctx, serviceId, qtRow.port!);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore */
      });
  }

  // Buffer the tail of this instance's output so a crash-on-start (the
  // better-sqlite3 / "Cannot find module" case) can surface its REASON on the
  // deployment screen, not just the live logs.
  let startupBuffer = "";
  const captureStartup = (s: string) => {
    startupBuffer = (startupBuffer + s).slice(-16384);
  };
  child.stdout.on("data", (d) => {
    const s = d.toString();
    captureStartup(s);
    insertLog(ctx, serviceId, "info", s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    captureStartup(s);
    insertLog(ctx, serviceId, "error", s);
  });
  child.on("exit", (code) => {
    clearTimeout(runtime.stabilityTimer);
    const current = ctx.runtimeProcesses.get(serviceId);
    // Stale exit: a newer instance already replaced this one (e.g. via restart).
    // Ignore it so a dead child can't flip the live instance's status or queue a
    // duplicate restart.
    if (current && current.instanceId !== instanceId) return;
    const cfg = ctx.db
      .prepare(
        "SELECT auto_restart, restart_count, max_restarts, start_mode, stop_with_hoster FROM services WHERE id = ?"
      )
      .get(serviceId) as
      | {
          auto_restart: number;
          restart_count: number;
          max_restarts: number;
          start_mode?: string | null;
          stop_with_hoster?: number | null;
        }
      | undefined;
    if (!cfg) return;
    if (ctx.manuallyStopped.has(serviceId)) {
      ctx.runtimeProcesses.delete(serviceId);
      ctx.manuallyStopped.delete(serviceId);
      clearRuntimePgid(ctx, serviceId); // dead → don't carry a stale pgid into the recycle window
      updateServiceStatus(ctx, serviceId, "stopped", code ?? 0);
      return;
    }
    setTimeout(() => {
      void (async () => {
        // A stop issued during this 500ms window must win — don't resurrect a
        // service the user just stopped.
        if (ctx.manuallyStopped.has(serviceId)) {
          ctx.runtimeProcesses.delete(serviceId);
          ctx.manuallyStopped.delete(serviceId);
          clearRuntimePgid(ctx, serviceId);
          updateServiceStatus(ctx, serviceId, "stopped", code ?? 0);
          return;
        }
        const childRuntime = runtime ?? ctx.runtimeProcesses.get(serviceId);
        if ((code ?? 0) === 0 && (await hasLiveProcessGroup(childRuntime?.processGroupPid))) {
          updateServiceStatus(ctx, serviceId, "running", 0);
          insertLog(
            ctx,
            serviceId,
            "info",
            "Launcher exited cleanly; adopted the remaining child process group as the running service."
          );
          return;
        }
        ctx.runtimeProcesses.delete(serviceId);
        // The launcher's group is gone (not adopted above); drop the stale pgid so
        // a later kill can't hit a recycled one. A restart re-records a fresh pgid.
        clearRuntimePgid(ctx, serviceId);
        // On the FIRST failure of this deploy cycle, record why on the deployment
        // so the user sees the crash reason on the deploy screen, not a silent loop.
        if ((code ?? 0) !== 0 && cfg.restart_count === 0 && startupBuffer.trim()) {
          appendDeploymentLog(
            ctx,
            serviceId,
            `Service exited (code ${code}) shortly after start:\n${startupBuffer.slice(-2000)}`
          );
        }
        const alwaysOn = cfg.start_mode === "auto" && Number(cfg.stop_with_hoster ?? 1) === 0;
        if (cfg.auto_restart && (alwaysOn || cfg.restart_count < cfg.max_restarts)) {
          const nextCount = cfg.restart_count + 1;
          ctx.db.prepare("UPDATE services SET restart_count = ? WHERE id = ?").run(nextCount, serviceId);
          const backoffMs = Math.min(30000, 1000 * Math.pow(2, nextCount));
          updateServiceStatus(ctx, serviceId, "crashed", code ?? 1);
          insertLog(
            ctx,
            serviceId,
            "warn",
            `Service crashed. Restart attempt ${nextCount} in ${backoffMs}ms.`
          );
          const serviceName = String(getService(ctx, serviceId).name ?? serviceId);
          createNotification(ctx, {
            kind: "service_crash",
            severity: "warning",
            title: `Service crashed: ${serviceName}`,
            body: alwaysOn
              ? `Exit code ${code}. Always on is enabled; restart attempt ${nextCount} in ${backoffMs}ms.`
              : `Exit code ${code}. Restart attempt ${nextCount}/${cfg.max_restarts} in ${backoffMs}ms.`,
            serviceId
          });
          setTimeout(() => {
            void withLock(ctx, serviceId, () =>
              startProcessService(ctx, serviceId, { resetRestartCount: false })
            ).catch((error) => {
              insertLog(ctx, serviceId, "error", `Restart failed: ${serializeError(error)}`);
              updateServiceStatus(ctx, serviceId, "crashed");
            });
          }, backoffMs);
          return;
        }
        updateServiceStatus(ctx, serviceId, "stopped", code ?? 1);
        insertLog(ctx, serviceId, "warn", "Service stopped.");
        if ((code ?? 0) !== 0) {
          const serviceName = String(getService(ctx, serviceId).name ?? serviceId);
          createNotification(ctx, {
            kind: "service_crash",
            severity: "error",
            title: `Service stopped abnormally: ${serviceName}`,
            body: `Exit code ${code}. Auto-restart exhausted or disabled.`,
            serviceId
          });
        }
      })().catch((error) => {
        insertLog(ctx, serviceId, "error", `Exit handling failed: ${serializeError(error)}`);
        ctx.runtimeProcesses.delete(serviceId);
        updateServiceStatus(ctx, serviceId, "crashed", code ?? 1);
      });
    }, 500);
  });
}

async function startDockerService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  if (service.type !== "docker") throw new Error("Service is not a docker service");
  const image = String(service.docker_image || "alpine:latest");
  if (!service.docker_image) {
    throw new Error(
      "Docker image is not available for this service yet. Redeploy it now that Docker is installed so LocalSURV can build the image."
    );
  }
  const command = String(service.command || "").trim();
  const port = Number(service.port || 0);
  const dockerServiceEnv = getServiceEnvWithLinks(ctx, serviceId);
  const restartPolicyName = desiredDockerRestartPolicy(service.stop_with_hoster);

  updateServiceStatus(ctx, serviceId, "starting");
  insertLog(ctx, serviceId, "info", `Starting Docker service with image ${image}`);
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "starting", image, port });
  // Mirror the process path: a (re)start clears any lingering stop intent so a
  // prior force/stop doesn't leave a stale manuallyStopped entry for this id.
  ctx.manuallyStopped.delete(serviceId);

  if (shouldPullImage(image)) {
    try {
      insertLog(ctx, serviceId, "info", `Pulling Docker image ${image}...`);
      broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "pulling", image });
      await pullImage(ctx, image);
    } catch (error) {
      insertLog(ctx, serviceId, "warn", `Image pull skipped for ${image}: ${serializeError(error)}`);
    }
  }
  await ensureLocalImagePresent(ctx.docker, image);
  const containerPort = await getContainerPort(ctx, image, port);
  if (containerPort && !dockerServiceEnv.PORT) dockerServiceEnv.PORT = String(containerPort);
  const envList = Object.entries(dockerServiceEnv).map(([k, v]) => `${k}=${v}`);
  if (port && containerPort && port !== containerPort) {
    insertLog(ctx, serviceId, "info", `Publishing local port ${port} to container port ${containerPort}.`);
  }
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "container", image, port, containerPort });
  const persistedBinds = resolvePersistedDockerBinds(
    ctx,
    serviceId,
    path.join(ctx.config.projectsDir, serviceId)
  ).map((b) => b.bind);
  if (persistedBinds.length) {
    insertLog(ctx, serviceId, "info", `Persisted upload mounts: ${persistedBinds.join(", ")}`);
  }
  let container = await getOrCreateContainer(
    ctx,
    serviceId,
    image,
    command,
    port,
    containerPort,
    envList,
    restartPolicyName,
    persistedBinds
  );
  try {
    await container.start();
  } catch (error) {
    const msg = serializeError(error);
    const sc = (error as { statusCode?: number }).statusCode;
    if (msg.includes("already started")) {
      // already running — fine
    } else if (sc === 409 || sc === 404 || /marked for removal|no such container/i.test(msg)) {
      // The container went bad between create and start (mid-removal / vanished).
      // Force-remove any leftover by name, recreate a fresh one, and start it.
      insertLog(ctx, serviceId, "warn", `Container could not be started (${msg}); recreating a fresh one.`);
      try {
        await ctx.docker.getContainer(`survhub-${serviceId}`).remove({ force: true });
      } catch {
        /* already gone */
      }
      container = await getOrCreateContainer(
        ctx,
        serviceId,
        image,
        command,
        port,
        containerPort,
        envList,
        restartPolicyName
      );
      await container.start();
    } else {
      throw error;
    }
  }
  await waitForContainerReadiness(ctx, serviceId, container);
  updateServiceStatus(ctx, serviceId, "running");
  insertLog(ctx, serviceId, "info", `Docker container running with image ${image}`);
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "live", image, port, containerPort });

  // Auto-start quick tunnel if enabled
  const qtRowDocker = ctx.db
    .prepare("SELECT quick_tunnel_enabled, port FROM services WHERE id = ?")
    .get(serviceId) as { quick_tunnel_enabled?: number; port?: number } | undefined;
  if (qtRowDocker?.quick_tunnel_enabled && qtRowDocker.port) {
    import("./cloudflare.js")
      .then(({ startQuickTunnel }) => {
        try {
          startQuickTunnel(ctx, serviceId, qtRowDocker.port!);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore */
      });
  }
}

export async function stopService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  ctx.manuallyStopped.add(serviceId);
  updateServiceStatus(ctx, serviceId, "stopping");
  insertLog(ctx, serviceId, "info", "Stopping service...");
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "stopping" });

  // Stop quick tunnel if running
  import("./cloudflare.js")
    .then(({ stopQuickTunnel }) => {
      try {
        stopQuickTunnel(ctx, serviceId);
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* ignore */
    });
  if (service.type === "docker") {
    const container = ctx.docker.getContainer(`survhub-${serviceId}`);
    try {
      await container.stop({ t: 10 });
    } catch {}
    try {
      await container.remove({ force: false });
    } catch {}
  } else {
    const runtime = ctx.runtimeProcesses.get(serviceId);
    if (runtime) {
      terminateRuntimeProcess(runtime);
      ctx.runtimeProcesses.delete(serviceId);
    }
    // Also kill an adopted survivor (tracked only via the persisted pgid, e.g.
    // a detached child carried across a ServerHoster restart).
    killPersistedPgid(ctx, serviceId);
    clearRuntimePgid(ctx, serviceId);
  }
  updateServiceStatus(ctx, serviceId, "stopped", 0);
  insertLog(ctx, serviceId, "info", "Service stopped.");
}

async function startServiceRuntime(ctx: AppContext, serviceId: string): Promise<void> {
  // Start dependencies first (already-running ones are skipped).
  await startDependencies(ctx, serviceId, new Set());
  const service = getService(ctx, serviceId);
  if (service.type === "docker") {
    await startDockerService(ctx, serviceId);
  } else {
    await startProcessService(ctx, serviceId);
  }
}

export async function startService(ctx: AppContext, serviceId: string): Promise<void> {
  insertLog(ctx, serviceId, "info", "Start requested.");
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "queued", action: "start" });
  await withLock(ctx, serviceId, () => startServiceRuntime(ctx, serviceId));
}

export function parseDependsOn(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function startDependencies(ctx: AppContext, serviceId: string, visiting: Set<string>): Promise<void> {
  if (visiting.has(serviceId)) {
    throw new Error(`Dependency cycle detected at service ${serviceId}`);
  }
  visiting.add(serviceId);
  const row = ctx.db.prepare("SELECT depends_on FROM services WHERE id = ?").get(serviceId) as
    | { depends_on?: string }
    | undefined;
  const deps = parseDependsOn(row?.depends_on);
  for (const depId of deps) {
    const dep = ctx.db.prepare("SELECT id, status FROM services WHERE id = ?").get(depId) as
      | { id: string; status: string }
      | undefined;
    if (!dep) {
      insertLog(ctx, serviceId, "warn", `Dependency ${depId} not found — skipping`);
      continue;
    }
    if (dep.status === "running") continue;
    insertLog(ctx, serviceId, "info", `Starting dependency ${depId}...`);
    // Recurse through dependency tree, then start the dep itself.
    await startDependencies(ctx, depId, visiting);
    const svc = getService(ctx, depId);
    await withLock(ctx, depId, async () => {
      if (svc.type === "docker") await startDockerService(ctx, depId);
      else await startProcessService(ctx, depId);
    });
  }
  visiting.delete(serviceId);
}

/**
 * Return service IDs that list `serviceId` in their `depends_on` array.
 * Used when stopping a service to warn about downstream impact.
 */
export function getDependents(ctx: AppContext, serviceId: string): string[] {
  const rows = ctx.db.prepare("SELECT id, depends_on FROM services").all() as Array<{
    id: string;
    depends_on?: string;
  }>;
  return rows.filter((r) => parseDependsOn(r.depends_on).includes(serviceId)).map((r) => r.id);
}

export async function restartService(ctx: AppContext, serviceId: string): Promise<void> {
  insertLog(ctx, serviceId, "info", "Restart requested.");
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "queued", action: "restart" });
  await withLock(ctx, serviceId, async () => {
    await stopService(ctx, serviceId);
    await startServiceRuntime(ctx, serviceId);
  });
}

/**
 * Hard-stop a service without waiting on graceful shutdown. Unlike
 * {@link stopService} this SIGKILLs the process immediately and force-removes
 * Docker containers, and every teardown step is time-bounded so a wedged
 * process or unresponsive Docker daemon can't pin the service at "stopping".
 * Internal bookkeeping is always cleared even if a teardown step fails.
 */
export async function forceStopService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  ctx.manuallyStopped.add(serviceId);
  updateServiceStatus(ctx, serviceId, "stopping");
  insertLog(ctx, serviceId, "warn", "Force stop requested — killing service immediately.");
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "stopping" });

  // Best-effort: tear down any quick tunnel (dynamic import avoids a cycle).
  import("./cloudflare.js")
    .then(({ stopQuickTunnel }) => {
      try {
        stopQuickTunnel(ctx, serviceId);
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* ignore */
    });

  if (service.type === "docker") {
    const container = ctx.docker.getContainer(`survhub-${serviceId}`);
    // force-remove SIGKILLs and removes the container in a single call.
    try {
      await withTimeout(container.remove({ force: true }), 12000, "Docker force-remove");
    } catch (error) {
      insertLog(ctx, serviceId, "warn", `Force-remove of container failed: ${serializeError(error)}`);
    }
  } else {
    const runtime = ctx.runtimeProcesses.get(serviceId);
    if (runtime) killRuntimeProcessNow(runtime);
    // Capture our own process group BEFORE clearing it, so the port sweep can
    // confirm any remaining port-holder is ours (and not another service) before
    // SIGKILL. Kill our adopted survivor by its persisted pgid first.
    const ownPgid =
      (
        ctx.db.prepare("SELECT runtime_pgid FROM services WHERE id = ?").get(serviceId) as
          | { runtime_pgid?: number | null }
          | undefined
      )?.runtime_pgid ?? null;
    killPersistedPgid(ctx, serviceId);
    const port = Number(service.port ?? 0);
    if (port) {
      await freeServicePort(ctx, serviceId, port, ownPgid);
      insertLog(ctx, serviceId, "info", `Checked port ${port} before restart.`);
    }
    clearRuntimePgid(ctx, serviceId);
  }
  ctx.runtimeProcesses.delete(serviceId);
  updateServiceStatus(ctx, serviceId, "stopped", 0);
  insertLog(ctx, serviceId, "info", "Service force-stopped.");
}

/**
 * Recover a wedged service: break any stuck action lock, hard-kill the current
 * runtime, then start it again. The lock is deliberately cleared first — the
 * whole point of a force restart is to rescue a service stuck mid-transition
 * (e.g. pinned at "stopping") where a held lock would otherwise reject every
 * normal start/stop/restart with "Service action already in progress".
 */
export async function forceRestartService(ctx: AppContext, serviceId: string): Promise<void> {
  // Validate existence up front so a bad id fails before we break the lock.
  getService(ctx, serviceId);
  if (ctx.actionLocks.delete(serviceId)) {
    insertLog(ctx, serviceId, "warn", "Force restart cleared a stuck action lock.");
  }
  insertLog(ctx, serviceId, "info", "Force restart requested.");
  broadcast(ctx, { type: "service_lifecycle", serviceId, stage: "queued", action: "restart" });
  await withLock(ctx, serviceId, async () => {
    await forceStopService(ctx, serviceId);
    await startServiceRuntime(ctx, serviceId);
  });
}

/**
 * Walk Docker and return service IDs whose `survhub-<id>` container is
 * currently running. Adoption-only: containers in any other state
 * ("exited", "paused", etc.) are excluded — those should sync as "stopped".
 */
async function listLiveAdoptableContainers(ctx: AppContext): Promise<Set<string>> {
  const live = new Set<string>();
  let containers: Array<{ Names?: string[]; State?: string }>;
  try {
    containers = (await ctx.docker.listContainers({ all: true })) as typeof containers;
  } catch {
    return live; // Docker not reachable — adoption silently skipped.
  }
  for (const c of containers) {
    if (c.State !== "running") continue;
    const name = (c.Names ?? []).find((n) => n.startsWith("/survhub-")) ?? "";
    const id = name.replace(/^\/survhub-/, "");
    if (!id) continue;
    const row = ctx.db.prepare("SELECT id FROM services WHERE id = ? AND type = 'docker'").get(id) as
      | { id?: string }
      | undefined;
    if (row?.id) live.add(row.id);
  }
  return live;
}

export async function reconcileRuntimeStateOnBoot(ctx: AppContext): Promise<void> {
  // Clear stale tunnel URLs from any previous session
  ctx.db.prepare("UPDATE services SET tunnel_url = NULL WHERE tunnel_url IS NOT NULL").run();

  const adopted = await listLiveAdoptableContainers(ctx);

  // Services that were running at the last graceful shutdown — restore them
  // even if start_mode is "manual", then consume the marker.
  let runningAtShutdown = new Set<string>();
  try {
    const raw = getSetting(ctx, SHUTDOWN_RUNNING_MARKER);
    if (raw) runningAtShutdown = new Set(JSON.parse(raw) as string[]);
  } catch {
    /* malformed marker — ignore, fall back to stale-status detection */
  }
  deleteSetting(ctx, SHUTDOWN_RUNNING_MARKER);

  const rows = ctx.db
    .prepare("SELECT id, type, status, start_mode, stop_with_hoster, runtime_pgid FROM services")
    .all() as Array<{
    id: string;
    type?: string;
    status: string;
    start_mode?: string;
    stop_with_hoster?: number;
    runtime_pgid?: number | null;
  }>;
  for (const row of rows) {
    if (adopted.has(row.id)) {
      try {
        await ensureDockerRestartPolicy(
          ctx,
          row.id,
          ctx.docker.getContainer(`survhub-${row.id}`),
          desiredDockerRestartPolicy(row.stop_with_hoster)
        );
      } catch (error) {
        insertLog(ctx, row.id, "warn", `Could not reconcile Docker restart policy: ${serializeError(error)}`);
      }
      // Container is alive in Docker — treat the service as running and
      // skip auto-start so we don't recreate an already-healthy container.
      if (row.status !== "running") {
        updateServiceStatus(ctx, row.id, "running");
        insertLog(ctx, row.id, "info", "Adopted existing Docker container on boot.");
      }
      continue;
    }

    // Adopt a surviving process/static child: spawned detached, it outlives a
    // ServerHoster restart. If its process group is still alive, keep it marked
    // running (don't mis-show it as stopped, and don't auto-start a duplicate
    // that would collide on the port). stop/force-restart kill it via the
    // persisted pgid.
    if (row.type !== "docker" && row.runtime_pgid && (await hasLiveProcessGroup(Number(row.runtime_pgid)))) {
      if (row.status !== "running") {
        updateServiceStatus(ctx, row.id, "running");
        insertLog(ctx, row.id, "info", `Adopted surviving process (pgid ${row.runtime_pgid}) on boot.`);
      }
      continue;
    }
    // Its pgid (if any) is stale now.
    clearRuntimePgid(ctx, row.id);

    const statusAtBoot = row.status;
    if (row.status === "running") {
      updateServiceStatus(ctx, row.id, "stopped");
    }
    const wasRunningAtShutdown = runningAtShutdown.has(row.id);
    if (shouldRestoreServiceOnBoot({ startMode: row.start_mode, wasRunningAtShutdown })) {
      insertLog(
        ctx,
        row.id,
        "info",
        wasRunningAtShutdown
          ? "Restoring service that was running before the restart."
          : "Auto-starting service (start_mode=auto)."
      );
      void startService(ctx, row.id).catch((error) => {
        insertLog(ctx, row.id, "error", `Boot start failed: ${serializeError(error)}`);
      });
    } else if (statusAtBoot === "running") {
      insertLog(ctx, row.id, "warn", "Recovered from daemon restart. Service marked as stopped.");
    }
  }
}

/**
 * Periodically re-sync the `services` table against the Docker daemon so
 * external `docker stop` / `docker rm` / crash-and-restart actions show up in
 * the dashboard within one tick instead of waiting for a server reboot.
 *
 * Read-only with respect to Docker: never starts or stops containers, only
 * updates the DB column and emits a notification log line.
 */
export function startContainerDriftLoop(ctx: AppContext): () => void {
  const intervalMs = 30_000;
  let stopped = false;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const live = await listLiveAdoptableContainers(ctx);
      const dockerRows = ctx.db
        .prepare("SELECT id, status FROM services WHERE type = 'docker'")
        .all() as Array<{ id: string; status: string }>;
      for (const row of dockerRows) {
        const isLive = live.has(row.id);
        // Don't fight ongoing transitions — leave 'starting' and 'stopping' alone.
        if (row.status === "starting" || row.status === "stopping") continue;
        if (isLive && row.status !== "running") {
          updateServiceStatus(ctx, row.id, "running");
          insertLog(ctx, row.id, "info", "Drift check: container is running externally — adopted.");
        } else if (!isLive && row.status === "running") {
          updateServiceStatus(ctx, row.id, "stopped");
          insertLog(ctx, row.id, "warn", "Drift check: container is no longer running — marked stopped.");
        }
      }
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  // First tick after a short delay so the boot reconciliation gets to run first.
  const initial = setTimeout(() => void tick(), 5_000);
  return () => {
    stopped = true;
    clearInterval(handle);
    clearTimeout(initial);
  };
}

export function startHealthcheckLoop(ctx: AppContext): () => void {
  // Require several consecutive failures before restarting so a slow-booting or
  // briefly-flapping app isn't killed on a single transient probe.
  const FAILURE_THRESHOLD = 3;
  const failures = new Map<string, number>();
  const interval = setInterval(() => {
    const rows = ctx.db
      .prepare(
        "SELECT id, status, port, healthcheck_path FROM services WHERE status = 'running' AND healthcheck_path IS NOT NULL AND healthcheck_path != ''"
      )
      .all() as Array<{ id: string; status: string; port?: number; healthcheck_path?: string }>;
    // Forget services no longer eligible (stopped, healthcheck removed, etc.).
    const eligible = new Set(rows.map((row) => row.id));
    for (const id of [...failures.keys()]) if (!eligible.has(id)) failures.delete(id);
    for (const row of rows) {
      const port = Number(row.port ?? 0);
      if (!port) continue;
      const path = row.healthcheck_path?.startsWith("/")
        ? row.healthcheck_path
        : `/${row.healthcheck_path ?? ""}`;
      // Bound the probe — Node's global fetch has no default timeout, so a
      // half-open service (accepts the socket, never replies) would leave the
      // promise pending forever and leak a socket every tick.
      fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(Math.min(10_000, ctx.config.healthcheckIntervalMs))
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Healthcheck status ${res.status}`);
          failures.delete(row.id);
        })
        .catch((error) => {
          const count = (failures.get(row.id) ?? 0) + 1;
          failures.set(row.id, count);
          insertLog(
            ctx,
            row.id,
            "warn",
            `Healthcheck failed (${count}/${FAILURE_THRESHOLD}): ${serializeError(error)}`
          );
          if (count < FAILURE_THRESHOLD) return;
          // Don't fight an in-flight deploy/restart — its lock would just reject us.
          if (ctx.actionLocks.has(row.id)) return;
          failures.delete(row.id);
          void restartService(ctx, row.id).catch((err) =>
            insertLog(ctx, row.id, "error", `Healthcheck restart failed: ${serializeError(err)}`)
          );
        });
    }
  }, ctx.config.healthcheckIntervalMs);
  return () => clearInterval(interval);
}

// Per-instance guard (keyed by ctx, not module-global) — a single process can
// build/tear down multiple apps (e.g. the test suite), and each must shut down
// independently; only a repeated shutdown of the SAME ctx is a no-op.
const shutDownCtxs = new WeakSet<AppContext>();

export async function gracefulShutdown(ctx: AppContext): Promise<void> {
  // Both SIGINT and SIGTERM call this; without a guard a double signal runs the
  // whole teardown twice (double app.close → ERR_SERVER_NOT_RUNNING). And if
  // app.close()/a shutdown task hangs, force-exit so we never wedge on quit.
  if (shutDownCtxs.has(ctx)) return;
  shutDownCtxs.add(ctx);
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();

  // Stop all quick tunnels + the managed login tunnel first
  try {
    const { stopAllQuickTunnels, stopManagedTunnel } = await import("./cloudflare.js");
    stopAllQuickTunnels();
    stopManagedTunnel();
  } catch {
    /* ignore */
  }

  const rows = ctx.db
    .prepare(
      "SELECT id FROM services WHERE status IN ('running', 'starting') AND COALESCE(stop_with_hoster, 1) != 0"
    )
    .all() as Array<{ id: string }>;
  // Record what was running BEFORE we stop it, so the next boot can restore
  // these (stopService below overwrites their status to 'stopped').
  try {
    setSetting(ctx, SHUTDOWN_RUNNING_MARKER, JSON.stringify(rows.map((r) => r.id)));
  } catch {
    /* best effort — restore degrades to stale-status detection on next boot */
  }
  for (const row of rows) {
    try {
      insertLog(ctx, row.id, "warn", "ServerHoster is shutting down; stopping managed service.");
      await stopService(ctx, row.id);
    } catch (error) {
      insertLog(ctx, row.id, "error", `Shutdown stop failed: ${serializeError(error)}`);
    }
  }

  const durableProcessRows = ctx.db
    .prepare("SELECT id FROM services WHERE COALESCE(stop_with_hoster, 1) = 0")
    .all() as Array<{ id: string }>;
  const durableProcessIds = new Set(durableProcessRows.map((row) => row.id));
  for (const [serviceId, runtime] of ctx.runtimeProcesses.entries()) {
    if (durableProcessIds.has(serviceId)) {
      insertLog(ctx, serviceId, "info", "Always on service left running while ServerHoster stops.");
      continue;
    }
    terminateRuntimeProcess(runtime);
    insertLog(ctx, serviceId, "warn", "Service received shutdown signal.");
  }
  for (const task of ctx.shutdownTasks) {
    await task();
  }
  await ctx.app.close();
  clearTimeout(forceExit);
}
