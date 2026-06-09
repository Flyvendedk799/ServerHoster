import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import {
  createInstanceBackup,
  listInstanceBackups,
  verifyBackupIntegrity,
  restorePreflight
} from "../services/backup.js";

const safeTables = new Set([
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
]);

const importSchema = z.object({
  data: z.record(z.array(z.record(z.unknown())))
});

export function registerBackupRoutes(ctx: AppContext): void {
  ctx.app.get("/backup/export", async () => {
    const data: Record<string, unknown[]> = {};
    for (const table of safeTables) {
      data[table] = ctx.db.prepare(`SELECT * FROM ${table}`).all();
    }
    return { exportedAt: nowIso(), data };
  });

  ctx.app.post("/backup/import", async (req) => {
    const payload = importSchema.parse(req.body);
    const tx = ctx.db.transaction(() => {
      for (const [table, rows] of Object.entries(payload.data)) {
        if (!safeTables.has(table) || rows.length === 0) continue;
        // Column names come from arbitrary client JSON and were interpolated raw
        // into the SQL — validate every key against the table's real schema and
        // quote identifiers, so a crafted import can't inject SQL or touch
        // columns that don't exist.
        const validCols = new Set(
          (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (c) => c.name
          )
        );
        const keys = Object.keys(rows[0] ?? {}).filter((k) => validCols.has(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => "?").join(", ");
        const insert = ctx.db.prepare(
          `INSERT OR REPLACE INTO ${table} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders})`
        );
        for (const row of rows) {
          insert.run(...keys.map((k) => row[k]));
        }
      }
    });
    tx();
    return { ok: true };
  });

  /**
   * Sequence 5 — instance backup orchestration.
   *
   * Creates an on-disk snapshot under `<dataRoot>/backups/`, returns the
   * checksum and metadata so DR runbooks have something to verify.
   */
  ctx.app.post("/backup/instance", async (req) => {
    const body = z
      .object({
        kind: z.enum(["manual", "scheduled", "pre-restore"]).default("manual"),
        retain: z.number().int().min(1).max(365).optional()
      })
      .parse(req.body ?? {});
    return createInstanceBackup(ctx, body);
  });

  ctx.app.get("/backup/instance", async () => ({ items: listInstanceBackups(ctx) }));

  ctx.app.get("/backup/instance/:id/verify", async (req) => {
    const { id } = req.params as { id: string };
    return verifyBackupIntegrity(ctx, id);
  });

  ctx.app.post("/backup/instance/:id/restore-preflight", async (req) => {
    const { id } = req.params as { id: string };
    return restorePreflight(ctx, id);
  });
}
