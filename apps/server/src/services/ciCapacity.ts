/**
 * How many CI jobs may run at once on this host, and whether one more fits.
 *
 * Each job already has hard per-container limits (memory without swap, CPU
 * quota, pids, timeout). This module adds a host-wide budget so the sum of
 * running jobs stays under a fraction of the machine, leaving the rest for the
 * services ServerHoster actually hosts. Jobs that do not fit wait in the queue.
 */
import os from "node:os";
import type { AppContext } from "../types.js";
import { getSetting, setSetting, deleteSetting } from "./settings.js";

export type HostCapacity = { cpus: number; totalMemMb: number; freeMemMb: number };
export type JobSize = { memoryMb: number; cpus: number };

export const CI_MAX_CONCURRENT_CAP = 4;
export const DEFAULT_HOST_BUDGET_PERCENT = 50;
/** Extra RAM that must stay free before a second (third, …) job starts. */
export const FREE_MEM_HEADROOM_MB = 1024;
export const DEFAULT_CACHE_MAX_MB = 5120;
export const DEFAULT_WORKSPACE_MAX_MB = 10240;

let hostOverride: HostCapacity | null = null;

/** Tests pin the host so scheduling does not depend on the runner's free RAM. */
export function setHostCapacityForTests(host: HostCapacity | null): void {
  hostOverride = host;
}

export function detectHostCapacity(): HostCapacity {
  if (hostOverride) return hostOverride;
  const cpus =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : Math.max(1, os.cpus().length);
  return {
    cpus: Math.max(1, cpus),
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.floor(os.freemem() / 1024 / 1024)
  };
}

/** About one job per 2 cores and per 2.5 GB of free RAM; at least 1, at most 4. */
export function defaultMaxConcurrent(host: HostCapacity): number {
  const byCpu = Math.floor(host.cpus / 2);
  const byMem = Math.floor(host.freeMemMb / 2560);
  return Math.max(1, Math.min(CI_MAX_CONCURRENT_CAP, byCpu, byMem));
}

export type CiCapacitySettings = {
  /** null = automatic from the host. */
  maxConcurrent: number | null;
  budgetPercent: number;
  readonlyRootfs: boolean;
  cacheMaxMb: number;
  workspaceMaxMb: number;
};

function intSetting(ctx: AppContext, key: string, min: number, max: number): number | null {
  const raw = getSetting(ctx, key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function readCiCapacitySettings(ctx: AppContext): CiCapacitySettings {
  return {
    maxConcurrent: intSetting(ctx, "ci_max_concurrent", 1, 16),
    budgetPercent: intSetting(ctx, "ci_host_budget_percent", 10, 90) ?? DEFAULT_HOST_BUDGET_PERCENT,
    readonlyRootfs: getSetting(ctx, "ci_readonly_rootfs") !== "0",
    cacheMaxMb: intSetting(ctx, "ci_cache_max_mb", 0, 512_000) ?? DEFAULT_CACHE_MAX_MB,
    workspaceMaxMb: intSetting(ctx, "ci_workspace_max_mb", 512, 512_000) ?? DEFAULT_WORKSPACE_MAX_MB
  };
}

export function writeCiCapacitySettings(ctx: AppContext, next: Partial<CiCapacitySettings>): void {
  const put = (key: string, value: number | boolean | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) deleteSetting(ctx, key);
    else setSetting(ctx, key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  };
  put("ci_max_concurrent", next.maxConcurrent);
  put("ci_host_budget_percent", next.budgetPercent);
  put("ci_readonly_rootfs", next.readonlyRootfs);
  put("ci_cache_max_mb", next.cacheMaxMb);
  put("ci_workspace_max_mb", next.workspaceMaxMb);
}

export function effectiveMaxConcurrent(settings: CiCapacitySettings, host: HostCapacity): number {
  return settings.maxConcurrent ?? defaultMaxConcurrent(host);
}

export type Admission = { admit: true } | { admit: false; reason: string };

/**
 * Decide whether `next` may start next to `running`.
 *
 * The first job always starts, even if it is larger than the budget, so a
 * small host can still run one job at a time instead of queueing forever.
 */
export function admitJob(
  running: JobSize[],
  next: JobSize,
  host: HostCapacity,
  settings: CiCapacitySettings
): Admission {
  if (running.length === 0) return { admit: true };
  const max = effectiveMaxConcurrent(settings, host);
  if (running.length >= max) return { admit: false, reason: `${max} job(s) already running` };
  const share = settings.budgetPercent / 100;
  const memBudget = host.totalMemMb * share;
  const cpuBudget = host.cpus * share;
  const usedMem = running.reduce((sum, job) => sum + job.memoryMb, 0);
  const usedCpu = running.reduce((sum, job) => sum + job.cpus, 0);
  if (usedMem + next.memoryMb > memBudget) {
    return {
      admit: false,
      reason: `CI memory budget (${Math.round(memBudget)} MB, ${settings.budgetPercent}% of host) is in use`
    };
  }
  if (usedCpu + next.cpus > cpuBudget + 1e-9) {
    return {
      admit: false,
      reason: `CI CPU budget (${cpuBudget.toFixed(1)} cores, ${settings.budgetPercent}% of host) is in use`
    };
  }
  if (host.freeMemMb < next.memoryMb + FREE_MEM_HEADROOM_MB) {
    return { admit: false, reason: `only ${host.freeMemMb} MB of RAM is free on the host` };
  }
  return { admit: true };
}
