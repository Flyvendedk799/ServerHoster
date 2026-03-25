import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

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
        const keys = Object.keys(rows[0] ?? {});
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => "?").join(", ");
        const insert = ctx.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`);
        for (const row of rows) {
          insert.run(...keys.map((k) => row[k]));
        }
      }
    });
    tx();
    return { ok: true };
  });
}
