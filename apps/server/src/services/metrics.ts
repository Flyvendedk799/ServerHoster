import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, nowIso, serializeError } from "../lib/core.js";

const exec = promisify(execFile);

const METRICS_INTERVAL_MS = 30000; // 30s
const METRICS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Sample CPU% and RSS for a running process by pid via `ps`. Works on both
 * macOS and Linux (both accept `-o %cpu=,%mem=,rss=`).
 */
async function sampleProcess(pid: number): Promise<{ cpu: number; memoryMb: number } | null> {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "%cpu=,%mem=,rss="]);
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const cpu = parseFloat(parts[0]);
    const rssKb = parseFloat(parts[2]);
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return null;
    return { cpu, memoryMb: Math.round((rssKb / 1024) * 10) / 10 };
  } catch {
    return null;
  }
}

/**
 * Sample CPU% and memory for a running Docker container via `docker stats`.
 * Uses `--no-stream` to get a single snapshot.
 */
async function sampleContainer(name: string): Promise<{ cpu: number; memoryMb: number } | null> {
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}|{{.MemUsage}}",
      name
    ]);
    const line = stdout.trim();
    if (!line) return null;
    const [cpuRaw, memRaw] = line.split("|");
    const cpu = parseFloat(cpuRaw.replace("%", ""));
    // MemUsage format: "12.3MiB / 256MiB" (we care about the first part).
    const memPart = memRaw.split("/")[0].trim();
    const match = memPart.match(/^([\d.]+)\s*([KMG]i?B)$/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    let memoryMb = value;
    if (unit.startsWith("K")) memoryMb = value / 1024;
    else if (unit.startsWith("G")) memoryMb = value * 1024;
    return { cpu, memoryMb: Math.round(memoryMb * 10) / 10 };
  } catch {
    return null;
  }
}

function recordSample(ctx: AppContext, serviceId: string, cpu: number, memoryMb: number): void {
  const row = { id: nanoid(), service_id: serviceId, cpu_percent: cpu, memory_mb: memoryMb, timestamp: nowIso() };
  ctx.db
    .prepare("INSERT INTO metrics (id, service_id, cpu_percent, memory_mb, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.service_id, row.cpu_percent, row.memory_mb, row.timestamp);
  broadcast(ctx, { type: "metrics_sample", serviceId, cpu, memoryMb, timestamp: row.timestamp });
}

function trimOldMetrics(ctx: AppContext): void {
  const cutoff = new Date(Date.now() - METRICS_RETENTION_MS).toISOString();
  ctx.db.prepare("DELETE FROM metrics WHERE timestamp < ?").run(cutoff);
}

export function startMetricsLoop(ctx: AppContext): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const rows = ctx.db
        .prepare("SELECT id, type, status FROM services WHERE status = 'running'")
        .all() as Array<{ id: string; type: string; status: string }>;

      for (const row of rows) {
        try {
          if (row.type === "docker") {
            const sample = await sampleContainer(`survhub-${row.id}`);
            if (sample) recordSample(ctx, row.id, sample.cpu, sample.memoryMb);
          } else {
            const runtime = ctx.runtimeProcesses.get(row.id);
            const pid = runtime?.process.pid;
            if (!pid) continue;
            const sample = await sampleProcess(pid);
            if (sample) recordSample(ctx, row.id, sample.cpu, sample.memoryMb);
          }
        } catch (error) {
          ctx.app.log.warn(`metrics sample failed for ${row.id}: ${serializeError(error)}`);
        }
      }

      trimOldMetrics(ctx);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => {
    void tick();
  }, METRICS_INTERVAL_MS);
  // Kick off an initial sample so the dashboard has data quickly.
  void tick();
  return () => clearInterval(interval);
}

export function getLatestMetrics(ctx: AppContext): Record<string, { cpu: number; memoryMb: number; timestamp: string }> {
  const rows = ctx.db
    .prepare(
      `SELECT m.service_id, m.cpu_percent, m.memory_mb, m.timestamp
       FROM metrics m
       INNER JOIN (
         SELECT service_id, MAX(timestamp) AS max_ts
         FROM metrics GROUP BY service_id
       ) latest ON latest.service_id = m.service_id AND latest.max_ts = m.timestamp`
    )
    .all() as Array<{ service_id: string; cpu_percent: number; memory_mb: number; timestamp: string }>;
  const out: Record<string, { cpu: number; memoryMb: number; timestamp: string }> = {};
  for (const r of rows) {
    out[r.service_id] = { cpu: r.cpu_percent, memoryMb: r.memory_mb, timestamp: r.timestamp };
  }
  return out;
}

export function getServiceSparkline(
  ctx: AppContext,
  serviceId: string,
  minutes = 60
): Array<{ cpu: number; memoryMb: number; timestamp: string }> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const rows = ctx.db
    .prepare(
      "SELECT cpu_percent, memory_mb, timestamp FROM metrics WHERE service_id = ? AND timestamp >= ? ORDER BY timestamp ASC"
    )
    .all(serviceId, cutoff) as Array<{ cpu_percent: number; memory_mb: number; timestamp: string }>;
  return rows.map((r) => ({ cpu: r.cpu_percent, memoryMb: r.memory_mb, timestamp: r.timestamp }));
}
