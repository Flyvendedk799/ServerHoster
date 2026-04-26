import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import {
  buildConnectionString,
  containerAction,
  createBackup,
  getContainerLogs,
  getContainerStatus,
  getDatabase,
  listBackups,
  removeDatabase,
  restoreBackup,
  runSeed,
  type DatabaseRow
} from "../services/databases.js";

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

async function pullImage(ctx: AppContext, image: string): Promise<void> {
  const stream = await ctx.docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    ctx.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
}

export function registerDatabaseRoutes(ctx: AppContext): void {
  ctx.app.get("/databases", async () => {
    const rows = ctx.db.prepare("SELECT * FROM databases ORDER BY created_at DESC").all() as DatabaseRow[];
    // Enrich with live container state so the admin panel can show running/stopped.
    return Promise.all(
      rows.map(async (row) => {
        const status = await getContainerStatus(ctx, row);
        return { ...row, container_status: status };
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
    const id = nanoid();
    const imageMap: Record<string, string> = { postgres: "postgres:16", mysql: "mysql:8", redis: "redis:7", mongo: "mongo:8" };

    const username =
      p.username ??
      (p.engine === "postgres" ? "postgres" :
        p.engine === "mysql" ? "root" :
        p.engine === "mongo" ? "admin" : "");
    const password = p.password ?? "survhub";
    const databaseName =
      p.databaseName ??
      (p.engine === "postgres" ? "postgres" :
        p.engine === "mysql" ? p.name.replace(/-/g, "_") :
        p.engine === "mongo" ? "admin" : "");

    const envMap: Record<string, string[]> = {
      postgres: [
        `POSTGRES_PASSWORD=${password}`,
        `POSTGRES_USER=${username}`,
        `POSTGRES_DB=${databaseName}`
      ],
      mysql: [
        `MYSQL_ROOT_PASSWORD=${password}`,
        `MYSQL_DATABASE=${databaseName}`
      ],
      redis: [],
      mongo: [
        `MONGO_INITDB_ROOT_USERNAME=${username}`,
        `MONGO_INITDB_ROOT_PASSWORD=${password}`
      ]
    };

    const containerName = `survhub-db-${id.slice(0, 8)}`;
    let containerId = "";
    try {
      await pullImage(ctx, imageMap[p.engine]);
      const container = await ctx.docker.createContainer({
        Image: imageMap[p.engine],
        name: containerName,
        Env: envMap[p.engine],
        ExposedPorts: { [`${p.port}/tcp`]: {} },
        HostConfig: {
          PortBindings: { [`${p.port}/tcp`]: [{ HostPort: String(p.port) }] },
          RestartPolicy: { Name: "unless-stopped" },
          Binds: [`survhub_${p.engine}_${p.name}:/var/lib/${p.engine}`]
        }
      });
      await container.start();
      containerId = container.id;
    } catch (error) {
      throw new Error(`Database container create/start failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const row: DatabaseRow = {
      id,
      project_id: p.projectId,
      name: p.name,
      engine: p.engine,
      port: p.port,
      container_id: containerId,
      connection_string: "",
      username,
      password,
      database_name: databaseName,
      created_at: nowIso()
    };
    row.connection_string = buildConnectionString(row);

    ctx.db
      .prepare(
        "INSERT INTO databases (id, project_id, name, engine, port, container_id, connection_string, username, password, database_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        row.id,
        row.project_id,
        row.name,
        row.engine,
        row.port,
        row.container_id,
        row.connection_string,
        row.username,
        row.password,
        row.database_name,
        row.created_at
      );
    return row;
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
    await removeDatabase(ctx, db);
    return { ok: true };
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
