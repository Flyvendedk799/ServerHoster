import fs from "node:fs";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  assertPortAvailable,
  broadcastTransferEvent,
  dbReservedPorts,
  findFreePort,
  nowIso
} from "../lib/core.js";
import { encryptSecret } from "../security.js";
import {
  buildConnectionString,
  containerAction,
  containerNameForDatabase,
  createBackup,
  createManagedDatabase,
  getContainerLogs,
  getContainerStatus,
  getDatabase,
  getDatabaseSizeBytes,
  importSqliteIntoPostgres,
  listBackups,
  listTables,
  pingExternalDatabase,
  previewTable,
  removeDatabase,
  resolveBackupPath,
  restoreBackup,
  runSeed,
  transferToExternal,
  transferToExternalStream,
  waitForPostgresReady,
  type DatabaseRow
} from "../services/databases.js";
import { listEmbeddedDatabases, listOrphanServices } from "../services/embeddedDatabases.js";
import { restartService } from "../services/runtime.js";

const databaseSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  engine: z.enum(["postgres", "mysql", "redis", "mongo"]),
  port: z.number().int(),
  username: z.string().optional(),
  password: z.string().optional(),
  databaseName: z.string().optional()
});

const linkSchema = z.object({ serviceId: z.string(), databaseId: z.string().nullable() });
const seedSchema = z.object({ sql: z.string().min(1) });
const restoreSchema = z.object({ backupId: z.string() });

const promoteSchema = z.object({
  mode: z.enum(["managed", "external"]),
  // managed mode: spin up a new Postgres for this service
  databaseName: z.string().optional(),
  importSql: z.string().optional(),
  /** Strict: attempt the SQLite import; surface an error if no file is found. */
  importEmbeddedSqlite: z.boolean().default(false),
  /** Lenient: try the SQLite import opportunistically; if the file isn't
   *  detected (e.g. service is stopped), silently skip and leave the new DB empty.
   *  Used by the one-click banner on the Services page. */
  autoImportEmbedded: z.boolean().default(false),
  // external mode: point the service at an existing DATABASE_URL
  externalUrl: z.string().optional(),
  restart: z.boolean().default(true)
});

const transferSchema = z.object({
  externalUrl: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "externalUrl must be a valid URL" }
    )
});

export function registerDatabaseRoutes(ctx: AppContext): void {
  ctx.app.get("/databases", async () => {
    const rows = ctx.db.prepare("SELECT * FROM databases ORDER BY created_at DESC").all() as DatabaseRow[];
    // Bulk-fetch the last-backup map once instead of per-row.
    const lastBackups = ctx.db
      .prepare(
        "SELECT database_id, MAX(created_at) AS last_backup_at FROM database_backups GROUP BY database_id"
      )
      .all() as Array<{ database_id: string; last_backup_at: string }>;
    const lastBackupMap = new Map(lastBackups.map((r) => [r.database_id, r.last_backup_at]));
    // Enrich with live container state + cheap engine-native size.
    return Promise.all(
      rows.map(async (row) => {
        const status = await getContainerStatus(ctx, row);
        const size_bytes = status.state === "running" ? await getDatabaseSizeBytes(row) : null;
        return {
          ...row,
          container_status: status,
          stats: {
            size_bytes,
            last_backup_at: lastBackupMap.get(row.id) ?? null
          }
        };
      })
    );
  });

  ctx.app.get("/databases/:id", async (req) => {
    const { id } = req.params as { id: string };
    const db = getDatabase(ctx, id);
    if (!db) throw new Error("Database not found");
    const status = await getContainerStatus(ctx, db);
    return { ...db, container_status: status, connection_string: buildConnectionString(db) };
  });

  ctx.app.post("/databases", async (req) => {
    const p = databaseSchema.parse(req.body);
    // Reject up front if the requested host port is already claimed by another
    // service or database — avoids a doomed container create + a port clash.
    assertPortAvailable(ctx, p.port);
    return createManagedDatabase(ctx, {
      projectId: p.projectId,
      name: p.name,
      engine: p.engine,
      port: p.port,
      username: p.username,
      password: p.password,
      databaseName: p.databaseName
    });
  });

  ctx.app.post("/databases/:id/start", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    await containerAction(ctx, db, "start");
    return { ok: true };
  });
  ctx.app.post("/databases/:id/stop", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    await containerAction(ctx, db, "stop");
    return { ok: true };
  });
  ctx.app.post("/databases/:id/restart", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    await containerAction(ctx, db, "restart");
    return { ok: true };
  });

  ctx.app.delete("/databases/:id", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const { strandedServices } = await removeDatabase(ctx, db);
    return { ok: true, strandedServices };
  });

  ctx.app.get("/databases/:id/logs", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const tail = Number((req.query as { tail?: string }).tail ?? 500);
    return { logs: await getContainerLogs(ctx, db, Math.min(Math.max(tail, 50), 5000)) };
  });

  ctx.app.post("/databases/:id/backup", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    return createBackup(ctx, db);
  });

  ctx.app.get("/databases/:id/backups", async (req) => {
    return listBackups(ctx, (req.params as { id: string }).id);
  });

  ctx.app.post("/databases/:id/restore", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const p = restoreSchema.parse(req.body);
    await restoreBackup(ctx, db, p.backupId);
    return { ok: true };
  });

  ctx.app.post("/databases/:id/seed", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const p = seedSchema.parse(req.body);
    await runSeed(ctx, db, p.sql);
    return { ok: true };
  });

  // --- Embedded (in-container) databases -----------------------------------
  ctx.app.get("/databases/embedded", async () => {
    return listEmbeddedDatabases(ctx);
  });

  /** Services with neither a linked DB nor a DATABASE_URL — candidates for one-click provisioning. */
  ctx.app.get("/databases/orphan-services", async () => {
    return listOrphanServices(ctx);
  });

  /** List tables (with row + size estimates) in this database. Postgres + MySQL only. */
  ctx.app.get("/databases/:id/tables", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    return listTables(db);
  });

  /** Preview the first N rows of a table. Identifier-validated; admin auth assumed. */
  ctx.app.get("/databases/:id/tables/:schema/:table/preview", async (req) => {
    const { id, schema, table } = req.params as { id: string; schema: string; table: string };
    const db = getDatabase(ctx, id);
    if (!db) throw new Error("Database not found");
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return previewTable(db, schema, table, Number.isFinite(limit) ? limit : 100);
  });

  /** Stream a previously-created backup file as a downloadable attachment. */
  ctx.app.get("/databases/:id/backups/:backupId/download", async (req, reply) => {
    const { id, backupId } = req.params as { id: string; backupId: string };
    const db = getDatabase(ctx, id);
    if (!db) throw new Error("Database not found");
    const resolved = resolveBackupPath(ctx, id, backupId);
    if (!resolved) throw new Error("Backup file missing");
    reply
      .header("Content-Disposition", `attachment; filename="${resolved.filename}"`)
      .header("Content-Type", "application/octet-stream");
    return reply.send(fs.createReadStream(resolved.absolutePath));
  });

  /** Pre-flight reachability check against a destination DATABASE_URL. */
  ctx.app.post("/databases/:id/transfer/test", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const p = transferSchema.parse(req.body);
    return pingExternalDatabase(p.externalUrl, db.engine);
  });

  /**
   * Pipe the local DB into a hosted DATABASE_URL. Used to migrate the LocalSURV
   * database into Railway/Supabase/Neon/etc. without leaving the UI.
   */
  ctx.app.post("/databases/:id/transfer", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const p = transferSchema.parse(req.body);
    const result = await transferToExternal(ctx, db, p.externalUrl);
    return { ok: true, output: result.output.slice(-4000) };
  });

  /**
   * Streaming variant. Returns immediately with a transferId; chunks are
   * broadcast over WS as { type: "db_transfer", transferId, chunk } and a
   * final { type: "db_transfer", transferId, status: "ok"|"error" } event.
   */
  ctx.app.post("/databases/:id/transfer/stream", async (req) => {
    const db = getDatabase(ctx, (req.params as { id: string }).id);
    if (!db) throw new Error("Database not found");
    const p = transferSchema.parse(req.body);
    const transferId = nanoid(10);
    // Give the client a moment to send `attach_transfer` over the WS before we
    // start emitting chunks. 200ms is plenty for a same-origin WS round trip.
    setTimeout(() => {
      void transferToExternalStream(db, p.externalUrl, (chunk, stream) => {
        broadcastTransferEvent(ctx, transferId, { type: "db_transfer", transferId, chunk, stream });
      })
        .then(() => {
          broadcastTransferEvent(ctx, transferId, { type: "db_transfer", transferId, status: "ok" });
        })
        .catch((error) => {
          broadcastTransferEvent(ctx, transferId, {
            type: "db_transfer",
            transferId,
            status: "error",
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }, 200);
    return { transferId };
  });

  /**
   * Promote an embedded SQLite to either a managed Postgres or an existing
   * external DATABASE_URL. Either path ends with the service restarted so the
   * app picks up the new connection on next boot.
   */
  ctx.app.post("/databases/embedded/:serviceId/promote", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    const p = promoteSchema.parse(req.body);
    const service = ctx.db
      .prepare("SELECT id, name, project_id, linked_database_id FROM services WHERE id = ?")
      .get(serviceId) as
      | { id: string; name: string; project_id: string; linked_database_id?: string | null }
      | undefined;
    if (!service) throw new Error("Service not found");

    if (p.mode === "external") {
      if (!p.externalUrl) throw new Error("externalUrl is required for external mode");
      // Replace any existing DATABASE_URL row, then insert a fresh secret.
      ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ? AND key = 'DATABASE_URL'").run(serviceId);
      ctx.db
        .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
        .run(nanoid(), serviceId, "DATABASE_URL", encryptSecret(p.externalUrl, ctx.config.secretKey), 1);
      if (p.restart) {
        try {
          await restartService(ctx, serviceId);
        } catch {
          /* surfaced via logs */
        }
      }
      return { ok: true, mode: "external" };
    }

    const wantsImport = p.importEmbeddedSqlite || p.autoImportEmbedded;
    const embeddedMatch = wantsImport
      ? (await listEmbeddedDatabases(ctx, { includeLinkedServices: true })).find(
          (e) => e.service_id === serviceId
        )
      : undefined;

    // mode === "managed": reuse an existing service DB if one was created by a
    // previous promote attempt; otherwise provision a fresh Postgres.
    let row =
      (service.linked_database_id ? getDatabase(ctx, service.linked_database_id) : undefined) ??
      (ctx.db
        .prepare(
          "SELECT * FROM databases WHERE project_id = ? AND engine = 'postgres' AND name = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(service.project_id, `${service.name}-db`) as DatabaseRow | undefined);
    let containerName = row?.container_id || (row ? containerNameForDatabase(row) : "");
    if (!row) {
      // Skip ports already reserved by any service/database row so a freed-but-
      // remembered port isn't re-handed to this managed Postgres.
      const port = await findFreePort(54320, 54420, dbReservedPorts(ctx));
      const databaseName = (p.databaseName ?? service.name).replace(/[^a-zA-Z0-9_]/g, "_") || "appdb";
      try {
        // Compatibility wrapper: the actual container + row creation lives in
        // the shared primitive used by POST /databases and the postgres profile.
        row = await createManagedDatabase(ctx, {
          projectId: service.project_id,
          name: `${service.name}-db`,
          engine: "postgres",
          port,
          username: "postgres",
          password: nanoid(16),
          databaseName
        });
      } catch (error) {
        throw new Error(
          `Failed to provision managed Postgres: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      containerName = row.container_id || containerNameForDatabase(row);
    }

    // Postgres needs a moment after first start before it accepts connections.
    let importLog = "";
    let importError: string | null = null;
    try {
      await waitForPostgresReady(containerName);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }

    if (!importError && wantsImport) {
      try {
        if (!embeddedMatch) {
          // Strict mode surfaces the error; auto mode quietly skips.
          if (p.importEmbeddedSqlite) {
            importError = "No embedded SQLite file detected on the source service.";
          }
        } else {
          const result = await importSqliteIntoPostgres(
            embeddedMatch.container_name,
            embeddedMatch.file_path,
            row
          );
          importLog = result.output;
        }
      } catch (error) {
        importError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!importError && p.importSql && p.importSql.trim().length > 0) {
      try {
        await runSeed(ctx, row, p.importSql);
      } catch (error) {
        importError = error instanceof Error ? error.message : String(error);
      }
    }

    ctx.db
      .prepare("UPDATE services SET linked_database_id = ?, updated_at = ? WHERE id = ?")
      .run(row.id, nowIso(), serviceId);

    if (p.restart) {
      try {
        await restartService(ctx, serviceId);
      } catch {
        /* surfaced via logs */
      }
    }
    return {
      ok: true,
      mode: "managed",
      database: row,
      importLog: importLog ? importLog.slice(-4000) : undefined,
      importError
    };
  });

  // --- Service linking ------------------------------------------------------
  ctx.app.post("/databases/link", async (req) => {
    const p = linkSchema.parse(req.body);
    if (p.databaseId) {
      const db = getDatabase(ctx, p.databaseId);
      if (!db) throw new Error("Database not found");
    }
    ctx.db
      .prepare("UPDATE services SET linked_database_id = ?, updated_at = ? WHERE id = ?")
      .run(p.databaseId, nowIso(), p.serviceId);
    return { ok: true };
  });
}
