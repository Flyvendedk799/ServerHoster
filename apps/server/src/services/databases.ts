import fs from "node:fs";
import os from "node:os";
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
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
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

export async function getContainerStatus(
  ctx: AppContext,
  db: DatabaseRow
): Promise<{
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

export async function createBackup(
  ctx: AppContext,
  db: DatabaseRow
): Promise<{ id: string; path: string; size: number }> {
  const dir = backupsDir(ctx);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${db.engine}-${db.name}-${ts}.${db.engine === "mongo" ? "archive" : "sql"}`;
  const filePath = path.join(dir, filename);
  const container = db.container_id || containerNameForDatabase(db);

  if (db.engine === "postgres") {
    const user = db.username ?? "postgres";
    const database = db.database_name ?? "postgres";
    const { stdout } = await exec("docker", ["exec", container, "pg_dump", "-U", user, database], {
      maxBuffer: 1024 * 1024 * 200
    });
    fs.writeFileSync(filePath, stdout);
  } else if (db.engine === "mysql") {
    const user = db.username ?? "root";
    const pass = db.password ?? "survhub";
    const { stdout } = await exec(
      "docker",
      ["exec", container, "sh", "-c", `mysqldump -u${user} -p${pass} --all-databases`],
      { maxBuffer: 1024 * 1024 * 200 }
    );
    fs.writeFileSync(filePath, stdout);
  } else if (db.engine === "mongo") {
    const user = db.username ?? "admin";
    const pass = db.password ?? "survhub";
    await exec(
      "docker",
      [
        "exec",
        container,
        "sh",
        "-c",
        `mongodump --archive -u ${user} -p ${pass} --authenticationDatabase admin > /tmp/survhub-backup.archive && cat /tmp/survhub-backup.archive`
      ],
      { maxBuffer: 1024 * 1024 * 500 }
    ).then(({ stdout }) => fs.writeFileSync(filePath, stdout));
  } else {
    throw new Error(`Backups not supported for ${db.engine}`);
  }

  const stat = fs.statSync(filePath);
  const id = nanoid();
  ctx.db
    .prepare(
      "INSERT INTO database_backups (id, database_id, filename, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, db.id, filename, stat.size, nowIso());
  return { id, path: filePath, size: stat.size };
}

export function listBackups(
  ctx: AppContext,
  databaseId: string
): Array<{ id: string; filename: string; size_bytes: number; created_at: string }> {
  return ctx.db
    .prepare(
      "SELECT id, filename, size_bytes, created_at FROM database_backups WHERE database_id = ? ORDER BY created_at DESC"
    )
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

/**
 * Parse a mysql:// URL into individual fields so we can hand them to mysql/
 * mysqldump as separate, env-var-quoted arguments — never as a single bash
 * string.
 */
function parseMysqlUrl(url: string): {
  host: string;
  port: string;
  user: string;
  pass: string;
  database: string;
} {
  const u = new URL(url);
  if (!u.protocol.startsWith("mysql")) throw new Error("Not a mysql URL");
  return {
    host: u.hostname,
    port: u.port || "3306",
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "")
  };
}

/**
 * Validate that a string is a parseable URL with one of the expected schemes.
 * Throws with a friendly error so callers can return it to the user.
 */
function assertExternalUrl(url: string, engine: DatabaseRow["engine"]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  const expected =
    engine === "postgres" ? ["postgres:", "postgresql:"] : engine === "mysql" ? ["mysql:", "mysql2:"] : [];
  if (expected.length && !expected.includes(parsed.protocol)) {
    throw new Error(`Expected ${expected.join(" or ")} URL`);
  }
}

/**
 * Quick reachability + auth check against a destination DATABASE_URL using
 * an ephemeral postgres/mysql client container. Surfaces errors before the
 * user commits to a (possibly multi-minute) full transfer.
 *
 * URLs are passed via `docker -e VAR=...` so they never reach a shell parser
 * — even pasted URLs containing $(), backticks, or quotes are inert.
 */
export async function pingExternalDatabase(
  externalUrl: string,
  engine: DatabaseRow["engine"]
): Promise<{ ok: true; serverVersion: string } | { ok: false; error: string }> {
  try {
    assertExternalUrl(externalUrl, engine);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let image: string;
  let envArgs: string[];
  let cmd: string;
  if (engine === "postgres") {
    image = "postgres:16";
    envArgs = ["-e", `EXT_URL=${externalUrl}`];
    cmd = `psql "$EXT_URL" -At -c "SELECT version();"`;
  } else if (engine === "mysql") {
    let ext: ReturnType<typeof parseMysqlUrl>;
    try {
      ext = parseMysqlUrl(externalUrl);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    image = "mysql:8";
    envArgs = [
      "-e",
      `EH=${ext.host}`,
      "-e",
      `EP=${ext.port}`,
      "-e",
      `EU=${ext.user}`,
      "-e",
      `MYSQL_PWD=${ext.pass}`,
      "-e",
      `EDB=${ext.database}`
    ];
    cmd = `mysql -h "$EH" -P "$EP" -u "$EU" "$EDB" -BNs -e "SELECT VERSION();"`;
  } else {
    return { ok: false, error: `Connection test not supported for ${engine}` };
  }
  try {
    const { stdout } = await exec(
      "docker",
      ["run", "--rm", "--add-host=host.docker.internal:host-gateway", ...envArgs, image, "bash", "-lc", cmd],
      { maxBuffer: 1024 * 64, timeout: 20 * 1000 }
    );
    const version = stdout.trim().split("\n")[0] ?? "unknown";
    return { ok: true, serverVersion: version };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, error: raw.slice(-400) };
  }
}

/**
 * Build the docker-run argv that performs the actual dump|load pipe. URLs
 * are passed as docker -e env vars and quoted in the bash command so user
 * input cannot escape into the host shell.
 */
function buildTransferDockerArgs(db: DatabaseRow, externalUrl: string): { image: string; args: string[] } {
  assertExternalUrl(externalUrl, db.engine);
  const localUrl = buildConnectionString(db, "host.docker.internal");
  let image: string;
  let envArgs: string[];
  let cmd: string;
  if (db.engine === "postgres") {
    image = "postgres:16";
    envArgs = ["-e", `LOCAL_URL=${localUrl}`, "-e", `EXT_URL=${externalUrl}`];
    cmd = `pg_dump --no-owner --no-acl "$LOCAL_URL" | psql "$EXT_URL"`;
  } else if (db.engine === "mysql") {
    const local = parseMysqlUrl(localUrl);
    const ext = parseMysqlUrl(externalUrl);
    image = "mysql:8";
    envArgs = [
      "-e",
      `LH=${local.host}`,
      "-e",
      `LP=${local.port}`,
      "-e",
      `LU=${local.user}`,
      "-e",
      `LPW=${local.pass}`,
      "-e",
      `LDB=${local.database}`,
      "-e",
      `EH=${ext.host}`,
      "-e",
      `EP=${ext.port}`,
      "-e",
      `EU=${ext.user}`,
      "-e",
      `EPW=${ext.pass}`,
      "-e",
      `EDB=${ext.database}`
    ];
    // MYSQL_PWD env handles the password without leaking it into argv or shell.
    cmd = [
      `MYSQL_PWD="$LPW" mysqldump --column-statistics=0 --single-transaction --quick`,
      `  -h "$LH" -P "$LP" -u "$LU" "$LDB"`,
      `  | MYSQL_PWD="$EPW" mysql -h "$EH" -P "$EP" -u "$EU" "$EDB"`
    ].join(" ");
  } else {
    throw new Error(`Transfer not supported for ${db.engine}`);
  }
  return {
    image,
    args: [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      ...envArgs,
      image,
      "bash",
      "-lc",
      cmd
    ]
  };
}

/**
 * Streaming variant: spawns the docker pipe and emits stdout/stderr chunks
 * via the supplied callback. Resolves on clean exit, rejects on non-zero.
 */
export function transferToExternalStream(
  db: DatabaseRow,
  externalUrl: string,
  onChunk: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<{ output: string }> {
  const { args } = buildTransferDockerArgs(db, externalUrl);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args);
    let combined = "";
    const cap = 1024 * 1024; // keep last 1MB at most in memory
    child.stdout.on("data", (d) => {
      const s = d.toString();
      combined = (combined + s).slice(-cap);
      onChunk(s, "stdout");
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      combined = (combined + s).slice(-cap);
      onChunk(s, "stderr");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ output: combined });
      else reject(new Error(`docker exited ${code}\n${combined.slice(-2000)}`));
    });
  });
}

/**
 * Pipe the local DB into an external DATABASE_URL using an ephemeral
 * postgres/mysql client container. Lets users transfer an embedded or managed
 * LocalSURV database to a hosted provider (Railway, Supabase, Neon, …) without
 * the host needing pg_dump/psql installed.
 */
export async function transferToExternal(
  ctx: AppContext,
  db: DatabaseRow,
  externalUrl: string
): Promise<{ output: string }> {
  const { args } = buildTransferDockerArgs(db, externalUrl);
  const { stdout, stderr } = await exec("docker", args, {
    maxBuffer: 1024 * 1024 * 500,
    timeout: 10 * 60 * 1000
  });
  void ctx;
  return { output: stdout + (stderr ? `\n[stderr]\n${stderr}` : "") };
}

/**
 * Poll a freshly-started Postgres container until it accepts connections.
 * Postgres typically takes 5–10s on first boot; pgloader will hard-fail
 * without this wait.
 */
export async function waitForPostgresReady(containerName: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await exec("docker", ["exec", containerName, "pg_isready", "-U", "postgres"], { timeout: 4000 });
      return;
    } catch {
      /* not ready yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Postgres container ${containerName} did not become ready within ${timeoutMs}ms`);
}

/**
 * Copy a SQLite file out of a service container and import it into a freshly-
 * provisioned Postgres using pgloader (handles dialect + type translation).
 * Returns pgloader's combined output for the UI.
 */
export async function importSqliteIntoPostgres(
  serviceContainerName: string,
  sqliteFilePath: string,
  targetPostgres: DatabaseRow
): Promise<{ output: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-sqlite-import-"));
  const localFile = path.join(tmpDir, "source.db");
  try {
    await exec("docker", ["cp", `${serviceContainerName}:${sqliteFilePath}`, localFile], {
      timeout: 30000
    });
    if (!fs.existsSync(localFile) || fs.statSync(localFile).size === 0) {
      throw new Error(`Copied SQLite file is empty: ${sqliteFilePath}`);
    }
    const externalUrl = buildConnectionString(targetPostgres, "host.docker.internal");
    const { stdout, stderr } = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v",
        `${tmpDir}:/data:ro`,
        "dimitri/pgloader",
        "pgloader",
        "/data/source.db",
        externalUrl
      ],
      { maxBuffer: 1024 * 1024 * 200, timeout: 10 * 60 * 1000 }
    );
    return { output: stdout + (stderr ? `\n[stderr]\n${stderr}` : "") };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Cheap, engine-native size query. Runs inside the DB container so we don't
 * need any host-side tooling. Returns null if the container isn't responsive
 * or the engine isn't supported.
 */
export async function getDatabaseSizeBytes(db: DatabaseRow): Promise<number | null> {
  const container = db.container_id || containerNameForDatabase(db);
  try {
    if (db.engine === "postgres") {
      const user = db.username ?? "postgres";
      const database = db.database_name ?? "postgres";
      const { stdout } = await exec(
        "docker",
        [
          "exec",
          container,
          "psql",
          "-U",
          user,
          "-d",
          database,
          "-AtX",
          "-c",
          "SELECT pg_database_size(current_database());"
        ],
        { timeout: 5000 }
      );
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    if (db.engine === "mysql") {
      const user = db.username ?? "root";
      const pass = db.password ?? "survhub";
      const database = db.database_name ?? "mysql";
      const { stdout } = await exec(
        "docker",
        [
          "exec",
          container,
          "sh",
          "-c",
          `mysql -u${user} -p${pass} -BNs -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = '${database.replace(/'/g, "''")}'"`
        ],
        { timeout: 5000 }
      );
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    if (db.engine === "redis") {
      const { stdout } = await exec("docker", ["exec", container, "redis-cli", "INFO", "memory"], {
        timeout: 5000
      });
      const match = /used_memory:(\d+)/.exec(stdout);
      return match ? Number(match[1]) : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Read-only data browser ------------------------------------------------

const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

export type TableSummary = {
  schema: string;
  name: string;
  row_estimate: number;
  size_bytes: number;
};

export type TablePreview = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncatedTo: number;
};

/**
 * Run a query inside the DB container and return the single-cell JSON output.
 * Postgres uses `psql -AtX` for raw output; mysql uses `mysql -BNs`.
 */
async function execJsonQuery(db: DatabaseRow, sql: string): Promise<string> {
  const container = db.container_id || containerNameForDatabase(db);
  if (db.engine === "postgres") {
    const user = db.username ?? "postgres";
    const database = db.database_name ?? "postgres";
    const { stdout } = await exec(
      "docker",
      ["exec", container, "psql", "-U", user, "-d", database, "-AtX", "-c", sql],
      { maxBuffer: 1024 * 1024 * 64, timeout: 15000 }
    );
    return stdout;
  }
  if (db.engine === "mysql") {
    const user = db.username ?? "root";
    const pass = db.password ?? "survhub";
    const { stdout } = await exec(
      "docker",
      ["exec", container, "sh", "-c", `mysql -u${user} -p${pass} -BNs -e "${sql.replace(/"/g, '\\"')}"`],
      { maxBuffer: 1024 * 1024 * 64, timeout: 15000 }
    );
    return stdout;
  }
  throw new Error(`Data browser not supported for ${db.engine}`);
}

export async function listTables(db: DatabaseRow): Promise<TableSummary[]> {
  if (db.engine === "postgres") {
    const sql = `
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
        SELECT n.nspname AS schema, c.relname AS name,
               c.reltuples::bigint AS row_estimate,
               pg_total_relation_size(c.oid)::bigint AS size_bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY n.nspname, c.relname
      ) t`.replace(/\s+/g, " ");
    const stdout = (await execJsonQuery(db, sql)).trim();
    return stdout ? (JSON.parse(stdout) as TableSummary[]) : [];
  }
  if (db.engine === "mysql") {
    const dbName = db.database_name ?? "mysql";
    const sql = `SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', table_schema, 'name', table_name, 'row_estimate', table_rows, 'size_bytes', data_length + index_length)) FROM information_schema.tables WHERE table_schema = '${dbName.replace(/'/g, "''")}'`;
    const stdout = (await execJsonQuery(db, sql)).trim();
    return stdout && stdout !== "NULL" ? (JSON.parse(stdout) as TableSummary[]) : [];
  }
  throw new Error(`Data browser not supported for ${db.engine}`);
}

export async function previewTable(
  db: DatabaseRow,
  schema: string,
  table: string,
  limit = 100
): Promise<TablePreview> {
  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(table)) {
    throw new Error("Invalid identifier");
  }
  const known = await listTables(db);
  if (!known.some((t) => t.schema === schema && t.name === table)) {
    throw new Error("Table not found");
  }
  const cap = Math.min(Math.max(limit, 1), 500);
  if (db.engine === "postgres") {
    const sql = `
      SELECT json_build_object(
        'columns', (
          SELECT COALESCE(json_agg(column_name ORDER BY ordinal_position), '[]'::json)
          FROM information_schema.columns
          WHERE table_schema = '${schema}' AND table_name = '${table}'
        ),
        'rows', (
          SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT * FROM "${schema}"."${table}" LIMIT ${cap}
          ) t
        )
      )`.replace(/\s+/g, " ");
    const stdout = (await execJsonQuery(db, sql)).trim();
    const parsed = stdout
      ? (JSON.parse(stdout) as { columns: string[]; rows: Array<Record<string, unknown>> })
      : { columns: [], rows: [] };
    return { ...parsed, truncatedTo: cap };
  }
  if (db.engine === "mysql") {
    const sql = `SELECT JSON_OBJECT('columns', (SELECT JSON_ARRAYAGG(column_name) FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='${table}' ORDER BY ordinal_position), 'rows', (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(*)), JSON_ARRAY()) FROM (SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${cap}) t))`;
    // MySQL doesn't support JSON_OBJECT(*); fall back to per-column approach
    const cols = (
      await execJsonQuery(
        db,
        `SELECT JSON_ARRAYAGG(column_name) FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='${table}' ORDER BY ordinal_position`
      )
    ).trim();
    const columns = cols ? (JSON.parse(cols) as string[]) : [];
    if (columns.length === 0) return { columns: [], rows: [], truncatedTo: cap };
    const objExpr = columns.map((c) => `'${c}', \`${c}\``).join(", ");
    const dataSql = `SELECT JSON_ARRAYAGG(JSON_OBJECT(${objExpr})) FROM (SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${cap}) t`;
    const dataOut = (await execJsonQuery(db, dataSql)).trim();
    const rows = dataOut && dataOut !== "NULL" ? (JSON.parse(dataOut) as Array<Record<string, unknown>>) : [];
    void sql;
    return { columns, rows, truncatedTo: cap };
  }
  throw new Error(`Data browser not supported for ${db.engine}`);
}

/**
 * Resolve a backup row to its absolute path on disk. Returns null if missing.
 */
export function resolveBackupPath(
  ctx: AppContext,
  databaseId: string,
  backupId: string
): { filename: string; absolutePath: string } | null {
  const row = ctx.db
    .prepare("SELECT filename FROM database_backups WHERE id = ? AND database_id = ?")
    .get(backupId, databaseId) as { filename?: string } | undefined;
  if (!row?.filename) return null;
  const absolutePath = path.join(backupsDir(ctx), row.filename);
  if (!fs.existsSync(absolutePath)) return null;
  return { filename: row.filename, absolutePath };
}

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
