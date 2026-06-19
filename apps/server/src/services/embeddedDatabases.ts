import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";
import type { AppContext } from "../types.js";
import { getServiceEnv } from "../lib/core.js";
import { scanForDatabaseDrivers, type DbCodeSignal } from "./codeScan.js";

const exec = promisify(execFile);

/**
 * Embedded databases are persistence the *service* spun up for itself —
 * usually a SQLite file living inside the container filesystem because no
 * DATABASE_URL was provided. They are invisible to the managed-DB lane and
 * vanish when the container is recreated, so LocalSURV must surface them.
 */

const EMBEDDED_DB_PROBE_PATHS = [
  "/app/app.db",
  "/app/db.sqlite3",
  "/app/db.sqlite",
  "/app/data/app.db",
  "/app/data/db.sqlite3",
  "/app/data.db",
  "/app/sqlite.db",
  "/data/app.db",
  "/data/db.sqlite3",
  "/var/lib/app/app.db"
];

const PERSISTENCE_ENV_HINTS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "MONGO_URL",
  "MONGODB_URI",
  "REDIS_URL"
];
const COMPOSE_FILENAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export type EmbeddedDatabase = {
  service_id: string;
  service_name: string;
  project_id: string | null;
  container_id: string;
  container_name: string;
  engine: "sqlite";
  file_path: string;
  size_bytes: number;
  /** True if the file lives on a Docker volume / bind mount and therefore survives recreation. */
  persistent: boolean;
  /** Env vars suggesting an external DB *should* be configured but isn't. */
  missing_env: string[];
};

type ServiceRow = {
  id: string;
  project_id: string | null;
  name: string;
  type: string;
  status: string;
  linked_database_id: string | null;
  working_dir?: string | null;
  compose_service_name?: string | null;
};

type DockerInspectMount = {
  Type?: string;
  Source?: string;
  Destination?: string;
  Name?: string;
};

type DockerInspect = {
  Id?: string;
  Name?: string;
  State?: { Running?: boolean; Status?: string };
  Mounts?: DockerInspectMount[];
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
};

type ComposeDefinition = {
  image?: unknown;
  container_name?: unknown;
  environment?: unknown;
  ports?: unknown;
};

type ComposeServiceInfo = {
  name: string;
  image: string;
  container_name: string | null;
  env: Record<string, string>;
  ports: unknown[];
};

type ComposeDbEngine = "postgres" | "mysql" | "redis" | "mongo";

type ComposeDbService = ComposeServiceInfo & {
  engine: ComposeDbEngine;
  internal_port: number;
};

type ComposePortResolver = (
  containerName: string,
  internalPort: number
) => Promise<{ running: boolean; hostPort: number | null } | null>;

export type ComposeDatabaseCandidate = {
  engine: ComposeDbEngine;
  env_key: string;
  compose_file: string;
  app_service_name: string | null;
  database_service_name: string;
  container_name: string | null;
  internal_port: number;
  host: "localhost";
  port: number | null;
  running: boolean;
  available: boolean;
  connection_preview: string | null;
  note: string;
};

type ComposeDatabaseCandidateInternal = ComposeDatabaseCandidate & {
  connection_url: string | null;
};

function containerNameForService(serviceId: string): string {
  return `survhub-${serviceId}`;
}

/**
 * Probe a small set of conventional SQLite paths inside the container.
 * Listing the entire filesystem is too expensive to run on every page load,
 * so we accept that exotic layouts may go undetected — promotion is still
 * available manually.
 */
async function probeContainer(containerName: string): Promise<{ path: string; size: number } | null> {
  const paths = EMBEDDED_DB_PROBE_PATHS.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
  const script = `for p in ${paths}; do if [ -f "$p" ]; then wc -c < "$p" | tr -d ' \\n'; echo " $p"; exit 0; fi; done; exit 0`;
  try {
    const { stdout } = await exec("docker", ["exec", containerName, "sh", "-c", script], {
      timeout: 4000,
      maxBuffer: 1024 * 64
    });
    const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!line) return null;
    const match = /^(\d+)\s+(\/\S+)$/.exec(line.trim());
    if (!match) return null;
    return { size: Number(match[1]), path: match[2] };
  } catch {
    return null;
  }
}

function mountCoversPath(mounts: DockerInspectMount[] | undefined, filePath: string): boolean {
  if (!mounts || mounts.length === 0) return false;
  return mounts.some((m) => {
    const dest = m.Destination ?? "";
    if (!dest) return false;
    return filePath === dest || filePath.startsWith(dest.endsWith("/") ? dest : `${dest}/`);
  });
}

export type OrphanService = {
  service_id: string;
  service_name: string;
  project_id: string | null;
  status: string;
  /** True if the service appears to want a DB (has app-typical env or runs as docker). */
  reason: "no-database-url";
  /** Static-scan signals: drivers/ORMs detected in the source manifests. Empty
   *  for services whose code doesn't reference any database. */
  code_signals: DbCodeSignal[];
  /** Existing Docker Compose database ServerHoster can connect instead of
   *  provisioning a fresh managed DB. The raw URL is never exposed here. */
  compose_database?: ComposeDatabaseCandidate;
};

/**
 * Services that have no managed DB linked AND no DATABASE_URL env. These are
 * candidates for a fresh "Provision & link" rather than promotion of an
 * existing embedded SQLite — but the same managed-Postgres provisioning path
 * works for both, so the UI lets the user trigger it directly.
 *
 * Each result also carries a `code_signals` array from a static scan of the
 * service's working_dir. The frontend uses this to suppress the "Add database"
 * banner on services whose source clearly doesn't need one (e.g. a static
 * frontend whose package.json contains no DB driver).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function composeEnvMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const raw = String(item);
      const sep = raw.indexOf("=");
      if (sep > 0) out[raw.slice(0, sep)] = raw.slice(sep + 1);
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      if (raw === null || raw === undefined) continue;
      out[key] = String(raw);
    }
  }
  return out;
}

function composeFilesForWorkdir(workingDir: string): string[] {
  const start = fs.existsSync(workingDir) && fs.statSync(workingDir).isFile() ? path.dirname(workingDir) : workingDir;
  const out: string[] = [];
  let current = path.resolve(start);
  for (let depth = 0; depth < 5; depth += 1) {
    for (const filename of COMPOSE_FILENAMES) {
      const candidate = path.join(current, filename);
      if (fs.existsSync(candidate)) out.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function parseComposeServices(composeFile: string): ComposeServiceInfo[] {
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(composeFile, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.services)) return [];
  const out: ComposeServiceInfo[] = [];
  for (const [name, rawDefinition] of Object.entries(parsed.services)) {
    if (!isRecord(rawDefinition)) continue;
    const definition = rawDefinition as ComposeDefinition;
    out.push({
      name,
      image: asString(definition.image) ?? "",
      container_name: asString(definition.container_name),
      env: composeEnvMap(definition.environment),
      ports: Array.isArray(definition.ports) ? definition.ports : []
    });
  }
  return out;
}

function classifyComposeDbService(service: ComposeServiceInfo): ComposeDbService | null {
  const image = service.image.toLowerCase();
  const envKeys = Object.keys(service.env);
  const hasEnv = (prefix: string) => envKeys.some((key) => key.startsWith(prefix));
  if (image.includes("postgres") || image.includes("postgis") || hasEnv("POSTGRES_")) {
    return { ...service, engine: "postgres", internal_port: 5432 };
  }
  if (image.includes("mysql") || image.includes("mariadb") || hasEnv("MYSQL_")) {
    return { ...service, engine: "mysql", internal_port: 3306 };
  }
  if (image.includes("redis")) {
    return { ...service, engine: "redis", internal_port: 6379 };
  }
  if (image.includes("mongo") || hasEnv("MONGO_INITDB_")) {
    return { ...service, engine: "mongo", internal_port: 27017 };
  }
  return null;
}

function envKeyForEngine(engine: ComposeDbEngine): string {
  return engine === "redis" ? "REDIS_URL" : "DATABASE_URL";
}

function engineForUrl(key: string, value: string): ComposeDbEngine | null {
  if (key === "REDIS_URL") return "redis";
  if (key === "MYSQL_URL") return "mysql";
  if (key === "MONGO_URL" || key === "MONGODB_URI") return "mongo";
  try {
    const protocol = new URL(value).protocol.replace(/:$/, "");
    if (protocol === "postgres" || protocol === "postgresql") return "postgres";
    if (protocol === "mysql" || protocol === "mysql2") return "mysql";
    if (protocol === "mongodb" || protocol === "mongodb+srv") return "mongo";
    if (protocol === "redis" || protocol === "rediss") return "redis";
  } catch {
    return null;
  }
  return key === "POSTGRES_URL" || key === "POSTGRESQL_URL" || key === "DATABASE_URL" ? "postgres" : null;
}

function hostMatchesDb(urlHost: string, db: ComposeDbService): boolean {
  return urlHost === db.name || (db.container_name ? urlHost === db.container_name : false);
}

function hostPortFromComposePort(value: unknown, internalPort: number): number | null {
  if (typeof value === "number") return value === internalPort ? value : null;
  if (typeof value !== "string") return null;
  const withoutProto = value.trim().replace(/\/(tcp|udp)$/i, "");
  if (!withoutProto) return null;
  const parts = withoutProto.split(":");
  const containerPort = Number(parts[parts.length - 1]);
  if (containerPort !== internalPort) return null;
  if (parts.length === 1) return internalPort;
  const hostPort = Number(parts[parts.length - 2]);
  return Number.isFinite(hostPort) ? hostPort : null;
}

function composeFallbackPort(db: ComposeDbService): number | null {
  for (const port of db.ports) {
    const hostPort = hostPortFromComposePort(port, db.internal_port);
    if (hostPort) return hostPort;
  }
  return null;
}

function inspectPublishedPort(inspect: DockerInspect, internalPort: number): number | null {
  const bindings = inspect.NetworkSettings?.Ports?.[`${internalPort}/tcp`];
  const hostPort = bindings?.find((binding) => binding.HostPort)?.HostPort;
  const parsed = hostPort ? Number(hostPort) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function dockerPortResolver(ctx: AppContext): Promise<ComposePortResolver> {
  return async (containerName, internalPort) => {
    try {
      const inspect = (await ctx.docker.getContainer(containerName).inspect()) as DockerInspect;
      return {
        running: Boolean(inspect.State?.Running) || inspect.State?.Status === "running",
        hostPort: inspectPublishedPort(inspect, internalPort)
      };
    } catch {
      return null;
    }
  };
}

function previewConnectionUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:****@");
  }
}

function rewriteComposeUrl(rawUrl: string, db: ComposeDbService, hostPort: number): string | null {
  try {
    const url = new URL(rawUrl);
    if (!hostMatchesDb(url.hostname, db)) return null;
    url.hostname = "localhost";
    url.port = String(hostPort);
    return url.toString();
  } catch {
    return null;
  }
}

function buildUrlFromDbEnv(db: ComposeDbService, hostPort: number): string {
  switch (db.engine) {
    case "postgres": {
      const user = db.env.POSTGRES_USER || "postgres";
      const password = db.env.POSTGRES_PASSWORD || "postgres";
      const database = db.env.POSTGRES_DB || user || "postgres";
      return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${hostPort}/${encodeURIComponent(database)}`;
    }
    case "mysql": {
      const user = db.env.MYSQL_USER || "root";
      const password = db.env.MYSQL_PASSWORD || db.env.MYSQL_ROOT_PASSWORD || "mysql";
      const database = db.env.MYSQL_DATABASE || "mysql";
      return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${hostPort}/${encodeURIComponent(database)}`;
    }
    case "mongo": {
      const user = db.env.MONGO_INITDB_ROOT_USERNAME || "admin";
      const password = db.env.MONGO_INITDB_ROOT_PASSWORD || "mongo";
      return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${hostPort}/admin?authSource=admin`;
    }
    case "redis": {
      const password = db.env.REDIS_PASSWORD;
      return password
        ? `redis://:${encodeURIComponent(password)}@localhost:${hostPort}`
        : `redis://localhost:${hostPort}`;
    }
  }
}

async function enrichComposeCandidate(
  composeFile: string,
  app: ComposeServiceInfo | null,
  db: ComposeDbService,
  rawUrl: { key: string; value: string } | null,
  resolvePort: ComposePortResolver
): Promise<ComposeDatabaseCandidateInternal | null> {
  const inspected =
    db.container_name || db.name ? await resolvePort(db.container_name ?? db.name, db.internal_port) : null;
  const fallbackPort = composeFallbackPort(db);
  const port = inspected?.hostPort ?? fallbackPort;
  const running = inspected?.running ?? false;
  const connectionUrl = port
    ? (rawUrl ? rewriteComposeUrl(rawUrl.value, db, port) : buildUrlFromDbEnv(db, port))
    : null;
  const note = port
    ? running
      ? "Existing compose database is running; ServerHoster can attach this service to it."
      : "Compose database has a published port; start it before relying on the service."
    : "Compose database has no host port published. Add a ports mapping or provision a managed database.";
  return {
    engine: db.engine,
    env_key: rawUrl?.key ?? envKeyForEngine(db.engine),
    compose_file: composeFile,
    app_service_name: app?.name ?? null,
    database_service_name: db.name,
    container_name: db.container_name,
    internal_port: db.internal_port,
    host: "localhost",
    port,
    running,
    available: Boolean(connectionUrl),
    connection_preview: connectionUrl ? previewConnectionUrl(connectionUrl) : null,
    connection_url: connectionUrl,
    note
  };
}

export async function detectComposeDatabaseCandidate(
  workingDir: string | null | undefined,
  opts: { composeServiceName?: string | null; resolvePort?: ComposePortResolver } = {}
): Promise<ComposeDatabaseCandidateInternal | null> {
  if (!workingDir) return null;
  const resolvePort = opts.resolvePort ?? (async () => null);
  for (const composeFile of composeFilesForWorkdir(workingDir)) {
    const services = parseComposeServices(composeFile);
    if (services.length === 0) continue;
    const dbs = services.map(classifyComposeDbService).filter((db): db is ComposeDbService => Boolean(db));
    if (dbs.length === 0) continue;
    const preferredApps = opts.composeServiceName
      ? services.filter((service) => service.name === opts.composeServiceName)
      : services;
    const appCandidates = [...preferredApps, ...services.filter((service) => !preferredApps.includes(service))];
    for (const app of appCandidates) {
      for (const [key, value] of Object.entries(app.env)) {
        if (!PERSISTENCE_ENV_HINTS.includes(key)) continue;
        const engine = engineForUrl(key, value);
        if (!engine) continue;
        const matchingDb = dbs.find((db) => {
          if (db.engine !== engine) return false;
          try {
            return hostMatchesDb(new URL(value).hostname, db);
          } catch {
            return false;
          }
        });
        if (!matchingDb) continue;
        return enrichComposeCandidate(composeFile, app, matchingDb, { key, value }, resolvePort);
      }
    }
    if (dbs.length === 1) {
      return enrichComposeCandidate(composeFile, null, dbs[0], null, resolvePort);
    }
  }
  return null;
}

function serviceHasPersistenceEnv(ctx: AppContext, svc: ServiceRow): boolean {
  const env = getServiceEnv(ctx, svc.id);
  if (PERSISTENCE_ENV_HINTS.some((key) => Boolean(env[key]))) return true;
  if (!svc.project_id) return false;
  const projectEnv = ctx.db
    .prepare(
      `SELECT 1 FROM project_env_vars
       WHERE project_id = ? AND key IN (${PERSISTENCE_ENV_HINTS.map(() => "?").join(",")})
       LIMIT 1`
    )
    .get(svc.project_id, ...PERSISTENCE_ENV_HINTS) as { 1: number } | undefined;
  return Boolean(projectEnv);
}

export async function listOrphanServices(ctx: AppContext): Promise<OrphanService[]> {
  const services = ctx.db
    .prepare(
      "SELECT id, project_id, name, status, linked_database_id, working_dir, compose_service_name FROM services WHERE type IN ('docker','process')"
    )
    .all() as ServiceRow[];

  const out: OrphanService[] = [];
  const resolvePort = await dockerPortResolver(ctx);
  for (const svc of services) {
    if (svc.linked_database_id) continue;
    if (serviceHasPersistenceEnv(ctx, svc)) continue;
    const code_signals = svc.working_dir ? scanForDatabaseDrivers(svc.working_dir) : [];
    const compose_database = await detectComposeDatabaseCandidate(svc.working_dir, {
      composeServiceName: svc.compose_service_name ?? null,
      resolvePort
    });
    const publicComposeDatabase = compose_database
      ? {
          engine: compose_database.engine,
          env_key: compose_database.env_key,
          compose_file: compose_database.compose_file,
          app_service_name: compose_database.app_service_name,
          database_service_name: compose_database.database_service_name,
          container_name: compose_database.container_name,
          internal_port: compose_database.internal_port,
          host: compose_database.host,
          port: compose_database.port,
          running: compose_database.running,
          available: compose_database.available,
          connection_preview: compose_database.connection_preview,
          note: compose_database.note
        }
      : null;
    out.push({
      service_id: svc.id,
      service_name: svc.name,
      project_id: svc.project_id ?? null,
      status: svc.status,
      reason: "no-database-url",
      code_signals,
      ...(publicComposeDatabase ? { compose_database: publicComposeDatabase } : {})
    });
  }
  return out;
}

export async function getComposeDatabaseConnectionForService(
  ctx: AppContext,
  serviceId: string
): Promise<ComposeDatabaseCandidateInternal | null> {
  const svc = ctx.db
    .prepare("SELECT id, working_dir, compose_service_name FROM services WHERE id = ?")
    .get(serviceId) as Pick<ServiceRow, "id" | "working_dir" | "compose_service_name"> | undefined;
  if (!svc) throw new Error("Service not found");
  return detectComposeDatabaseCandidate(svc.working_dir, {
    composeServiceName: svc.compose_service_name ?? null,
    resolvePort: await dockerPortResolver(ctx)
  });
}

export async function listEmbeddedDatabases(
  ctx: AppContext,
  opts: { includeLinkedServices?: boolean } = {}
): Promise<EmbeddedDatabase[]> {
  const services = ctx.db
    .prepare(
      "SELECT id, project_id, name, type, status, linked_database_id FROM services WHERE type = 'docker'"
    )
    .all() as ServiceRow[];

  const results: EmbeddedDatabase[] = [];
  await Promise.all(
    services.map(async (svc) => {
      // If a managed DB is already linked, the embedded fallback is no longer
      // hidden — skip to avoid double-counting.
      if (svc.linked_database_id && !opts.includeLinkedServices) return;
      const env = getServiceEnv(ctx, svc.id);
      const missingEnv = PERSISTENCE_ENV_HINTS.filter((k) => !env[k]);
      // Skip services that already have *some* explicit DB URL — they're
      // pointing at something external and the embedded file (if any) isn't
      // load-bearing.
      if (missingEnv.length < PERSISTENCE_ENV_HINTS.length) {
        // At least one persistence env is set; only flag if we still find a
        // SQLite file *and* DATABASE_URL specifically is missing.
        if (env.DATABASE_URL) return;
      }

      const containerName = containerNameForService(svc.id);
      let inspect: DockerInspect | null = null;
      try {
        inspect = (await ctx.docker.getContainer(containerName).inspect()) as DockerInspect;
      } catch {
        return;
      }
      if (!inspect?.State?.Running) return;

      const probe = await probeContainer(containerName);
      if (!probe) return;

      results.push({
        service_id: svc.id,
        service_name: svc.name,
        project_id: svc.project_id,
        container_id: inspect.Id ?? containerName,
        container_name: (inspect.Name ?? containerName).replace(/^\//, ""),
        engine: "sqlite",
        file_path: probe.path,
        size_bytes: probe.size,
        persistent: mountCoversPath(inspect.Mounts, probe.path),
        missing_env: missingEnv
      });
    })
  );
  return results;
}
