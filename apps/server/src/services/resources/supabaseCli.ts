import { execFile } from "node:child_process";

/**
 * Supabase CLI wrapper (Database-Tracker Phase 3).
 *
 * Every CLI interaction for the local Supabase stack goes through this module
 * so the rest of the codebase never spawns `supabase` directly. The actual
 * process execution is injectable (`setSupabaseCliRunner`) which keeps the
 * whole provisioning flow unit-testable without Docker or the CLI installed —
 * tests swap in a fake runner that returns pinned outputs.
 *
 * Output parsing (`parseSupabaseStatus`) is a pure function tested against
 * pinned fixtures of both `supabase status` formats (Risk Register: CLI output
 * changes → robust parser + fixture tests).
 */

export type CliResult = { code: number; stdout: string; stderr: string };

export type CliRunnerOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type CliRunner = (command: string, args: string[], options?: CliRunnerOptions) => Promise<CliResult>;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Default runner: execFile with captured output; never rejects on non-zero exit. */
const defaultRunner: CliRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: MAX_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const rawCode = (error as { code?: number | string }).code;
        resolve({
          code: typeof rawCode === "number" ? rawCode : -1,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || error.message
        });
      }
    );
  });

let activeRunner: CliRunner = defaultRunner;

/** Test seam: replace the process runner (pass null to restore the default). */
export function setSupabaseCliRunner(runner: CliRunner | null): void {
  activeRunner = runner ?? defaultRunner;
}

function runCli(args: string[], options?: CliRunnerOptions): Promise<CliResult> {
  return activeRunner("supabase", args, options);
}

function failureMessage(action: string, result: CliResult): string {
  const detail = (result.stderr || result.stdout).trim().slice(-1500);
  return `supabase ${action} failed (exit ${result.code})${detail ? `:\n${detail}` : ""}`;
}

export const SUPABASE_CLI_INSTALL_INSTRUCTIONS =
  "Supabase CLI not found. Install it with `brew install supabase/tap/supabase` (macOS/Linuxbrew) " +
  "or see https://supabase.com/docs/guides/local-development/cli/getting-started — then retry provisioning.";

export async function checkSupabaseCli(): Promise<{
  available: boolean;
  version?: string;
  instructions?: string;
}> {
  const result = await runCli(["--version"], { timeoutMs: 15_000 });
  if (result.code === 0) {
    const version = result.stdout.trim().split(/\s+/).pop() ?? result.stdout.trim();
    return { available: true, version };
  }
  return { available: false, instructions: SUPABASE_CLI_INSTALL_INSTRUCTIONS };
}

/** `supabase init` — creates supabase/config.toml in a repo that has none. */
export async function supabaseInit(workdir: string): Promise<void> {
  const result = await runCli(["init"], { cwd: workdir, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(failureMessage("init", result));
}

/**
 * `supabase start` from the service working dir. First start pulls the whole
 * stack's images, so the timeout is deliberately generous.
 */
export async function supabaseStart(workdir: string, env?: Record<string, string>): Promise<string> {
  const result = await runCli(["start"], { cwd: workdir, env, timeoutMs: 15 * 60_000 });
  if (result.code !== 0) throw new Error(failureMessage("start", result));
  return result.stdout;
}

export async function supabaseStop(workdir: string): Promise<string> {
  const result = await runCli(["stop"], { cwd: workdir, timeoutMs: 5 * 60_000 });
  if (result.code !== 0) throw new Error(failureMessage("stop", result));
  return result.stdout;
}

/**
 * `supabase status`. Primary format is `-o env` (stable KEY="value" lines);
 * when that flag isn't supported by the installed CLI we fall back to the
 * plain text output. parseSupabaseStatus understands both.
 */
export async function supabaseStatus(workdir: string): Promise<string> {
  const envResult = await runCli(["status", "-o", "env"], { cwd: workdir, timeoutMs: 60_000 });
  if (envResult.code === 0 && envResult.stdout.trim()) return envResult.stdout;
  const textResult = await runCli(["status"], { cwd: workdir, timeoutMs: 60_000 });
  if (textResult.code !== 0) throw new Error(failureMessage("status", textResult));
  return textResult.stdout;
}

/**
 * Schema-only migration apply. `supabase migration up` runs every pending
 * migration in supabase/migrations against the LOCAL stack and records each in
 * supabase_migrations.schema_migrations — the CLI path that tracks migration
 * state (vs `db push`, which targets linked remote projects). It never imports
 * hosted data and never runs supabase/seed.sql.
 */
export async function supabaseMigrationApply(workdir: string): Promise<string> {
  const result = await runCli(["migration", "up"], { cwd: workdir, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(failureMessage("migration up", result));
  return result.stdout;
}

/**
 * Explicit "schema-and-seed" path. `supabase db reset` is the CLI's canonical
 * seed mechanism: it recreates the local database, re-applies all migrations
 * (recording state), and then runs supabase/seed.sql. Only invoked when the
 * operator explicitly picked the seed mode — never by default.
 */
export async function supabaseSeed(workdir: string): Promise<string> {
  const result = await runCli(["db", "reset"], { cwd: workdir, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(failureMessage("db reset (seed)", result));
  return result.stdout;
}

// ---- status output parsing --------------------------------------------------

export type SupabaseStatusInfo = {
  api_url: string | null;
  graphql_url: string | null;
  db_url: string | null;
  studio_url: string | null;
  anon_key: string | null;
  service_role_key: string | null;
  jwt_secret: string | null;
  /** Host ports extracted from the URLs (api/db/studio when present). */
  ports: Record<string, number>;
};

function portOf(url: string | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Text-format labels → canonical keys (case-insensitive match). */
const TEXT_LABELS: Record<string, keyof SupabaseStatusInfo> = {
  "api url": "api_url",
  "graphql url": "graphql_url",
  "db url": "db_url",
  "studio url": "studio_url",
  "anon key": "anon_key",
  "service_role key": "service_role_key",
  "service role key": "service_role_key",
  "jwt secret": "jwt_secret"
};

/** Env-format keys (`supabase status -o env`) → canonical keys. */
const ENV_KEYS: Record<string, keyof SupabaseStatusInfo> = {
  API_URL: "api_url",
  GRAPHQL_URL: "graphql_url",
  DB_URL: "db_url",
  STUDIO_URL: "studio_url",
  ANON_KEY: "anon_key",
  SERVICE_ROLE_KEY: "service_role_key",
  JWT_SECRET: "jwt_secret"
};

/**
 * Parse `supabase status` output into a structured shape. Pure function;
 * handles BOTH the `-o env` format (KEY="value" lines) and the human text
 * format ("   API URL: http://…" lines) so a CLI that ignores `-o env` still
 * parses. Unknown lines are skipped — additions to the CLI output are inert.
 */
export function parseSupabaseStatus(output: string): SupabaseStatusInfo {
  const info: SupabaseStatusInfo = {
    api_url: null,
    graphql_url: null,
    db_url: null,
    studio_url: null,
    anon_key: null,
    service_role_key: null,
    jwt_secret: null,
    ports: {}
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Env format: KEY="value" / KEY=value
    const envMatch = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (envMatch) {
      const key = ENV_KEYS[envMatch[1]];
      if (key && key !== "ports" && !info[key]) {
        (info[key] as string | null) = unquote(envMatch[2]) || null;
      }
      continue;
    }

    // Text format: "Label: value" (label may contain spaces/underscores).
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const label = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const key = TEXT_LABELS[label];
    if (key && key !== "ports" && value && !info[key]) {
      (info[key] as string | null) = value;
    }
  }

  const apiPort = portOf(info.api_url);
  const dbPort = portOf(info.db_url);
  const studioPort = portOf(info.studio_url);
  if (apiPort) info.ports.api = apiPort;
  if (dbPort) info.ports.db = dbPort;
  if (studioPort) info.ports.studio = studioPort;
  return info;
}
