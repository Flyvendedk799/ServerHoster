import fs from "node:fs";
import path from "node:path";
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
    const child = spawn(command, { cwd, env, shell: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          child.kill("SIGTERM");
        } else if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
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
      // A timeout-killed process can still race to exit 0 mid-write; force a
      // non-zero (124) so a half-finished install never masquerades as success.
      resolve({ code: timedOut ? 124 : (code ?? 1), output: normalizeOutput(output) });
    });
  });
}

/**
 * Append text to a service's most recent deployment build_log. Lets a crash
 * that happens AFTER a green build (e.g. the app exits immediately on start)
 * surface its reason on the deployment screen instead of only the live logs.
 */
export function appendDeploymentLog(ctx: AppContext, serviceId: string, text: string): void {
  const row = ctx.db
    .prepare("SELECT id FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(serviceId) as { id?: string } | undefined;
  if (!row?.id) return;
  ctx.db
    .prepare("UPDATE deployments SET build_log = COALESCE(build_log, '') || ? WHERE id = ?")
    .run(`\n[post-start ${nowIso()}]\n${text}\n`, row.id);
}

/**
 * Build the base environment a spawned service/build/terminal child inherits.
 * We deliberately do NOT spread the raw control-plane process.env: it carries
 * SURVHUB_SECRET_KEY (the master key that decrypts EVERY service's secrets) plus
 * operator tokens. Any deployed app — or an untrusted npm/pip/docker build it
 * triggers — would otherwise read them, so one service could decrypt another's
 * data. Strip all SURVHUB_* and the known operator-integration secrets; a
 * service still gets its OWN env (layered on top by the caller).
 */
const STRIPPED_ENV_KEYS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "TUNNEL_TOKEN",
  "TUNNEL_ORIGIN_CERT",
  "NPM_TOKEN"
]);
/**
 * Map a raw Docker-socket connection failure to a clear, actionable message, or
 * null if it isn't one. When Colima/Docker Desktop is stopped, every dockerode
 * call throws a bare `ECONNREFUSED …/docker.sock` with no statusCode, which would
 * otherwise surface to the user as a cryptic 500. Returns the friendly text so
 * the API can answer 503 with "start Docker and retry".
 */
export function dockerUnavailableMessage(error: unknown): string | null {
  const e = error as { code?: string; address?: string; message?: string };
  const code = e?.code;
  const where = `${e?.address ?? ""} ${e?.message ?? ""}`;
  if (
    (code === "ECONNREFUSED" || code === "ENOENT" || code === "EACCES") &&
    /docker\.sock|colima|\/var\/run\/docker/i.test(where)
  ) {
    return "Docker isn't reachable — the daemon appears to be stopped. Start it (e.g. `colima start`, or open Docker Desktop) and try again.";
  }
  return null;
}

export function sanitizedHostEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("SURVHUB_")) continue; // control-plane only — never hand to children
    if (STRIPPED_ENV_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Ports already reserved by a service or database row (stopped ones included —
 * a logical reservation, not just a live socket — so a freed-but-remembered port
 * isn't re-handed to a second service). */
export function dbReservedPorts(ctx: AppContext, excludeServiceId?: string): Set<number> {
  const taken = new Set<number>();
  for (const r of ctx.db
    .prepare("SELECT port FROM services WHERE port IS NOT NULL AND id != ?")
    .all(excludeServiceId ?? "") as Array<{ port: number }>)
    taken.add(r.port);
  for (const r of ctx.db.prepare("SELECT port FROM databases WHERE port IS NOT NULL").all() as Array<{
    port: number;
  }>)
    taken.add(r.port);
  return taken;
}

/** Reject (409) if `port` is already claimed by another service or a database. */
export function assertPortAvailable(ctx: AppContext, port: number, excludeServiceId?: string): void {
  const svc = ctx.db
    .prepare("SELECT name FROM services WHERE port = ? AND id != ?")
    .get(port, excludeServiceId ?? "") as { name?: string } | undefined;
  const db = svc
    ? undefined
    : (ctx.db.prepare("SELECT name FROM databases WHERE port = ?").get(port) as { name?: string } | undefined);
  const owner = svc ? `service "${svc.name ?? "?"}"` : db ? `database "${db.name ?? "?"}"` : null;
  if (owner) {
    const e = new Error(`Port ${port} is already used by ${owner}. Pick a different port.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    e.statusCode = 409;
    e.code = "PORT_IN_USE";
    throw e;
  }
}

/**
 * Confine a service's working_dir to its own clone (projectsDir/<serviceId>).
 * realpath defeats symlink tunnels; the trailing separator avoids the
 * /projects/A vs /projects/Ax sibling-prefix bug. Without this a service could
 * be pointed at another service's clone (or anywhere on disk).
 */
export function assertWithinServiceDir(ctx: AppContext, serviceId: string, dir: string): void {
  const base = path.resolve(ctx.config.projectsDir, serviceId);
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const realBase = real(base);
  const realTarget = real(path.resolve(dir));
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    const e = new Error("working_dir must stay inside the service's own project directory.") as Error & {
      statusCode?: number;
    };
    e.statusCode = 400;
    throw e;
  }
}

export async function findFreePort(start = 3000, end = 3999, skip?: Set<number>): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (skip?.has(port)) continue;
    const freeOnLoopback = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (!freeOnLoopback) continue;
    const freeOnAllInterfaces = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "0.0.0.0");
    });
    if (freeOnAllInterfaces) return port;
  }
  throw new Error(`No free port found in range ${start}–${end}`);
}

export function detectBuildType(projectPath: string): BuildType {
  if (fs.existsSync(`${projectPath}/Dockerfile`)) return "docker";
  if (fs.existsSync(`${projectPath}/package.json`)) return "node";
  if (fs.existsSync(`${projectPath}/requirements.txt`) || fs.existsSync(`${projectPath}/pyproject.toml`))
    return "python";
  if (fs.existsSync(path.join(projectPath, "project.godot"))) return "godot";
  if (findStaticEntry(projectPath)) return "static";
  return "unknown";
}

export function findStaticEntry(projectPath: string): string | null {
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
  let bestDir: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "index.html")) {
      const names = new Set(
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase())
      );
      let score = 10 - depth;
      if (names.has("manifest.json")) score += 4;
      if ([...names].some((name) => name.endsWith(".wasm") || name.endsWith(".pck"))) score += 8;
      const rel = path.relative(projectPath, dir).toLowerCase();
      if (/(dist|build|public|web|client|site|static)/.test(rel)) score += 3;
      if (score > bestScore) {
        bestDir = dir;
        bestScore = score;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(projectPath, 0);
  return bestDir;
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
