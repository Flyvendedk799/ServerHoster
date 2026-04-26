import fs from "node:fs";
import { spawn } from "node:child_process";
import { nowIso, getService, getServiceEnv, insertLog, serializeError, updateServiceStatus } from "../lib/core.js";
import type { AppContext } from "../types.js";
import { createNotification } from "./notifications.js";
import { buildConnectionString, getDatabase } from "./databases.js";

/**
 * Merge project env, service env, and auto-injected DATABASE_URL.
 * Precedence (low → high): project env → linked database URL → service env.
 * Service-level values always win so users can override project defaults
 * and the DATABASE_URL auto-injection.
 */
function getServiceEnvWithLinks(ctx: AppContext, serviceId: string): Record<string, string> {
  const service = ctx.db
    .prepare("SELECT project_id, linked_database_id, type FROM services WHERE id = ?")
    .get(serviceId) as { project_id?: string; linked_database_id?: string; type?: string } | undefined;

  const projectEnv: Record<string, string> = {};
  if (service?.project_id) {
    const rows = ctx.db
      .prepare("SELECT key, value FROM project_env_vars WHERE project_id = ?")
      .all(service.project_id) as Array<{ key: string; value: string }>;
    for (const r of rows) projectEnv[r.key] = r.value;
  }

  const serviceEnv = getServiceEnv(ctx, serviceId);
  const merged: Record<string, string> = { ...projectEnv };

  if (service?.linked_database_id && !serviceEnv.DATABASE_URL) {
    const db = getDatabase(ctx, service.linked_database_id);
    if (db) {
      const host = service.type === "docker" ? "host.docker.internal" : "localhost";
      merged.DATABASE_URL = buildConnectionString(db, host);
    }
  }
  return { ...merged, ...serviceEnv };
}

async function pullImage(ctx: AppContext, image: string): Promise<void> {
  const stream = await ctx.docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    ctx.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
}

async function getOrCreateContainer(ctx: AppContext, serviceId: string, image: string, command: string, port: number, envList: string[]) {
  const containerName = `survhub-${serviceId}`;
  try {
    const existing = ctx.docker.getContainer(containerName);
    await existing.inspect();
    return existing;
  } catch {
    return ctx.docker.createContainer({
      Image: image,
      name: containerName,
      Cmd: command ? command.split(/\s+/) : undefined,
      Env: envList,
      ExposedPorts: port ? { [`${port}/tcp`]: {} } : undefined,
      HostConfig: {
        PortBindings: port ? { [`${port}/tcp`]: [{ HostPort: String(port) }] } : undefined,
        RestartPolicy: { Name: "unless-stopped" }
      }
    });
  }
}

export async function withLock<T>(ctx: AppContext, serviceId: string, task: () => Promise<T>): Promise<T> {
  if (ctx.actionLocks.has(serviceId)) throw new Error("Service action already in progress");
  ctx.actionLocks.add(serviceId);
  return task().finally(() => ctx.actionLocks.delete(serviceId));
}

async function startProcessService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  if (ctx.runtimeProcesses.has(serviceId)) return;
  if (service.type !== "process" && service.type !== "static") throw new Error("Service is not a process service");

  const command = String(service.command ?? "").trim();
  if (!command) throw new Error("Missing command for service");
  const cwd = String(service.working_dir || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

  ctx.manuallyStopped.delete(serviceId);
  const serviceEnvFromLinks = getServiceEnvWithLinks(ctx, serviceId);
  const portEnv = service.port && !serviceEnvFromLinks.PORT ? { PORT: String(service.port) } : {};
  const child = spawn(command, { cwd, env: { ...process.env, ...portEnv, ...serviceEnvFromLinks }, shell: true });
  ctx.runtimeProcesses.set(serviceId, { process: child, serviceId });
  ctx.db.prepare("UPDATE services SET restart_count = 0 WHERE id = ?").run(serviceId);
  updateServiceStatus(ctx, serviceId, "running");
  insertLog(ctx, serviceId, "info", `Started command: ${command}`);

  // Auto-start quick tunnel if enabled (dynamic import avoids circular dependency)
  const qtRow = ctx.db.prepare("SELECT quick_tunnel_enabled, port FROM services WHERE id = ?")
    .get(serviceId) as { quick_tunnel_enabled?: number; port?: number } | undefined;
  if (qtRow?.quick_tunnel_enabled && qtRow.port) {
    import("./cloudflare.js").then(({ startQuickTunnel }) => {
      try { startQuickTunnel(ctx, serviceId, qtRow.port!); } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
  }

  child.stdout.on("data", (d) => insertLog(ctx, serviceId, "info", d.toString()));
  child.stderr.on("data", (d) => insertLog(ctx, serviceId, "error", d.toString()));
  child.on("exit", (code) => {
    ctx.runtimeProcesses.delete(serviceId);
    const cfg = ctx.db.prepare("SELECT auto_restart, restart_count, max_restarts FROM services WHERE id = ?").get(serviceId) as
      | { auto_restart: number; restart_count: number; max_restarts: number }
      | undefined;
    if (!cfg) return;
    if (ctx.manuallyStopped.has(serviceId)) {
      ctx.manuallyStopped.delete(serviceId);
      updateServiceStatus(ctx, serviceId, "stopped", code ?? 0);
      return;
    }
    if (cfg.auto_restart && cfg.restart_count < cfg.max_restarts) {
      const nextCount = cfg.restart_count + 1;
      ctx.db.prepare("UPDATE services SET restart_count = ? WHERE id = ?").run(nextCount, serviceId);
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, nextCount));
      updateServiceStatus(ctx, serviceId, "crashed", code ?? 1);
      insertLog(ctx, serviceId, "warn", `Service crashed. Restart attempt ${nextCount} in ${backoffMs}ms.`);
      const serviceName = String((getService(ctx, serviceId).name ?? serviceId));
      createNotification(ctx, {
        kind: "service_crash",
        severity: "warning",
        title: `Service crashed: ${serviceName}`,
        body: `Exit code ${code}. Restart attempt ${nextCount}/${cfg.max_restarts} in ${backoffMs}ms.`,
        serviceId
      });
      setTimeout(() => {
        void withLock(ctx, serviceId, () => startProcessService(ctx, serviceId)).catch((error) => {
          insertLog(ctx, serviceId, "error", `Restart failed: ${serializeError(error)}`);
          updateServiceStatus(ctx, serviceId, "crashed");
        });
      }, backoffMs);
      return;
    }
    updateServiceStatus(ctx, serviceId, "stopped", code ?? 1);
    insertLog(ctx, serviceId, "warn", "Service stopped.");
    if ((code ?? 0) !== 0) {
      const serviceName = String((getService(ctx, serviceId).name ?? serviceId));
      createNotification(ctx, {
        kind: "service_crash",
        severity: "error",
        title: `Service stopped abnormally: ${serviceName}`,
        body: `Exit code ${code}. Auto-restart exhausted or disabled.`,
        serviceId
      });
    }
  });
}

async function startDockerService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  if (service.type !== "docker") throw new Error("Service is not a docker service");
  const image = String(service.docker_image || "alpine:latest");
  const command = String(service.command || "").trim();
  const port = Number(service.port || 0);
  const dockerServiceEnv = getServiceEnvWithLinks(ctx, serviceId);
  if (port && !dockerServiceEnv.PORT) dockerServiceEnv.PORT = String(port);
  const envList = Object.entries(dockerServiceEnv).map(([k, v]) => `${k}=${v}`);

  try {
    await pullImage(ctx, image);
  } catch (error) {
    insertLog(ctx, serviceId, "warn", `Image pull skipped for ${image}: ${serializeError(error)}`);
  }
  const container = await getOrCreateContainer(ctx, serviceId, image, command, port, envList);
  try {
    await container.start();
  } catch (error) {
    const msg = serializeError(error);
    if (!msg.includes("already started")) throw error;
  }
  updateServiceStatus(ctx, serviceId, "running");
  insertLog(ctx, serviceId, "info", `Docker container running with image ${image}`);

  // Auto-start quick tunnel if enabled
  const qtRowDocker = ctx.db.prepare("SELECT quick_tunnel_enabled, port FROM services WHERE id = ?")
    .get(serviceId) as { quick_tunnel_enabled?: number; port?: number } | undefined;
  if (qtRowDocker?.quick_tunnel_enabled && qtRowDocker.port) {
    import("./cloudflare.js").then(({ startQuickTunnel }) => {
      try { startQuickTunnel(ctx, serviceId, qtRowDocker.port!); } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
  }
}

export async function stopService(ctx: AppContext, serviceId: string): Promise<void> {
  const service = getService(ctx, serviceId);
  ctx.manuallyStopped.add(serviceId);

  // Stop quick tunnel if running
  import("./cloudflare.js").then(({ stopQuickTunnel }) => {
    try { stopQuickTunnel(ctx, serviceId); } catch { /* ignore */ }
  }).catch(() => { /* ignore */ });
  if (service.type === "docker") {
    const container = ctx.docker.getContainer(`survhub-${serviceId}`);
    try { await container.stop({ t: 10 }); } catch {}
    try { await container.remove({ force: false }); } catch {}
  } else {
    const runtime = ctx.runtimeProcesses.get(serviceId);
    if (runtime) {
      runtime.process.kill("SIGTERM");
      setTimeout(() => runtime.process.kill("SIGKILL"), 5000);
      ctx.runtimeProcesses.delete(serviceId);
    }
  }
  updateServiceStatus(ctx, serviceId, "stopped", 0);
}

export async function startService(ctx: AppContext, serviceId: string): Promise<void> {
  // Start dependencies first (already-running ones are skipped).
  await startDependencies(ctx, serviceId, new Set());
  const service = getService(ctx, serviceId);
  await withLock(ctx, serviceId, async () => {
    if (service.type === "docker") {
      await startDockerService(ctx, serviceId);
    } else {
      await startProcessService(ctx, serviceId);
    }
  });
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

async function startDependencies(
  ctx: AppContext,
  serviceId: string,
  visiting: Set<string>
): Promise<void> {
  if (visiting.has(serviceId)) {
    throw new Error(`Dependency cycle detected at service ${serviceId}`);
  }
  visiting.add(serviceId);
  const row = ctx.db
    .prepare("SELECT depends_on FROM services WHERE id = ?")
    .get(serviceId) as { depends_on?: string } | undefined;
  const deps = parseDependsOn(row?.depends_on);
  for (const depId of deps) {
    const dep = ctx.db
      .prepare("SELECT id, status FROM services WHERE id = ?")
      .get(depId) as { id: string; status: string } | undefined;
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
  const rows = ctx.db.prepare("SELECT id, depends_on FROM services").all() as Array<{ id: string; depends_on?: string }>;
  return rows
    .filter((r) => parseDependsOn(r.depends_on).includes(serviceId))
    .map((r) => r.id);
}

export async function restartService(ctx: AppContext, serviceId: string): Promise<void> {
  await withLock(ctx, serviceId, async () => {
    await stopService(ctx, serviceId);
    await startService(ctx, serviceId);
  });
}

export function reconcileRuntimeStateOnBoot(ctx: AppContext): void {
  // Clear stale tunnel URLs from any previous session
  ctx.db.prepare("UPDATE services SET tunnel_url = NULL WHERE tunnel_url IS NOT NULL").run();

  const rows = ctx.db.prepare("SELECT id, status, start_mode FROM services").all() as Array<{ id: string; status: string; start_mode?: string }>;
  for (const row of rows) {
    if (row.status === "running") {
      updateServiceStatus(ctx, row.id, "stopped");
      insertLog(ctx, row.id, "warn", "Recovered from daemon restart. Service marked as stopped.");
    }
    if (row.start_mode === "auto") {
      void startService(ctx, row.id).catch((error) => {
        insertLog(ctx, row.id, "error", `Auto-start failed: ${serializeError(error)}`);
      });
    }
  }
}

export function startHealthcheckLoop(ctx: AppContext): () => void {
  const interval = setInterval(() => {
    const rows = ctx.db.prepare(
      "SELECT id, status, port, healthcheck_path FROM services WHERE status = 'running' AND healthcheck_path IS NOT NULL AND healthcheck_path != ''"
    ).all() as Array<{ id: string; status: string; port?: number; healthcheck_path?: string }>;
    for (const row of rows) {
      const port = Number(row.port ?? 0);
      if (!port) continue;
      const path = row.healthcheck_path?.startsWith("/") ? row.healthcheck_path : `/${row.healthcheck_path ?? ""}`;
      fetch(`http://127.0.0.1:${port}${path}`)
        .then((res) => {
          if (!res.ok) throw new Error(`Healthcheck status ${res.status}`);
        })
        .catch((error) => {
          insertLog(ctx, row.id, "warn", `Healthcheck failed: ${serializeError(error)}`);
          void restartService(ctx, row.id).catch((err) => insertLog(ctx, row.id, "error", `Healthcheck restart failed: ${serializeError(err)}`));
        });
    }
  }, ctx.config.healthcheckIntervalMs);
  return () => clearInterval(interval);
}

export async function gracefulShutdown(ctx: AppContext): Promise<void> {
  // Stop all quick tunnels first
  try {
    const { stopAllQuickTunnels } = await import("./cloudflare.js");
    stopAllQuickTunnels();
  } catch { /* ignore */ }

  for (const [serviceId, runtime] of ctx.runtimeProcesses.entries()) {
    runtime.process.kill("SIGTERM");
    insertLog(ctx, serviceId, "warn", "Service received shutdown signal.");
  }
  for (const task of ctx.shutdownTasks) {
    await task();
  }
  await ctx.app.close();
}
