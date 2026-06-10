import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../../types.js";
import {
  getResource,
  resourceConfig,
  updateResourceRuntimeState,
  type ManagedResourceRow
} from "./lifecycle.js";
import { getResourceSecret } from "./secrets.js";
import { findFunctionsDirs, scanDirSecrets, type FunctionSecretRequirement } from "./secretsScan.js";

/**
 * Edge Function management for local Supabase resources (Database-Tracker
 * Phase 4, spec "Provisioning Method" step 5 + "Local Function Secrets").
 *
 * Responsibilities:
 *   - enumerate `supabase/functions/*` with per-function secret attribution;
 *   - generate the function env file under
 *     $SURVHUB_DATA_DIR/resources/<resourceId>/supabase/.env (mode 0600,
 *     values decrypted from resource secrets — never logged);
 *   - run `supabase functions serve --env-file <path>` as a resource-managed
 *     background process with captured logs (ring buffer surfaced by
 *     GET /resources/:id/logs?source=functions);
 *   - classify every referenced key into the spec's five UI states and mark
 *     functions degraded/disabled instead of ever failing provisioning.
 *
 * The serve process is spawned through an injectable seam (`setFunctionsSpawn`,
 * mirroring setRestartActions) so tests never start real processes.
 */

export type EdgeFunctionInfo = {
  name: string;
  /** Function directory, relative to the service working dir. */
  path: string;
  /** Env keys this specific function reads, with classification + sources. */
  secrets: FunctionSecretRequirement[];
};

/** Spec UI states for a function env key ("Local Function Secrets"). */
export type ResourceSecretState =
  | "generated"
  | "provided"
  | "missing-optional"
  | "disabled"
  | "missing-required";

export type FunctionSecretStateEntry = FunctionSecretRequirement & { state: ResourceSecretState };

export type EdgeFunctionStatus = {
  name: string;
  path: string;
  status: "serving" | "degraded" | "disabled";
  /** Keys still in a missing-* state (empty when disabled — intentional). */
  missing_secrets: string[];
  secrets: FunctionSecretStateEntry[];
};

/**
 * List Edge Functions under every `supabase/functions` dir with the env keys
 * each one reads. Shared-code reads outside a function dir still surface via
 * the aggregate `scanFunctionSecrets`; this view is per-function on purpose.
 */
export function listEdgeFunctions(servicePath: string): EdgeFunctionInfo[] {
  if (!servicePath || !fs.existsSync(servicePath)) return [];
  const functions: EdgeFunctionInfo[] = [];
  for (const functionsDir of findFunctionsDirs(servicePath)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(functionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // `_shared` and other underscore dirs are import helpers, not functions.
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = path.join(functionsDir, entry.name);
      functions.push({
        name: entry.name,
        path: path.relative(servicePath, full),
        secrets: scanDirSecrets(full, servicePath)
      });
    }
  }
  return functions.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- secret state classification ---------------------------------------------

/**
 * Generated values that live in config_json rather than resource_secrets:
 * present whenever the stack recorded its API URL.
 */
const CONFIG_DERIVED_KEYS = new Set(["SUPABASE_URL", "VITE_SUPABASE_URL", "APP_URL"]);

function disabledKeysOf(config: Record<string, unknown>): Set<string> {
  const raw = Array.isArray(config.disabled_secrets) ? config.disabled_secrets : [];
  return new Set(raw.filter((key): key is string => typeof key === "string"));
}

/**
 * Map scanned requirements to the spec's five UI states for one resource:
 * disabled > provided/generated (from the stored secret's is_generated flag)
 * > generated-from-config > missing-required (absent auto-generated) /
 * missing-optional (absent external/infra/unknown).
 */
export function classifySecretStates(
  ctx: AppContext,
  resource: ManagedResourceRow,
  requirements: FunctionSecretRequirement[]
): FunctionSecretStateEntry[] {
  const config = resourceConfig(resource);
  const disabled = disabledKeysOf(config);
  const hasApiUrl = typeof config.api_url === "string" && config.api_url.length > 0;
  const rows = ctx.db
    .prepare("SELECT key, is_generated FROM resource_secrets WHERE resource_id = ?")
    .all(resource.id) as Array<{ key: string; is_generated: number }>;
  const stored = new Map(rows.map((row) => [row.key, Boolean(row.is_generated)]));

  return requirements.map((req) => {
    let state: ResourceSecretState;
    if (disabled.has(req.key)) {
      state = "disabled";
    } else if (stored.has(req.key)) {
      state = stored.get(req.key) ? "generated" : "provided";
    } else if (hasApiUrl && CONFIG_DERIVED_KEYS.has(req.key)) {
      state = "generated";
    } else {
      state = req.classification === "auto-generated" ? "missing-required" : "missing-optional";
    }
    return { ...req, state };
  });
}

// ---- env file generation -------------------------------------------------------

/** Generated secret keys eligible for the function env file (NOT the JWT secret). */
const GENERATED_ENV_FILE_KEYS = ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "AI_KEY_ENCRYPTION_KEY"];

export function functionEnvFilePath(ctx: AppContext, resourceId: string): string {
  return path.join(ctx.config.dataRoot, "resources", resourceId, "supabase", ".env");
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/**
 * Write the function env file: generated stack values (SUPABASE_URL from
 * config api_url, anon/service-role/AI keys) plus every user-provided resource
 * secret, minus operator-disabled keys. File mode 0600; values are never
 * logged — callers only ever see the path + key names.
 */
export function writeFunctionEnvFile(ctx: AppContext, resourceId: string): { path: string; keys: string[] } {
  const resource = getResource(ctx, resourceId);
  if (!resource) throw new Error("Resource not found");
  const config = resourceConfig(resource);
  const disabled = disabledKeysOf(config);

  const env: Record<string, string> = {};
  if (typeof config.api_url === "string" && config.api_url) {
    env.SUPABASE_URL = config.api_url;
  }
  const rows = ctx.db
    .prepare("SELECT key, is_generated FROM resource_secrets WHERE resource_id = ? ORDER BY key")
    .all(resourceId) as Array<{ key: string; is_generated: number }>;
  for (const row of rows) {
    if (row.is_generated && !GENERATED_ENV_FILE_KEYS.includes(row.key)) continue;
    const value = getResourceSecret(ctx, resourceId, row.key);
    if (value !== null) env[row.key] = value;
  }
  for (const key of disabled) delete env[key];

  const filePath = functionEnvFilePath(ctx, resourceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const keys = Object.keys(env).sort();
  const content = keys.map((key) => `${key}=${quoteEnvValue(env[key])}`).join("\n") + "\n";
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  // writeFileSync's mode only applies on create — enforce on rewrite too.
  fs.chmodSync(filePath, 0o600);
  return { path: filePath, keys };
}

// ---- serve process management ----------------------------------------------------

export type FunctionsProcessHandle = {
  pid: number | null;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
};

export type FunctionsSpawn = (args: string[], options: { cwd: string }) => FunctionsProcessHandle;

const defaultSpawn: FunctionsSpawn = (args, options) => {
  const child = spawn("supabase", args, {
    cwd: options.cwd,
    // Detached (POSIX) so stop() can SIGTERM the whole process group — the CLI
    // forks the edge runtime and a bare child.kill leaves orphans behind.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    pid: child.pid ?? null,
    onOutput(listener) {
      child.stdout?.on("data", (chunk) => listener(String(chunk)));
      child.stderr?.on("data", (chunk) => listener(String(chunk)));
    },
    onExit(listener) {
      child.on("exit", (code) => listener(code));
      child.on("error", () => listener(-1));
    },
    stop() {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        /* already gone */
      }
    }
  };
};

let activeSpawn: FunctionsSpawn = defaultSpawn;

/** Test seam: replace the serve-process spawner (pass null to restore). */
export function setFunctionsSpawn(fn: FunctionsSpawn | null): void {
  activeSpawn = fn ?? defaultSpawn;
}

type ServeEntry = {
  handle: FunctionsProcessHandle;
  envFile: string;
  functions: string[];
  startedAt: string;
  exited: boolean;
};

/** Live serve processes per resource (this process's runtime registry). */
const serveRegistry = new Map<string, ServeEntry>();

/** Captured serve output per resource — survives serve restarts, capped. */
const logBuffers = new Map<string, string[]>();
const MAX_LOG_LINES = 2000;

function appendFunctionLog(resourceId: string, line: string): void {
  const buffer = logBuffers.get(resourceId) ?? [];
  buffer.push(line);
  if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES);
  logBuffers.set(resourceId, buffer);
}

/** Captured `supabase functions serve` output (most recent lines). */
export function getFunctionsLogs(resourceId: string, tail = 500): string {
  const buffer = logBuffers.get(resourceId) ?? [];
  return buffer.slice(-tail).join("\n");
}

export function isFunctionsServing(resourceId: string): boolean {
  const entry = serveRegistry.get(resourceId);
  return Boolean(entry && !entry.exited);
}

function persistFunctionsState(ctx: AppContext, resourceId: string, state: Record<string, unknown>): void {
  const resource = getResource(ctx, resourceId);
  if (!resource) return;
  updateResourceRuntimeState(ctx, resourceId, {
    config: { ...resourceConfig(resource), functions: state }
  });
}

function workdirOf(resource: ManagedResourceRow): string | null {
  const config = resourceConfig(resource);
  return typeof config.workdir === "string" && config.workdir ? config.workdir : null;
}

/**
 * Start `supabase functions serve --env-file <generated env>` from the service
 * working dir as a managed background process. Never throws: failures return
 * `{ started: false, error }` and persist a degraded functions state, because
 * missing optional secrets / a broken CLI must not fail provisioning (spec).
 */
export async function startFunctionsServe(
  ctx: AppContext,
  resource: ManagedResourceRow
): Promise<{ started: boolean; error?: string }> {
  await stopFunctionsServe(ctx, resource, { persist: false });
  const workdir = workdirOf(resource);
  if (!workdir || !fs.existsSync(workdir)) {
    const error = "Resource has no usable working directory for function serving";
    persistFunctionsState(ctx, resource.id, { enabled: false, error });
    return { started: false, error };
  }
  const functions = listEdgeFunctions(workdir);
  if (functions.length === 0) {
    const error = "No Edge Functions found under supabase/functions";
    persistFunctionsState(ctx, resource.id, { enabled: false, error });
    return { started: false, error };
  }

  try {
    const envFile = writeFunctionEnvFile(ctx, resource.id);
    const handle = activeSpawn(["functions", "serve", "--env-file", envFile.path], { cwd: workdir });
    const startedAt = new Date().toISOString();
    const entry: ServeEntry = {
      handle,
      envFile: envFile.path,
      functions: functions.map((fn) => fn.name),
      startedAt,
      exited: false
    };
    serveRegistry.set(resource.id, entry);

    appendFunctionLog(
      resource.id,
      `[functions] serving ${entry.functions.join(", ")} (env file: ${envFile.path})`
    );
    // Spec: logs must point at the exact missing secret and the files using it.
    for (const fn of functions) {
      for (const secret of classifySecretStates(ctx, resource, fn.secrets)) {
        if (secret.state === "missing-optional" || secret.state === "missing-required") {
          appendFunctionLog(
            resource.id,
            `[functions] ${fn.name}: missing secret ${secret.key} (${secret.state}) — referenced by ${secret.source_files.join(", ")}`
          );
        }
      }
    }

    handle.onOutput((chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) appendFunctionLog(resource.id, line);
      }
    });
    handle.onExit((code) => {
      if (entry.exited) return;
      entry.exited = true;
      appendFunctionLog(resource.id, `[functions] serve process exited (code ${code ?? "unknown"})`);
    });

    persistFunctionsState(ctx, resource.id, {
      enabled: true,
      pid: handle.pid ?? undefined,
      started_at: startedAt,
      env_file: envFile.path,
      functions: entry.functions
    });
    return { started: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendFunctionLog(resource.id, `[functions] failed to start serve process: ${message}`);
    persistFunctionsState(ctx, resource.id, { enabled: false, error: message });
    return { started: false, error: message };
  }
}

/** Stop the serve process (best effort) and mark functions disabled. */
export async function stopFunctionsServe(
  ctx: AppContext,
  resource: ManagedResourceRow,
  options: { persist?: boolean } = {}
): Promise<void> {
  const { persist = true } = options;
  const entry = serveRegistry.get(resource.id);
  if (entry) {
    entry.exited = true;
    try {
      entry.handle.stop();
    } catch {
      /* best effort */
    }
    serveRegistry.delete(resource.id);
    appendFunctionLog(resource.id, "[functions] serve process stopped");
  }
  if (!persist) return;
  const current = getResource(ctx, resource.id);
  if (!current) return;
  const config = resourceConfig(current);
  const previous =
    config.functions && typeof config.functions === "object"
      ? (config.functions as Record<string, unknown>)
      : {};
  if (entry || previous.enabled === true) {
    persistFunctionsState(ctx, resource.id, {
      ...previous,
      enabled: false,
      pid: undefined
    });
  }
}

/** Drop in-memory serve state + logs (resource removal). */
export function clearFunctionsRuntime(resourceId: string): void {
  serveRegistry.delete(resourceId);
  logBuffers.delete(resourceId);
}

/**
 * Per-function status: "disabled" when serving is off or a referenced secret
 * was explicitly disabled (operator intent — missing_secrets stays empty),
 * "degraded" when any referenced secret is still missing, else "serving".
 */
export function functionStatuses(ctx: AppContext, resource: ManagedResourceRow): EdgeFunctionStatus[] {
  const workdir = workdirOf(resource);
  const serving = isFunctionsServing(resource.id);
  return listEdgeFunctions(workdir ?? "").map((fn) => {
    const secrets = classifySecretStates(ctx, resource, fn.secrets);
    const missing = secrets
      .filter((secret) => secret.state === "missing-required" || secret.state === "missing-optional")
      .map((secret) => secret.key);
    const hasDisabledSecret = secrets.some((secret) => secret.state === "disabled");
    let status: EdgeFunctionStatus["status"];
    if (!serving || hasDisabledSecret) {
      status = "disabled";
    } else if (missing.length > 0) {
      status = "degraded";
    } else {
      status = "serving";
    }
    return {
      name: fn.name,
      path: fn.path,
      status,
      missing_secrets: status === "disabled" ? [] : missing,
      secrets
    };
  });
}
