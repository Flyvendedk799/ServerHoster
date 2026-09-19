import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppContext } from "../types.js";
import { createNotification } from "./notifications.js";
import { getSetting, getSecretSetting } from "./settings.js";
import { serializeError, withTimeout } from "../lib/core.js";

const exec = promisify(execFile);

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_DISK_WARN_PERCENT = 85;
const DEFAULT_MEMORY_ALERT_THRESHOLD = 80;
/** Bound host probes so MCP/REST health never hangs on a stuck Docker socket or df. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

export type DiskInfo = {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
};

export type SystemHealth = {
  disk: DiskInfo | null;
  dockerOk: boolean;
  dockerError: string | null;
  memoryUsedPercent: number;
  loadAvg1m: number;
  score: number;
  warnings: string[];
  checkedAt: string;
};

/** Cross-platform disk check via `df -k`. Returns KB → bytes. */
export async function checkDisk(path: string): Promise<DiskInfo | null> {
  try {
    const { stdout } = await exec("df", ["-k", path], { timeout: HEALTH_PROBE_TIMEOUT_MS });
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    // Layout: Filesystem 1K-blocks Used Available Capacity Mounted on
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const free = Number(parts[3]) * 1024;
    const usedPercent = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
    return { path, totalBytes: total, freeBytes: free, usedPercent };
  } catch {
    return null;
  }
}

async function checkDocker(ctx: AppContext): Promise<{ ok: boolean; error: string | null }> {
  try {
    await withTimeout(ctx.docker.ping(), HEALTH_PROBE_TIMEOUT_MS, "Docker ping");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectSystemHealth(ctx: AppContext): Promise<SystemHealth> {
  const dataDir = ctx.config.dataRoot ?? os.homedir();
  const [disk, docker] = await Promise.all([
    checkDisk(fs.existsSync(dataDir) ? dataDir : os.homedir()),
    checkDocker(ctx)
  ]);
  const memoryUsedPercent =
    os.totalmem() > 0 ? Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 10000) / 100 : 0;
  const loadAvg1m = os.loadavg()[0] ?? 0;

  const warnings: string[] = [];
  if (disk && disk.usedPercent >= DEFAULT_DISK_WARN_PERCENT) {
    warnings.push(`Disk ${disk.path} is ${disk.usedPercent}% full`);
  }
  if (!docker.ok) warnings.push(`Docker daemon unreachable: ${docker.error ?? "unknown"}`);
  if (memoryUsedPercent >= 90) warnings.push(`Memory is ${memoryUsedPercent}% used`);

  // Score starts at 100, deducts for warnings and severity.
  let score = 100;
  if (!docker.ok) score -= 25;
  if (disk && disk.usedPercent >= 95) score -= 30;
  else if (disk && disk.usedPercent >= DEFAULT_DISK_WARN_PERCENT) score -= 10;
  if (memoryUsedPercent >= 95) score -= 20;
  else if (memoryUsedPercent >= 85) score -= 5;
  score = Math.max(0, score);

  return {
    disk,
    dockerOk: docker.ok,
    dockerError: docker.error,
    memoryUsedPercent,
    loadAvg1m,
    score,
    warnings,
    checkedAt: new Date().toISOString()
  };
}

async function postMemoryAlertWebhook(
  ctx: AppContext,
  health: SystemHealth
): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = getSecretSetting(ctx, "host_memory_alert_webhook_url");
  if (!webhookUrl) return { ok: false, error: "No webhook URL configured" };

  const authHeader = getSecretSetting(ctx, "host_memory_alert_webhook_auth");
  const threshold = Number(getSetting(ctx, "host_memory_alert_threshold") ?? DEFAULT_MEMORY_ALERT_THRESHOLD);

  const payload = {
    event: "host_memory_threshold_crossed",
    memoryUsedPercent: health.memoryUsedPercent,
    threshold,
    hostname: os.hostname(),
    checkedAt: health.checkedAt,
    loadAvg1m: health.loadAvg1m,
    disk: health.disk
      ? {
          path: health.disk.path,
          usedPercent: health.disk.usedPercent,
          freeBytes: health.disk.freeBytes
        }
      : null
  };

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) {
      headers.Authorization = authHeader.startsWith("Bearer ") ? authHeader : `Bearer ${authHeader}`;
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      return { ok: false, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

export function startSystemHealthLoop(ctx: AppContext): () => void {
  let lastDiskWarnedAt = 0;
  let lastDockerWarnedAt = 0;
  let memoryAlertActive = false;
  let lastMemoryAlertAt = 0;

  const tick = async (): Promise<void> => {
    try {
      const health = await collectSystemHealth(ctx);
      const now = Date.now();
      const warnIntervalMs = 60 * 60 * 1000; // once per hour per issue

      const diskThreshold = Number(getSetting(ctx, "disk_warn_percent") ?? DEFAULT_DISK_WARN_PERCENT);
      if (health.disk && health.disk.usedPercent >= diskThreshold && now - lastDiskWarnedAt > warnIntervalMs) {
        lastDiskWarnedAt = now;
        createNotification(ctx, {
          kind: "disk",
          severity: health.disk.usedPercent >= 95 ? "error" : "warning",
          title: `Disk ${health.disk.usedPercent}% full`,
          body: `${health.disk.path} has ${(health.disk.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free.`
        });
      }
      if (!health.dockerOk && now - lastDockerWarnedAt > warnIntervalMs) {
        lastDockerWarnedAt = now;
        createNotification(ctx, {
          kind: "system",
          severity: "error",
          title: "Docker daemon unreachable",
          body: health.dockerError ?? undefined
        });
      }

      const memoryAlertEnabled = getSetting(ctx, "host_memory_alert_enabled") === "1";
      if (memoryAlertEnabled) {
        const memoryThreshold = Number(
          getSetting(ctx, "host_memory_alert_threshold") ?? DEFAULT_MEMORY_ALERT_THRESHOLD
        );

        if (health.memoryUsedPercent >= memoryThreshold) {
          if (!memoryAlertActive) {
            memoryAlertActive = true;
            lastMemoryAlertAt = now;
            const result = await postMemoryAlertWebhook(ctx, health);
            if (result.ok) {
              ctx.app.log.info(
                { memoryUsedPercent: health.memoryUsedPercent, threshold: memoryThreshold },
                "Host memory alert webhook posted successfully"
              );
            } else {
              ctx.app.log.error(
                { error: result.error, memoryUsedPercent: health.memoryUsedPercent },
                "Host memory alert webhook failed"
              );
            }
          }
        } else {
          if (memoryAlertActive) {
            memoryAlertActive = false;
            ctx.app.log.info(
              { memoryUsedPercent: health.memoryUsedPercent, threshold: memoryThreshold },
              "Host memory dropped below threshold, alert re-armed"
            );
          }
        }
      }
    } catch {
      /* don't crash the loop */
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
  void tick();
  return () => clearInterval(interval);
}
