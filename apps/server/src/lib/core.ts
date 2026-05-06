import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type { AppContext, BuildType, LogLevel } from "../types.js";
import { decryptSecret, maskSecret } from "../security.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function normalizeOutput(output: string): string {
  return output.replace(/\r\n/g, "\n").trim();
}

export function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePortMapping(portValue: unknown): number | null {
  if (typeof portValue === "number") return portValue;
  if (typeof portValue !== "string") return null;
  const trimmed = portValue.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  const hostPart = parts.length > 1 ? parts[0] : parts[0];
  const hostPort = Number(hostPart.split("/")[0]);
  return Number.isFinite(hostPort) ? hostPort : null;
}

export function broadcast(ctx: AppContext, event: unknown): void {
  const payload = JSON.stringify(event);
  for (const client of ctx.wsSubscribers) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Send an event to only the WS clients that have explicitly attached to a
 * given transferId. Used for db transfer streaming so chunks don't fan out
 * to every connected admin tab.
 */
export function broadcastTransferEvent(ctx: AppContext, transferId: string, event: unknown): void {
  const subscribers = ctx.transferSubscribers.get(transferId);
  if (!subscribers || subscribers.size === 0) return;
  const payload = JSON.stringify(event);
  for (const client of subscribers) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

export function trimServiceLogs(ctx: AppContext, serviceId: string): void {
  ctx.db
    .prepare(
      `DELETE FROM logs
     WHERE service_id = ?
       AND id NOT IN (
         SELECT id FROM logs WHERE service_id = ? ORDER BY timestamp DESC LIMIT 5000
       )`
    )
    .run(serviceId, serviceId);
}

export function insertLog(ctx: AppContext, serviceId: string, level: LogLevel, message: string): void {
  const cleanMessage = normalizeOutput(message);
  if (!cleanMessage) return;
  const timestamp = nowIso();
  ctx.db
    .prepare("INSERT INTO logs (id, service_id, level, message, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(nanoid(), serviceId, level, cleanMessage, timestamp);
  trimServiceLogs(ctx, serviceId);
  broadcast(ctx, { type: "log", serviceId, level, message: cleanMessage, timestamp });
}

export function updateServiceStatus(
  ctx: AppContext,
  serviceId: string,
  status: string,
  lastExitCode?: number
): void {
  ctx.db
    .prepare(
      `UPDATE services
     SET status = ?, updated_at = ?, last_exit_code = COALESCE(?, last_exit_code),
         last_started_at = CASE WHEN ? = 'running' THEN ? ELSE last_started_at END,
         last_stopped_at = CASE WHEN ? IN ('stopped', 'crashed') THEN ? ELSE last_stopped_at END
     WHERE id = ?`
    )
    .run(status, nowIso(), lastExitCode ?? null, status, nowIso(), status, nowIso(), serviceId);
  broadcast(ctx, { type: "service_status", serviceId, status, lastExitCode: lastExitCode ?? null });
}

export function getService(ctx: AppContext, serviceId: string): Record<string, unknown> {
  const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId) as
    | Record<string, unknown>
    | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

export function getServiceEnv(
  ctx: AppContext,
  serviceId: string,
  revealSecrets = true
): Record<string, string> {
  const rows = ctx.db
    .prepare("SELECT key, value, is_secret FROM env_vars WHERE service_id = ?")
    .all(serviceId) as Array<{
    key: string;
    value: string;
    is_secret: number;
  }>;
  const out: Record<string, string> = {};
  for (const row of rows) {
    const value = row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value;
    out[row.key] = revealSecrets ? value : row.is_secret ? maskSecret(value) : value;
  }
  return out;
}

export type RunCommandOptions = {
  timeoutMs?: number;
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
};

export async function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutOrOptions: number | RunCommandOptions = 120000
): Promise<{ code: number; output: string }> {
  const opts: RunCommandOptions =
    typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = opts.timeoutMs ?? 120000;
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      output += "\nCommand timeout reached.";
      opts.onChunk?.("\nCommand timeout reached.\n", "stderr");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      output += s;
      opts.onChunk?.(s, "stdout");
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      output += s;
      opts.onChunk?.(s, "stderr");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, output: normalizeOutput(output) });
    });
  });
}

export async function findFreePort(start = 3000, end = 3999): Promise<number> {
  for (let port = start; port <= end; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`No free port found in range ${start}–${end}`);
}

export function detectBuildType(projectPath: string): BuildType {
  if (fs.existsSync(`${projectPath}/Dockerfile`)) return "docker";
  if (fs.existsSync(`${projectPath}/package.json`)) return "node";
  if (fs.existsSync(`${projectPath}/requirements.txt`) || fs.existsSync(`${projectPath}/pyproject.toml`))
    return "python";
  return "unknown";
}

/**
 * Central authorisation context. Routes that touch a single service should
 * call `assertServiceOwnership` before mutating state — it consolidates the
 * "does this actor own/can manage this service?" check that was otherwise
 * scattered through ad-hoc DB lookups.
 *
 * Today LocalSURV runs in a single-tenant model: any logged-in actor can
 * manage any service in the instance. The function still resolves the
 * service row and asserts it exists, which catches a class of confused-
 * deputy bugs (deleted/renamed services) and gives every callsite a single
 * place to slot in finer-grained ACLs later without touching every route.
 */
export type AuthzContext = {
  actor: string;
  action: string;
  /** Optional source IP for audit enrichment downstream. */
  sourceIp?: string | null;
};

export type ServiceOwnershipRow = {
  id: string;
  project_id: string;
  name: string;
  status: string;
};

export class AuthzError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = "AuthzError";
    this.statusCode = statusCode;
  }
}

export function assertServiceOwnership(
  ctx: AppContext,
  serviceId: string,
  _authz: AuthzContext
): ServiceOwnershipRow {
  if (!serviceId || typeof serviceId !== "string") {
    throw new AuthzError("Missing service id", 400);
  }
  const row = ctx.db
    .prepare("SELECT id, project_id, name, status FROM services WHERE id = ?")
    .get(serviceId) as ServiceOwnershipRow | undefined;
  if (!row) {
    throw new AuthzError(`Service not found: ${serviceId}`, 404);
  }
  // Hook point for tenant-aware ACLs: in a multi-tenant deployment we'd
  // verify _authz.actor's tenant matches row.project_id's tenant here.
  return row;
}

export function assertProjectOwnership(
  ctx: AppContext,
  projectId: string,
  _authz: AuthzContext
): { id: string; name: string } {
  if (!projectId || typeof projectId !== "string") {
    throw new AuthzError("Missing project id", 400);
  }
  const row = ctx.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as
    | { id: string; name: string }
    | undefined;
  if (!row) throw new AuthzError(`Project not found: ${projectId}`, 404);
  return row;
}
