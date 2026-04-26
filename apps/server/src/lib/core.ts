import fs from "node:fs";
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

export function trimServiceLogs(ctx: AppContext, serviceId: string): void {
  ctx.db.prepare(
    `DELETE FROM logs
     WHERE service_id = ?
       AND id NOT IN (
         SELECT id FROM logs WHERE service_id = ? ORDER BY timestamp DESC LIMIT 5000
       )`
  ).run(serviceId, serviceId);
}

export function insertLog(ctx: AppContext, serviceId: string, level: LogLevel, message: string): void {
  const cleanMessage = normalizeOutput(message);
  if (!cleanMessage) return;
  const timestamp = nowIso();
  ctx.db.prepare("INSERT INTO logs (id, service_id, level, message, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(nanoid(), serviceId, level, cleanMessage, timestamp);
  trimServiceLogs(ctx, serviceId);
  broadcast(ctx, { type: "log", serviceId, level, message: cleanMessage, timestamp });
}

export function updateServiceStatus(ctx: AppContext, serviceId: string, status: string, lastExitCode?: number): void {
  ctx.db.prepare(
    `UPDATE services
     SET status = ?, updated_at = ?, last_exit_code = COALESCE(?, last_exit_code),
         last_started_at = CASE WHEN ? = 'running' THEN ? ELSE last_started_at END,
         last_stopped_at = CASE WHEN ? IN ('stopped', 'crashed') THEN ? ELSE last_stopped_at END
     WHERE id = ?`
  ).run(status, nowIso(), lastExitCode ?? null, status, nowIso(), status, nowIso(), serviceId);
  broadcast(ctx, { type: "service_status", serviceId, status, lastExitCode: lastExitCode ?? null });
}

export function getService(ctx: AppContext, serviceId: string): Record<string, unknown> {
  const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId) as Record<string, unknown> | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

export function getServiceEnv(ctx: AppContext, serviceId: string, revealSecrets = true): Record<string, string> {
  const rows = ctx.db.prepare("SELECT key, value, is_secret FROM env_vars WHERE service_id = ?").all(serviceId) as Array<{
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

export function detectBuildType(projectPath: string): BuildType {
  if (fs.existsSync(`${projectPath}/Dockerfile`)) return "docker";
  if (fs.existsSync(`${projectPath}/package.json`)) return "node";
  if (fs.existsSync(`${projectPath}/requirements.txt`) || fs.existsSync(`${projectPath}/pyproject.toml`)) return "python";
  return "unknown";
}
