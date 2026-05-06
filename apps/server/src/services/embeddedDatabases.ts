import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const PERSISTENCE_ENV_HINTS = ["DATABASE_URL", "POSTGRES_URL", "MYSQL_URL", "MONGO_URL", "REDIS_URL"];

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
  const script = EMBEDDED_DB_PROBE_PATHS.map(
    (p) => `[ -f ${p} ] && wc -c < ${p} | tr -d ' \\n' && echo " ${p}"`
  ).join(" ; ");
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
export function listOrphanServices(ctx: AppContext): OrphanService[] {
  const services = ctx.db
    .prepare(
      "SELECT id, project_id, name, status, linked_database_id, working_dir FROM services WHERE type IN ('docker','process')"
    )
    .all() as Array<ServiceRow & { project_id: string | null; working_dir: string | null }>;

  const out: OrphanService[] = [];
  for (const svc of services) {
    if (svc.linked_database_id) continue;
    const env = getServiceEnv(ctx, svc.id);
    if (env.DATABASE_URL) continue;
    const code_signals = svc.working_dir ? scanForDatabaseDrivers(svc.working_dir) : [];
    out.push({
      service_id: svc.id,
      service_name: svc.name,
      project_id: svc.project_id ?? null,
      status: svc.status,
      reason: "no-database-url",
      code_signals
    });
  }
  return out;
}

export async function listEmbeddedDatabases(ctx: AppContext): Promise<EmbeddedDatabase[]> {
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
      if (svc.linked_database_id) return;
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
