import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../../types.js";
import { getResource, listLinksForService, resourceConfig } from "./lifecycle.js";
import { supabaseMigrationApply } from "./supabaseCli.js";

/**
 * Apply a repo's pending Supabase migrations as part of a git deploy
 * (docs/supabase-migrations-and-grants.md, Part B).
 *
 * Until now `supabase/migrations` only ever ran at PROVISION time. Pushing a new
 * migration to GitHub therefore shipped code that expected a table/column/RPC the
 * live stack did not have, and the app stayed broken until someone SSH'd in and
 * ran psql by hand — the deploy said "success" while the schema silently drifted.
 * Both migrations Awaire needed on 2026-09-06 landed that way.
 *
 * This runs on every git deploy, right after the checkout is reset and the managed
 * config.toml is re-materialised (so the CLI reads the real host ports and JWT
 * secret) and BEFORE the build, so build-time steps and the started process both
 * see the new schema.
 *
 * Safety rules, in order of importance:
 *   - LOCAL ONLY. The stack's db_url must resolve to a loopback host, so a
 *     resource still pointing at a hosted project is skipped, never migrated.
 *   - NEVER GUESSES WHICH DATABASE. A service can carry several active links,
 *     including to `failed` duplicates from earlier provisioning attempts. Exactly
 *     one started supabase stack is migrated; two or more means skip and warn.
 *   - NEVER seeds. `supabase migration up` only applies schema migrations and
 *     records them; `db reset` / seed.sql stay behind the explicit provision mode.
 *   - Runs exactly the SQL the repo committed — nothing generated, nothing dropped.
 *   - Serialised by a Postgres advisory lock, so two deploys (or a deploy racing a
 *     hand-run `supabase migration up`) cannot interleave.
 *   - Opt out per stack with `auto_migrate: false` in the resource config.
 *
 * Deploy-blocking is deliberate: a migration that fails leaves the schema behind
 * the code, so the deploy fails with the SQL error in the build log rather than
 * building and starting the app against a half-migrated database. The normal
 * failed-deploy path then tries to keep the previous build serving.
 */

export type MigrationSkipReason =
  | "no-supabase-resource"
  | "ambiguous-resources"
  | "disabled"
  | "stack-not-running"
  | "no-migrations-dir"
  | "non-local-db"
  | "no-history-table"
  | "up-to-date";

export type MigrationRunResult = {
  resourceId: string | null;
  /** Resource (stack) name, for the build log. */
  name: string;
  skipped?: MigrationSkipReason;
  /** Stack names considered when more than one matched. */
  candidates?: string[];
  /** Versions the repo has that the stack had not recorded. */
  pending: string[];
  /** Versions confirmed recorded after the apply. */
  applied: string[];
  /** True when a pending version sorted before the newest applied one. */
  outOfOrder: boolean;
  error?: string;
};

// ---- pure helpers -----------------------------------------------------------

/** `20260906201000_memberships_profiles_fk.sql` -> `20260906201000`. */
export function migrationVersion(filename: string): string | null {
  const match = /^(\d{14})_/.exec(filename) ?? /^(\d{14})\.sql$/i.exec(filename);
  return match ? match[1] : null;
}

/** Versions of the `.sql` files in `<workdir>/supabase/migrations`, sorted. */
export function listRepoMigrations(workdir: string): string[] {
  const dir = path.join(workdir, "supabase", "migrations");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const versions: string[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".sql")) continue;
    const version = migrationVersion(entry);
    if (version) versions.push(version);
  }
  return versions.sort();
}

/**
 * Diff the repo against the stack's recorded history. `outOfOrder` reports the
 * case the CLI refuses without `--include-all`: a pending file that sorts before
 * the newest version already applied (two branches merged in the wrong order).
 */
export function diffMigrations(
  repoVersions: string[],
  appliedVersions: string[]
): { pending: string[]; outOfOrder: boolean } {
  const applied = new Set(appliedVersions);
  const pending = repoVersions.filter((version) => !applied.has(version)).sort();
  const sortedApplied = [...appliedVersions].sort();
  const newestApplied = sortedApplied.length ? sortedApplied[sortedApplied.length - 1] : "";
  const outOfOrder = pending.some((version) => version < newestApplied);
  return { pending, outOfOrder };
}

// ---- database seam ----------------------------------------------------------

export type MigrationDbClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void> | void;
};

export type MigrationDbClientFactory = (
  dbUrl: string
) => Promise<MigrationDbClient> | MigrationDbClient;

/** Default factory: `pg` Client against the local stack's db_url. */
const defaultDbClientFactory: MigrationDbClientFactory = async (dbUrl) => {
  const pgModule = (await import("pg")) as typeof import("pg") & { default?: typeof import("pg") };
  const Client = pgModule.default?.Client ?? pgModule.Client;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  return {
    async query(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params as never);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: () => client.end()
  };
};

let activeDbClientFactory: MigrationDbClientFactory = defaultDbClientFactory;

/** Test seam: replace the Postgres client factory (pass null to restore `pg`). */
export function setMigrationDbClient(factory: MigrationDbClientFactory | null): void {
  activeDbClientFactory = factory ?? defaultDbClientFactory;
}

export type MigrationCliRunner = (
  workdir: string,
  options: { local?: boolean; includeAll?: boolean }
) => Promise<string>;

const defaultCliRunner: MigrationCliRunner = (workdir, options) =>
  supabaseMigrationApply(workdir, options);

let activeCliRunner: MigrationCliRunner = defaultCliRunner;

/** Test seam: replace the `supabase migration up` invocation. */
export function setMigrationCliRunner(runner: MigrationCliRunner | null): void {
  activeCliRunner = runner ?? defaultCliRunner;
}

// ---- guards -----------------------------------------------------------------

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1", "[::1]"]);

/** Only a loopback stack may be auto-migrated — never a hosted project. */
export function isLocalDbUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** `auto_migrate` defaults to ON; only an explicit `false` opts out. */
export function autoMigrateEnabled(config: Record<string, unknown>): boolean {
  return config.auto_migrate !== false;
}

/** A stack with a database to migrate. Provision leaves `ready`; start leaves `running`. */
const STARTED_STATUSES = new Set(["ready", "running"]);

// ---- stack history ----------------------------------------------------------

const APPLIED_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const HISTORY_EXISTS_SQL =
  "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present";
/** Namespaced advisory-lock key; the stack's database is the lock's scope. */
const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('survhub:supabase-migrations')) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('survhub:supabase-migrations'))";

async function readHistory(
  client: MigrationDbClient
): Promise<{ present: boolean; versions: string[] }> {
  const existence = await client.query(HISTORY_EXISTS_SQL);
  if (existence.rows[0]?.present !== true) return { present: false, versions: [] };
  const result = await client.query(APPLIED_SQL);
  return { present: true, versions: result.rows.map((row) => String(row.version)).filter(Boolean) };
}

/**
 * Read-only view of a stack's recorded migration history. Returns null when
 * there is nothing trustworthy to read — no local db_url, no history table, or
 * the stack is down — so callers render "unknown" instead of "nothing applied".
 */
export async function readStackAppliedVersions(
  config: Record<string, unknown>
): Promise<string[] | null> {
  const dbUrl = typeof config.db_url === "string" ? config.db_url : "";
  if (!dbUrl || !isLocalDbUrl(dbUrl)) return null;
  let client: MigrationDbClient;
  try {
    client = await activeDbClientFactory(dbUrl);
  } catch {
    return null;
  }
  try {
    const history = await readHistory(client);
    return history.present ? history.versions : null;
  } catch {
    return null;
  } finally {
    await client.end();
  }
}

// ---- resource resolution ----------------------------------------------------

export type MigrationTarget = {
  resourceId: string;
  name: string;
  config: Record<string, unknown>;
};

/**
 * The one started local Supabase stack this service's migrations belong to.
 *
 * A service can hold several ACTIVE links — the live fleet has one with three,
 * two of them pointing at `failed` duplicates from earlier provisioning attempts.
 * Migrating a dead duplicate would be silent and wrong, and a service linked to
 * two healthy stacks has no correct answer, so ambiguity is reported, not
 * resolved by picking the first row.
 */
export function resolveMigrationTarget(
  ctx: AppContext,
  serviceId: string
): { target: MigrationTarget | null; candidates: string[] } {
  const started: MigrationTarget[] = [];
  for (const link of listLinksForService(ctx, serviceId)) {
    const resource = getResource(ctx, link.resource_id);
    if (!resource || resource.profile !== "supabase") continue;
    if (!STARTED_STATUSES.has(resource.status)) continue;
    if (started.some((entry) => entry.resourceId === resource.id)) continue; // duplicate links
    started.push({ resourceId: resource.id, name: resource.name, config: resourceConfig(resource) });
  }
  const candidates = started.map((entry) => entry.name);
  return { target: started.length === 1 ? started[0] : null, candidates };
}

// ---- entry point ------------------------------------------------------------

const EMPTY: Omit<MigrationRunResult, "resourceId" | "name"> = {
  pending: [],
  applied: [],
  outOfOrder: false
};

/**
 * Run the repo's pending migrations against the service's local Supabase stack.
 * A result with `error` set means the caller should fail the deploy; every other
 * outcome is informational.
 */
export async function applyPendingSupabaseMigrations(
  ctx: AppContext,
  serviceId: string,
  targetPath: string
): Promise<MigrationRunResult> {
  const linkedSupabase = listLinksForService(ctx, serviceId).some((link) => {
    const resource = getResource(ctx, link.resource_id);
    return resource?.profile === "supabase";
  });
  const { target, candidates } = resolveMigrationTarget(ctx, serviceId);

  if (!target) {
    if (candidates.length > 1) {
      // Two started stacks: skip and name them rather than migrate the wrong one.
      return { ...EMPTY, resourceId: null, name: "", skipped: "ambiguous-resources", candidates };
    }
    return {
      ...EMPTY,
      resourceId: null,
      name: "",
      // A linked-but-stopped stack is worth a log line; no stack at all is not.
      skipped: linkedSupabase ? "stack-not-running" : "no-supabase-resource"
    };
  }

  const base: MigrationRunResult = { ...EMPTY, resourceId: target.resourceId, name: target.name };

  if (!autoMigrateEnabled(target.config)) return { ...base, skipped: "disabled" };

  const repoVersions = listRepoMigrations(targetPath);
  if (repoVersions.length === 0) return { ...base, skipped: "no-migrations-dir" };

  const dbUrl = typeof target.config.db_url === "string" ? target.config.db_url : "";
  if (!dbUrl || !isLocalDbUrl(dbUrl)) return { ...base, skipped: "non-local-db" };

  let client: MigrationDbClient;
  try {
    client = await activeDbClientFactory(dbUrl);
  } catch (error) {
    return {
      ...base,
      error: `could not connect to the local stack database: ${errorText(error)}`
    };
  }

  let locked = false;
  try {
    const before = await readHistory(client);
    if (!before.present) {
      // No history table: we cannot tell applied from pending, and replaying
      // every migration against a populated database is exactly the destructive
      // guess this must never make.
      return { ...base, skipped: "no-history-table" };
    }

    const { pending, outOfOrder } = diffMigrations(repoVersions, before.versions);
    if (pending.length === 0) return { ...base, skipped: "up-to-date" };

    const lock = await client.query(LOCK_SQL);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        ...base,
        pending,
        outOfOrder,
        error:
          "another migration run holds the advisory lock on this stack — " +
          "wait for it to finish, then redeploy"
      };
    }

    await activeCliRunner(targetPath, { local: true, includeAll: outOfOrder });

    // Trust the history table, not the CLI's exit code: a version that is still
    // unrecorded did not apply, and the deploy must not proceed as if the
    // schema were current.
    const after = await readHistory(client);
    const nowApplied = new Set(after.versions);
    const applied = pending.filter((version) => nowApplied.has(version));
    const stillPending = pending.filter((version) => !nowApplied.has(version));
    if (stillPending.length > 0) {
      return {
        ...base,
        pending,
        applied,
        outOfOrder,
        error:
          "`supabase migration up` exited 0 but these migrations are still unrecorded: " +
          stillPending.join(", ")
      };
    }
    return { ...base, pending, applied, outOfOrder };
  } catch (error) {
    return { ...base, error: errorText(error) };
  } finally {
    if (locked) {
      try {
        await client.query(UNLOCK_SQL);
      } catch {
        /* the session ends next line, which drops the lock anyway */
      }
    }
    await client.end();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build-log line for one run. Empty string when the result is worth no line. */
export function migrationLogLine(result: MigrationRunResult): string {
  if (result.skipped === "no-supabase-resource" || result.skipped === "no-migrations-dir") return "";
  if (result.skipped === "ambiguous-resources") {
    return (
      "Supabase migrations: SKIPPED — this service is linked to more than one started stack " +
      `(${result.candidates?.join(", ")}). Unlink the stale one, then redeploy.\n`
    );
  }
  const prefix = `Supabase migrations (${result.name || "unlinked"}): `;
  if (result.error) return `${prefix}FAILED — ${result.error}\n`;
  switch (result.skipped) {
    case "disabled":
      return `${prefix}auto-migrate is off for this stack — skipped.\n`;
    case "stack-not-running":
      return "Supabase migrations: linked stack is not started — skipped.\n";
    case "non-local-db":
      return `${prefix}db_url is not local — skipped (a hosted project is never migrated).\n`;
    case "no-history-table":
      return `${prefix}no supabase_migrations.schema_migrations table — skipped (cannot tell applied from pending).\n`;
    case "up-to-date":
      return `${prefix}up to date.\n`;
    default:
      return (
        `${prefix}applied ${result.applied.length} migration(s): ${result.applied.join(", ")}` +
        `${result.outOfOrder ? " (out of order, --include-all)" : ""}.\n`
      );
  }
}
