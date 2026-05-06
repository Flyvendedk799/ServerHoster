import type { AppContext } from "../types.js";
import { createBackup, getDatabase, type DatabaseRow } from "./databases.js";

/**
 * Scheduled DB backup loop. Reads `backup_schedule.*` settings to decide
 * cadence, runs `createBackup` over each managed database, prunes anything
 * older than the configured retention count.
 *
 * Settings keys:
 *   backup_schedule.enabled        "1" | "0"        (default "0")
 *   backup_schedule.interval_hours "24" | "168" ... (default "24")
 *   backup_schedule.retain         "7"              (default "7")
 *
 * Surfaced via the existing `/settings` API; no new routes needed.
 */

const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly tick; the schedule-respecting filter runs inside.

function getSetting(ctx: AppContext, key: string): string | null {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

function getNumberSetting(ctx: AppContext, key: string, fallback: number): number {
  const raw = getSetting(ctx, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function pruneOldBackups(ctx: AppContext, dbId: string, retain: number): Promise<void> {
  const rows = ctx.db
    .prepare("SELECT id, filename FROM database_backups WHERE database_id = ? ORDER BY created_at DESC")
    .all(dbId) as Array<{ id: string; filename: string }>;
  const stale = rows.slice(retain);
  for (const row of stale) {
    ctx.db.prepare("DELETE FROM database_backups WHERE id = ?").run(row.id);
    // We deliberately leave the on-disk file alone for now; manual cleanup
    // tools can sweep `~/.survhub/backups/` if needed. Removing here would
    // need a shared resolveBackupPath import + careful absolute-path checks.
  }
}

async function runScheduledBackups(ctx: AppContext): Promise<void> {
  if (getSetting(ctx, "backup_schedule.enabled") !== "1") return;
  const intervalHours = getNumberSetting(ctx, "backup_schedule.interval_hours", 24);
  const retain = Math.max(1, Math.floor(getNumberSetting(ctx, "backup_schedule.retain", 7)));

  const lastRunRaw = getSetting(ctx, "backup_schedule.last_run_at");
  const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : 0;
  if (lastRunMs && Date.now() - lastRunMs < intervalHours * 60 * 60 * 1000) return;

  const databases = ctx.db.prepare("SELECT id FROM databases").all() as Array<{ id: string }>;
  for (const { id } of databases) {
    const db: DatabaseRow | null = getDatabase(ctx, id);
    if (!db) continue;
    try {
      await createBackup(ctx, db);
      await pruneOldBackups(ctx, id, retain);
    } catch (err) {
      ctx.app.log?.warn?.({ err, dbId: id }, "scheduled_backup_failed");
    }
  }

  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("backup_schedule.last_run_at", new Date().toISOString());
}

export function startScheduledBackupsLoop(ctx: AppContext): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void runScheduledBackups(ctx).catch((err) => ctx.app.log?.warn?.({ err }, "scheduled_backup_loop_error"));
  };
  // Defer the first tick so it doesn't race with boot/migrations.
  const initial = setTimeout(tick, 30_000);
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(handle);
  };
}
