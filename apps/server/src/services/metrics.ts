import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, nowIso, serializeError } from "../lib/core.js";
import { resolveComposeConfig } from "./compose.js";

const exec = promisify(execFile);

const METRICS_INTERVAL_MS = 30000; // 30s
const METRICS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h
const TOP_CONTAINERS_LIMIT = 25;

/**
 * Memory attribution choices (documented for operators / CODEy review):
 *
 * Process trees (Linux):
 *   Prefer PSS from `/proc/<pid>/smaps_rollup`, summed across the tree.
 *   PSS already apportions shared pages, so summing it does NOT double-count
 *   the way summing RSS would for Node workers / forked children.
 *   Fallback: if the root pid lives in a non-root cgroup, read that cgroup's
 *   `memory.current` (single figure for the whole group).
 *   Last resort (macOS / no smaps): sum RSS and label `memorySource: "rss"`.
 *
 * CPU for process trees: SUM of `%cpu` across the tree. Each process reports
 * its own share of a core; summing matches "how busy is this service".
 *
 * Docker / compose:
 *   Prefer `docker stats` MemUsage (cgroup v2: usage − inactive_file), which
 *   matches what operators see in the CLI and avoids cache-inflated
 *   `memory_stats.usage`. Compose stacks sum MemUsage + CPU% across every
 *   running container labeled `com.docker.compose.project=<name>`.
 *
 * Host breakdown:
 *   Prefer MemAvailable from `/proc/meminfo` for used = total − available.
 *   `unaccountedMb = hostUsedMb − (processServiceMb + allDockerMb)` so a large
 *   remainder surfaces missing consumers (Supabase stacks, ad-hoc job-desk-*, …).
 */

export type MemorySource = "pss" | "cgroup" | "rss" | "docker_stats";

export type SampleResult = {
  cpu: number;
  memoryMb: number;
  memorySource: MemorySource;
};

export type ProcessRow = {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
};

export type ContainerStat = {
  name: string;
  cpu: number;
  memoryMb: number;
};

export type HostMemoryInfo = {
  totalMb: number;
  availableMb: number | null;
  usedMb: number;
  source: "memavailable" | "freemem";
};

export type HostMemoryBreakdown = {
  totalMb: number;
  availableMb: number | null;
  usedMb: number;
  hostMemorySource: "memavailable" | "freemem";
  /** Sum of non-docker process-service samples from the last tick (0 if none). */
  processAttributedMb: number;
  /** Sum of MemUsage across every running Docker container on the host. */
  dockerAttributedMb: number;
  /** processAttributedMb + dockerAttributedMb (no double-count: process services are not containers). */
  measuredMb: number;
  /** usedMb − measuredMb; large values mean something is still invisible. */
  unaccountedMb: number;
  topContainers: ContainerStat[];
  checkedAt: string;
};

// Last tick attribution — used by host breakdown without re-sampling processes.
let lastProcessAttributedMb = 0;

// ---------------------------------------------------------------------------
// Pure parsers / aggregation (unit-tested)
// ---------------------------------------------------------------------------

/** Parse the used side of docker stats MemUsage, e.g. "12.3MiB / 256MiB". */
export function parseDockerMemUsage(memRaw: string): number | null {
  const memPart = memRaw.split("/")[0]?.trim() ?? "";
  const match = memPart.match(/^([\d.]+)\s*([KMG]i?B)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  let memoryMb = value;
  if (unit.startsWith("K")) memoryMb = value / 1024;
  else if (unit.startsWith("G")) memoryMb = value * 1024;
  return Math.round(memoryMb * 10) / 10;
}

/** Parse one `docker stats --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'` line. */
export function parseDockerStatsLine(line: string): ContainerStat | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [name, cpuRaw, memRaw] = trimmed.split("|");
  if (!name || cpuRaw == null || memRaw == null) return null;
  const cpu = parseFloat(String(cpuRaw).replace("%", ""));
  const memoryMb = parseDockerMemUsage(memRaw);
  if (!Number.isFinite(cpu) || memoryMb == null) return null;
  return { name: name.trim(), cpu, memoryMb };
}

export function parseDockerStatsOutput(stdout: string): ContainerStat[] {
  const out: ContainerStat[] = [];
  for (const line of stdout.split("\n")) {
    const row = parseDockerStatsLine(line);
    if (row) out.push(row);
  }
  return out;
}

/** Parse `ps -axo pid=,ppid=,%cpu=,rss=` (macOS + Linux). */
export function parsePsProcessTable(stdout: string): ProcessRow[] {
  const out: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const rssKb = parseFloat(parts[3]);
    if (![pid, ppid, cpu, rssKb].every(Number.isFinite)) continue;
    out.push({ pid, ppid, cpu, rssKb });
  }
  return out;
}

/** BFS descendants of `rootPid` (including the root) from a flat process table. */
export function collectProcessTreePids(rootPid: number, rows: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const seen = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return [...seen];
}

/** Extract PSS kilobytes from `/proc/<pid>/smaps_rollup` contents. */
export function parseSmapsRollupPssKb(content: string): number | null {
  // Prefer the dedicated Pss: line; smaps_rollup also has Pss_Anon / Pss_File / Pss_Shmem.
  const match = content.match(/^Pss:\s+(\d+)\s+kB/m);
  if (!match) return null;
  const kb = parseInt(match[1], 10);
  return Number.isFinite(kb) ? kb : null;
}

/**
 * Parse /proc/meminfo. Prefer MemAvailable (accounts for reclaimable cache)
 * over MemFree so alerts match what `free -h` / the kernel report as usable.
 */
export function parseMeminfo(content: string): { totalKb: number; availableKb: number | null; freeKb: number | null } | null {
  const total = content.match(/^MemTotal:\s+(\d+)\s+kB/m);
  if (!total) return null;
  const available = content.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  const free = content.match(/^MemFree:\s+(\d+)\s+kB/m);
  return {
    totalKb: parseInt(total[1], 10),
    availableKb: available ? parseInt(available[1], 10) : null,
    freeKb: free ? parseInt(free[1], 10) : null
  };
}

/**
 * Aggregate tree memory given per-pid PSS (preferred) or RSS fallback.
 * CPU is always the sum of %cpu across the tree.
 */
export function aggregateProcessTreeSample(
  treePids: number[],
  byPid: Map<number, ProcessRow>,
  pssByPid: Map<number, number>
): SampleResult | null {
  if (treePids.length === 0) return null;
  let cpu = 0;
  let rssKb = 0;
  let pssKb = 0;
  let pssHits = 0;
  for (const pid of treePids) {
    const row = byPid.get(pid);
    if (row) {
      cpu += row.cpu;
      rssKb += row.rssKb;
    }
    const pss = pssByPid.get(pid);
    if (pss != null) {
      pssKb += pss;
      pssHits += 1;
    }
  }
  if (pssHits > 0) {
    return {
      cpu: Math.round(cpu * 10) / 10,
      memoryMb: Math.round((pssKb / 1024) * 10) / 10,
      memorySource: "pss"
    };
  }
  if (rssKb <= 0 && cpu === 0) return null;
  return {
    cpu: Math.round(cpu * 10) / 10,
    memoryMb: Math.round((rssKb / 1024) * 10) / 10,
    memorySource: "rss"
  };
}

export function computeUnaccountedMb(hostUsedMb: number, processAttributedMb: number, dockerAttributedMb: number): number {
  return Math.round(Math.max(0, hostUsedMb - processAttributedMb - dockerAttributedMb) * 10) / 10;
}

export function sumContainerMemoryMb(containers: ContainerStat[]): number {
  return Math.round(containers.reduce((sum, c) => sum + c.memoryMb, 0) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

function readSmapsPssKb(pid: number): number | null {
  try {
    const content = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return parseSmapsRollupPssKb(content);
  } catch {
    return null;
  }
}

/**
 * If the root pid has a non-root cgroup v2 path with memory.current, return
 * that single figure (bytes → Mb). Skips `/` so we never attribute the whole
 * host cgroup to one service.
 */
function readOwnCgroupMemoryMb(pid: number): number | null {
  try {
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    // cgroup v2: "0::/path"
    const match = cgroup.match(/^0::(.+)$/m);
    if (!match) return null;
    const rel = match[1].trim();
    if (!rel || rel === "/") return null;
    const currentPath = `/sys/fs/cgroup${rel}/memory.current`;
    const raw = fs.readFileSync(currentPath, "utf8").trim();
    const bytes = parseInt(raw, 10);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Sample CPU% and memory for a process tree rooted at `pid`.
 * See module header for PSS vs RSS / cgroup policy.
 */
export async function sampleProcessTree(pid: number): Promise<SampleResult | null> {
  try {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,%cpu=,rss="]);
    const rows = parsePsProcessTable(stdout);
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    if (!byPid.has(pid)) {
      // Fallback: single-pid sample if the process table walk missed it.
      return sampleSingleProcess(pid);
    }
    const treePids = collectProcessTreePids(pid, rows);
    const pssByPid = new Map<number, number>();
    if (process.platform === "linux") {
      for (const treePid of treePids) {
        const pss = readSmapsPssKb(treePid);
        if (pss != null) pssByPid.set(treePid, pss);
      }
    }
    const aggregated = aggregateProcessTreeSample(treePids, byPid, pssByPid);
    if (aggregated?.memorySource === "pss") return aggregated;

    if (process.platform === "linux") {
      const cgroupMb = readOwnCgroupMemoryMb(pid);
      if (cgroupMb != null && aggregated) {
        return { cpu: aggregated.cpu, memoryMb: cgroupMb, memorySource: "cgroup" };
      }
      if (cgroupMb != null) {
        return { cpu: aggregated?.cpu ?? 0, memoryMb: cgroupMb, memorySource: "cgroup" };
      }
    }
    return aggregated;
  } catch {
    return sampleSingleProcess(pid);
  }
}

/** Legacy single-pid `ps` sample — used only as a last-resort fallback. */
async function sampleSingleProcess(pid: number): Promise<SampleResult | null> {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "%cpu=,rss="]);
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const cpu = parseFloat(parts[0]);
    const rssKb = parseFloat(parts[1]);
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return null;
    return { cpu, memoryMb: Math.round((rssKb / 1024) * 10) / 10, memorySource: "rss" };
  } catch {
    return null;
  }
}

/**
 * Sample CPU% and memory for a running Docker container via `docker stats`.
 * MemUsage is the cache-adjusted figure (usage − inactive_file on cgroup v2).
 */
export async function sampleContainer(name: string): Promise<SampleResult | null> {
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
      name
    ]);
    const row = parseDockerStatsLine(stdout.trim().split("\n")[0] ?? "");
    if (!row) return null;
    return { cpu: row.cpu, memoryMb: row.memoryMb, memorySource: "docker_stats" };
  } catch {
    return null;
  }
}

/** List running container names for a compose project via the compose project label. */
export async function listComposeContainerNames(project: string): Promise<string[]> {
  try {
    const { stdout } = await exec("docker", [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Names}}"
    ]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Sum docker-stats CPU and MemUsage across every running container in a
 * compose project. One metrics row is recorded for the ServerHoster service id.
 */
export async function sampleComposeProject(project: string): Promise<SampleResult | null> {
  const names = await listComposeContainerNames(project);
  if (names.length === 0) return null;
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
      ...names
    ]);
    const rows = parseDockerStatsOutput(stdout);
    if (rows.length === 0) return null;
    const cpu = Math.round(rows.reduce((s, r) => s + r.cpu, 0) * 10) / 10;
    const memoryMb = sumContainerMemoryMb(rows);
    return { cpu, memoryMb, memorySource: "docker_stats" };
  } catch {
    // Fall back to per-container sampling if a bulk stats call fails.
    let cpu = 0;
    let memoryMb = 0;
    let hits = 0;
    for (const name of names) {
      const sample = await sampleContainer(name);
      if (!sample) continue;
      cpu += sample.cpu;
      memoryMb += sample.memoryMb;
      hits += 1;
    }
    if (hits === 0) return null;
    return {
      cpu: Math.round(cpu * 10) / 10,
      memoryMb: Math.round(memoryMb * 10) / 10,
      memorySource: "docker_stats"
    };
  }
}

/** All running containers' docker-stats snapshot, sorted by memory desc. */
export async function listTopContainersByMemory(limit = TOP_CONTAINERS_LIMIT): Promise<ContainerStat[]> {
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"
    ]);
    return parseDockerStatsOutput(stdout)
      .sort((a, b) => b.memoryMb - a.memoryMb)
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

export function readHostMemory(): HostMemoryInfo {
  const totalMb = Math.round((os.totalmem() / 1024 / 1024) * 10) / 10;
  if (process.platform === "linux") {
    try {
      const parsed = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"));
      if (parsed?.availableKb != null) {
        const availableMb = Math.round((parsed.availableKb / 1024) * 10) / 10;
        const usedMb = Math.round(Math.max(0, totalMb - availableMb) * 10) / 10;
        return { totalMb, availableMb, usedMb, source: "memavailable" };
      }
    } catch {
      /* fall through */
    }
  }
  const freeMb = Math.round((os.freemem() / 1024 / 1024) * 10) / 10;
  return {
    totalMb,
    availableMb: freeMb,
    usedMb: Math.round(Math.max(0, totalMb - freeMb) * 10) / 10,
    source: "freemem"
  };
}

/**
 * Read-only host memory breakdown for health/alerts: MemAvailable-style used,
 * top Docker containers (including ones ServerHoster does not own), and the
 * unaccounted remainder after process + docker attribution.
 */
export async function getHostMemoryBreakdown(
  opts: { processAttributedMb?: number; limit?: number } = {}
): Promise<HostMemoryBreakdown> {
  const host = readHostMemory();
  const limit = opts.limit ?? TOP_CONTAINERS_LIMIT;
  let allContainers: ContainerStat[] = [];
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"
    ]);
    allContainers = parseDockerStatsOutput(stdout);
  } catch {
    allContainers = [];
  }
  const topContainers = [...allContainers].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, Math.max(1, limit));
  const dockerAttributedMb = sumContainerMemoryMb(allContainers);
  const processAttributedMb = opts.processAttributedMb ?? lastProcessAttributedMb;
  const measuredMb = Math.round((processAttributedMb + dockerAttributedMb) * 10) / 10;
  return {
    totalMb: host.totalMb,
    availableMb: host.availableMb,
    usedMb: host.usedMb,
    hostMemorySource: host.source,
    processAttributedMb,
    dockerAttributedMb,
    measuredMb,
    unaccountedMb: computeUnaccountedMb(host.usedMb, processAttributedMb, dockerAttributedMb),
    topContainers,
    checkedAt: nowIso()
  };
}

function resolveComposeProjectName(ctx: AppContext, serviceId: string, stored: string | null | undefined): string | null {
  const fromColumn = stored?.trim();
  if (fromColumn) return fromColumn;
  try {
    const projectPath = path.join(ctx.config.projectsDir, serviceId);
    const cfg = resolveComposeConfig(ctx, serviceId, projectPath);
    return cfg?.project ?? null;
  } catch {
    return null;
  }
}

function recordSample(ctx: AppContext, serviceId: string, cpu: number, memoryMb: number): void {
  const row = {
    id: nanoid(),
    service_id: serviceId,
    cpu_percent: cpu,
    memory_mb: memoryMb,
    timestamp: nowIso()
  };
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
    let processAttributedMb = 0;
    try {
      const rows = ctx.db
        .prepare("SELECT id, type, status, compose_project FROM services WHERE status = 'running'")
        .all() as Array<{ id: string; type: string; status: string; compose_project?: string | null }>;

      for (const row of rows) {
        try {
          if (row.type === "compose") {
            const project = resolveComposeProjectName(ctx, row.id, row.compose_project);
            if (!project) continue;
            const sample = await sampleComposeProject(project);
            if (sample) recordSample(ctx, row.id, sample.cpu, sample.memoryMb);
          } else if (row.type === "docker") {
            const sample = await sampleContainer(`survhub-${row.id}`);
            if (sample) recordSample(ctx, row.id, sample.cpu, sample.memoryMb);
          } else {
            const runtime = ctx.runtimeProcesses.get(row.id);
            const pid = runtime?.process.pid;
            if (!pid) continue;
            const sample = await sampleProcessTree(pid);
            if (sample) {
              processAttributedMb += sample.memoryMb;
              recordSample(ctx, row.id, sample.cpu, sample.memoryMb);
            }
          }
        } catch (error) {
          ctx.app.log.warn(`metrics sample failed for ${row.id}: ${serializeError(error)}`);
        }
      }

      lastProcessAttributedMb = Math.round(processAttributedMb * 10) / 10;
      trimOldMetrics(ctx);
    } catch (error) {
      // Never throw out of the tick — log and continue on the next interval.
      try {
        ctx.app.log.warn(`metrics tick failed: ${serializeError(error)}`);
      } catch {
        /* ignore logging failures */
      }
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

export function getLatestMetrics(
  ctx: AppContext
): Record<string, { cpu: number; memoryMb: number; timestamp: string }> {
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

/**
 * Sequence 4 — service-level KPIs.
 *
 * Counters live in-process (no separate metrics backend); the Prometheus
 * scrape endpoint reads them via the snapshot helper below. We keep a
 * bounded histogram of the last 256 deploy durations so we can render a
 * p50/p95 in the dashboard without a time-series DB.
 *
 * `failureStage` is the canonical state from `deployStateMachine`
 * ("queued" | "cloning" | "building" | "starting" | "unknown"); we keep one
 * counter per stage so operators can see at a glance whether failures are
 * concentrated in clone vs. build.
 */
type DeployKpiState = {
  totalDeployments: number;
  failedDeployments: number;
  failureByStage: Record<string, number>;
  durationHistory: Array<{ serviceId: string; durationMs: number; ts: string }>;
};

const KPI_STATE: DeployKpiState = {
  totalDeployments: 0,
  failedDeployments: 0,
  failureByStage: {},
  durationHistory: []
};
const KPI_HISTORY_LIMIT = 256;

export function recordDeployDuration(_ctx: AppContext, serviceId: string, durationMs: number): void {
  KPI_STATE.totalDeployments += 1;
  KPI_STATE.durationHistory.push({ serviceId, durationMs, ts: nowIso() });
  if (KPI_STATE.durationHistory.length > KPI_HISTORY_LIMIT) {
    KPI_STATE.durationHistory.splice(0, KPI_STATE.durationHistory.length - KPI_HISTORY_LIMIT);
  }
}

export function recordDeployFailure(_ctx: AppContext, _serviceId: string, stage: string): void {
  KPI_STATE.totalDeployments += 1;
  KPI_STATE.failedDeployments += 1;
  KPI_STATE.failureByStage[stage] = (KPI_STATE.failureByStage[stage] ?? 0) + 1;
}

/** Snapshot of the in-process KPI counters for /metrics/prometheus and /metrics/kpis. */
export function snapshotDeployKpis(): {
  totalDeployments: number;
  failedDeployments: number;
  failureByStage: Record<string, number>;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
} {
  const sorted = KPI_STATE.durationHistory.map((h) => h.durationMs).sort((a, b) => a - b);
  const pct = (p: number): number | null => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };
  return {
    totalDeployments: KPI_STATE.totalDeployments,
    failedDeployments: KPI_STATE.failedDeployments,
    failureByStage: { ...KPI_STATE.failureByStage },
    durationP50Ms: pct(50),
    durationP95Ms: pct(95)
  };
}

/**
 * Test-only reset hook — keeps unit tests independent without exposing
 * mutable state through the public API.
 */
export function __resetDeployKpisForTest(): void {
  KPI_STATE.totalDeployments = 0;
  KPI_STATE.failedDeployments = 0;
  KPI_STATE.failureByStage = {};
  KPI_STATE.durationHistory.length = 0;
}

/** Test-only: reset last process attribution between cases. */
export function __resetProcessAttributionForTest(): void {
  lastProcessAttributedMb = 0;
}
