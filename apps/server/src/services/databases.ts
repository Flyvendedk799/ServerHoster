import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso, serializeError } from "../lib/core.js";

const exec = promisify(execFile);

/**
 * Run a command with a string as stdin. Resolves on exit 0, rejects on any
 * non-zero exit with the collected stderr.
 */
function runWithStdin(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
    child.on("error", reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

export type DatabaseRow = {
  id: string;
  project_id: string;
  name: string;
  engine: "postgres" | "mysql" | "redis" | "mongo";
  port: number;
  container_id: string;
  connection_string: string;
  username: string | null;
  password: string | null;
  database_name: string | null;
  created_at: string;
};

export function getDatabase(ctx: AppContext, id: string): DatabaseRow | null {
  return (ctx.db.prepare("SELECT * FROM databases WHERE id = ?").get(id) as DatabaseRow | undefined) ?? null;
}

export function containerNameForDatabase(db: DatabaseRow): string {
  return `survhub-db-${db.id.slice(0, 8)}`;
}

/**
 * Build a language-agnostic connection URL for a database row. Redis, Mongo,
 * MySQL, Postgres all use scheme://user:pass@host:port/db.
 */
export function buildConnectionString(db: DatabaseRow, host = "localhost"): string {
  const user = db.username ?? defaultUser(db.engine);
  const pass = db.password ?? "survhub";
  const dbName = db.database_name ?? defaultDb(db.engine);
  switch (db.engine) {
    case "postgres":
      return `postgresql://${user}:${pass}@${host}:${db.port}/${dbName}`;
    case "mysql":
      return `mysql://${user}:${pass}@${host}:${db.port}/${dbName}`;
    case "mongo":
      return `mongodb://${user}:${pass}@${host}:${db.port}/${dbName}?authSource=admin`;
    case "redis":
      return `redis://${host}:${db.port}`;
  }
}

function defaultUser(engine: DatabaseRow["engine"]): string {
  if (engine === "postgres") return "postgres";
  if (engine === "mysql") return "root";
  if (engine === "mongo") return "admin";
  return "";
}

function defaultDb(engine: DatabaseRow["engine"]): string {
  if (engine === "postgres") return "postgres";
  if (engine === "mysql") return "mysql";
  if (engine === "mongo") return "admin";
  return "";
}

export async function getContainerStatus(ctx: AppContext, db: DatabaseRow): Promise<{
  state: string;
  startedAt: string | null;
  health: string | null;
}> {
  try {
    const container = ctx.docker.getContainer(db.container_id || containerNameForDatabase(db));
    const info = await container.inspect();
    return {
      state: info.State?.Status ?? "unknown",
      startedAt: info.State?.StartedAt ?? null,
      health: info.State?.Health?.Status ?? null
    };
  } catch {
    return { state: "not-found", startedAt: null, health: null };
  }
}

export async function containerAction(
  ctx: AppContext,
  db: DatabaseRow,
  action: "start" | "stop" | "restart"
): Promise<void> {
  const container = ctx.docker.getContainer(db.container_id || containerNameForDatabase(db));
  if (action === "start") await container.start();
  else if (action === "stop") await container.stop({ t: 10 });
  else if (action === "restart") await container.restart({ t: 10 });
}

export async function removeDatabase(ctx: AppContext, db: DatabaseRow): Promise<void> {
  try {
    const container = ctx.docker.getContainer(db.container_id || containerNameForDatabase(db));
    await container.remove({ force: true, v: true });
  } catch {
    /* ignore */
  }
  ctx.db.prepare("DELETE FROM database_backups WHERE database_id = ?").run(db.id);
  ctx.db.prepare("UPDATE services SET linked_database_id = NULL WHERE linked_database_id = ?").run(db.id);
  ctx.db.prepare("DELETE FROM databases WHERE id = ?").run(db.id);
}

export async function getContainerLogs(ctx: AppContext, db: DatabaseRow, tail = 500): Promise<string> {
  try {
    const container = ctx.docker.getContainer(db.container_id || containerNameForDatabase(db));
    const stream = (await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
      follow: false
    })) as unknown as Buffer;
    return stream.toString("utf8");
  } catch (error) {
    return `Failed to read logs: ${serializeError(error)}`;
  }
}

// ---- Backups ---------------------------------------------------------------

function backupsDir(ctx: AppContext): string {
  const dir = path.join(ctx.config.dataRoot ?? ".", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createBackup(ctx: AppContext, db: DatabaseRow): Promise<{ id: string; path: string; size: number }> {
  const dir = backupsDir(ctx);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${db.engine}-${db.name}-${ts}.${db.engine === "mongo" ? "archive" : "sql"}`;
  const filePath = path.join(dir, filename);
  const container = db.container_id || containerNameForDatabase(db);

  if (db.engine === "postgres") {
    const user = db.username ?? "postgres";
    const database = db.database_name ?? "postgres";
    const { stdout } = await exec("docker", [
      "exec", container, "pg_dump", "-U", user, database
    ], { maxBuffer: 1024 * 1024 * 200 });
    fs.writeFileSync(filePath, stdout);
  } else if (db.engine === "mysql") {
    const user = db.username ?? "root";
    const pass = db.password ?? "survhub";
    const { stdout } = await exec("docker", [
      "exec", container, "sh", "-c", `mysqldump -u${user} -p${pass} --all-databases`
    ], { maxBuffer: 1024 * 1024 * 200 });
    fs.writeFileSync(filePath, stdout);
  } else if (db.engine === "mongo") {
    const user = db.username ?? "admin";
    const pass = db.password ?? "survhub";
    await exec("docker", [
      "exec", container, "sh", "-c",
      `mongodump --archive -u ${user} -p ${pass} --authenticationDatabase admin > /tmp/survhub-backup.archive && cat /tmp/survhub-backup.archive`
    ], { maxBuffer: 1024 * 1024 * 500 }).then(({ stdout }) => fs.writeFileSync(filePath, stdout));
  } else {
    throw new Error(`Backups not supported for ${db.engine}`);
  }

  const stat = fs.statSync(filePath);
  const id = nanoid();
  ctx.db
    .prepare("INSERT INTO database_backups (id, database_id, filename, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, db.id, filename, stat.size, nowIso());
  return { id, path: filePath, size: stat.size };
}

export function listBackups(ctx: AppContext, databaseId: string): Array<{ id: string; filename: string; size_bytes: number; created_at: string }> {
  return ctx.db
    .prepare("SELECT id, filename, size_bytes, created_at FROM database_backups WHERE database_id = ? ORDER BY created_at DESC")
    .all(databaseId) as Array<{ id: string; filename: string; size_bytes: number; created_at: string }>;
}

export async function restoreBackup(ctx: AppContext, db: DatabaseRow, backupId: string): Promise<void> {
  const row = ctx.db
    .prepare("SELECT filename FROM database_backups WHERE id = ? AND database_id = ?")
    .get(backupId, db.id) as { filename?: string } | undefined;
  if (!row?.filename) throw new Error("Backup not found");
  const filePath = path.join(backupsDir(ctx), row.filename);
  if (!fs.existsSync(filePath)) throw new Error(`Backup file missing on disk: ${filePath}`);
  const container = db.container_id || containerNameForDatabase(db);

  if (db.engine === "postgres") {
    const user = db.username ?? "postgres";
    const database = db.database_name ?? "postgres";
    const sql = fs.readFileSync(filePath, "utf8");
    await runWithStdin("docker", ["exec", "-i", container, "psql", "-U", user, "-d", database], sql);
  } else if (db.engine === "mysql") {
    const user = db.username ?? "root";
    const pass = db.password ?? "survhub";
    const sql = fs.readFileSync(filePath, "utf8");
    await runWithStdin("docker", ["exec", "-i", container, "sh", "-c", `mysql -u${user} -p${pass}`], sql);
  } else {
    throw new Error(`Restore not supported for ${db.engine}`);
  }
}

// ---- Seed data -------------------------------------------------------------

export async function runSeed(ctx: AppContext, db: DatabaseRow, sql: string): Promise<void> {
  const container = db.container_id || containerNameForDatabase(db);
  if (db.engine === "postgres") {
    const user = db.username ?? "postgres";
    const database = db.database_name ?? "postgres";
    await runWithStdin("docker", ["exec", "-i", container, "psql", "-U", user, "-d", database], sql);
  } else if (db.engine === "mysql") {
    const user = db.username ?? "root";
    const pass = db.password ?? "survhub";
    await runWithStdin("docker", ["exec", "-i", container, "sh", "-c", `mysql -u${user} -p${pass}`], sql);
  } else {
    throw new Error(`Seed not supported for ${db.engine}`);
  }
  void ctx;
}
