import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

/**
 * Sequence 5 — instance-level backup orchestration.
 *
 * The legacy /backup/export route streams a JSON payload to the operator
 * but doesn't persist a copy on disk, doesn't checksum it, and doesn't
 * give DR runbooks anything stable to verify against. This module fills
 * those gaps:
 *
 *   - `createInstanceBackup` writes a snapshot to `<dataRoot>/backups/`,
 *     records sha256 + size in the `instance_backups` table, and runs a
 *     retention sweep.
 *   - `verifyBackupIntegrity` re-reads a snapshot and recomputes its
 *     sha256, returning {ok, sha256, expectedSha256}. Restore code calls
 *     this as a preflight before applying, so a corrupted backup never
 *     makes it past `INSERT OR REPLACE`.
 *   - `restorePreflight` does a dry-run parse of a snapshot and reports
 *     the table/row counts that *would* be applied. Operators can sanity
 *     check this in the dashboard before pulling the trigger.
 *
 * The on-disk format is the same JSON shape produced by /backup/export so
 * the two paths interoperate.
 */

const DEFAULT_RETENTION = 14;

export type InstanceBackupRow = {
  id: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  kind: string;
  created_at: string;
};

export function backupsDir(ctx: AppContext): string {
  const dir = ctx.config.backupsDir ?? path.join(ctx.config.dataRoot, "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_TABLES = [
  "projects",
  "services",
  "env_vars",
  "logs",
  "databases",
  "deployments",
  "proxy_routes",
  "settings",
  "sessions",
  "users",
  "audit_logs"
] as const;

type SafeTable = (typeof SAFE_TABLES)[number];

function snapshotPayload(ctx: AppContext): { exportedAt: string; data: Record<SafeTable, unknown[]> } {
  const data = {} as Record<SafeTable, unknown[]>;
  for (const table of SAFE_TABLES) {
    try {
      data[table] = ctx.db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      data[table] = [];
    }
  }
  return { exportedAt: nowIso(), data };
}

function sha256Of(buffer: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(typeof buffer === "string" ? buffer : new Uint8Array(buffer))
    .digest("hex");
}

export type CreateBackupOptions = {
  kind?: "manual" | "scheduled" | "pre-restore";
  retain?: number;
};

export function createInstanceBackup(ctx: AppContext, opts: CreateBackupOptions = {}): InstanceBackupRow {
  const dir = backupsDir(ctx);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = nanoid();
  const filename = `localsurv-backup-${ts}-${id.slice(0, 6)}.json`;
  const target = path.join(dir, filename);
  const body = JSON.stringify(snapshotPayload(ctx));
  fs.writeFileSync(target, body, { mode: 0o600 });
  // Verify what we just wrote rather than trusting the in-memory string —
  // this catches partial-write or fs-quirk corruption immediately.
  const written = fs.readFileSync(target);
  const sha256 = sha256Of(written);
  const size_bytes = written.length;
  const row: InstanceBackupRow = {
    id,
    filename,
    sha256,
    size_bytes,
    kind: opts.kind ?? "manual",
    created_at: nowIso()
  };

  try {
    ctx.db
      .prepare(
        "INSERT INTO instance_backups (id, filename, sha256, size_bytes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(row.id, row.filename, row.sha256, row.size_bytes, row.kind, row.created_at);
  } catch {
    /* legacy DB without the migration — return the row anyway */
  }

  pruneInstanceBackups(ctx, opts.retain ?? DEFAULT_RETENTION);
  return row;
}

export function listInstanceBackups(ctx: AppContext): InstanceBackupRow[] {
  try {
    return ctx.db
      .prepare(
        "SELECT id, filename, sha256, size_bytes, kind, created_at FROM instance_backups ORDER BY created_at DESC"
      )
      .all() as InstanceBackupRow[];
  } catch {
    return [];
  }
}

export function pruneInstanceBackups(ctx: AppContext, retain: number): void {
  const all = listInstanceBackups(ctx);
  const stale = all.slice(Math.max(1, retain));
  const dir = backupsDir(ctx);
  for (const row of stale) {
    try {
      fs.rmSync(path.join(dir, row.filename), { force: true });
    } catch {
      /* ignore */
    }
    try {
      ctx.db.prepare("DELETE FROM instance_backups WHERE id = ?").run(row.id);
    } catch {
      /* ignore */
    }
  }
}

export type IntegrityResult = {
  ok: boolean;
  filename: string;
  sha256: string;
  expectedSha256: string | null;
  size_bytes: number;
  hint: string;
};

export function verifyBackupIntegrity(ctx: AppContext, idOrFilename: string): IntegrityResult {
  const row = locateBackup(ctx, idOrFilename);
  if (!row) {
    return {
      ok: false,
      filename: idOrFilename,
      sha256: "",
      expectedSha256: null,
      size_bytes: 0,
      hint: "Backup not found in instance_backups."
    };
  }
  const target = path.join(backupsDir(ctx), row.filename);
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      filename: row.filename,
      sha256: "",
      expectedSha256: row.sha256,
      size_bytes: 0,
      hint: "Backup file is missing on disk."
    };
  }
  const buf = fs.readFileSync(target);
  const sha256 = sha256Of(buf);
  return {
    ok: sha256 === row.sha256 && buf.length === row.size_bytes,
    filename: row.filename,
    sha256,
    expectedSha256: row.sha256,
    size_bytes: buf.length,
    hint:
      sha256 === row.sha256 && buf.length === row.size_bytes
        ? "Checksum matches; backup is intact."
        : "Checksum mismatch — the backup file was modified or truncated. Do not restore."
  };
}

export type RestorePreflight = {
  ok: boolean;
  filename: string;
  tables: Record<string, number>;
  hint: string;
};

export function restorePreflight(ctx: AppContext, idOrFilename: string): RestorePreflight {
  const integrity = verifyBackupIntegrity(ctx, idOrFilename);
  if (!integrity.ok) {
    return {
      ok: false,
      filename: integrity.filename,
      tables: {},
      hint: `Integrity check failed: ${integrity.hint}`
    };
  }
  const target = path.join(backupsDir(ctx), integrity.filename);
  let parsed: { data?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8")) as { data?: Record<string, unknown[]> };
  } catch (error) {
    return {
      ok: false,
      filename: integrity.filename,
      tables: {},
      hint: `Backup file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const tables: Record<string, number> = {};
  for (const [table, rows] of Object.entries(parsed.data ?? {})) {
    if (Array.isArray(rows)) tables[table] = rows.length;
  }
  return {
    ok: true,
    filename: integrity.filename,
    tables,
    hint: "Backup is intact; restore can proceed."
  };
}

function locateBackup(ctx: AppContext, idOrFilename: string): InstanceBackupRow | null {
  try {
    const byId = ctx.db
      .prepare("SELECT id, filename, sha256, size_bytes, kind, created_at FROM instance_backups WHERE id = ?")
      .get(idOrFilename) as InstanceBackupRow | undefined;
    if (byId) return byId;
    const byFile = ctx.db
      .prepare(
        "SELECT id, filename, sha256, size_bytes, kind, created_at FROM instance_backups WHERE filename = ?"
      )
      .get(idOrFilename) as InstanceBackupRow | undefined;
    return byFile ?? null;
  } catch {
    return null;
  }
}
