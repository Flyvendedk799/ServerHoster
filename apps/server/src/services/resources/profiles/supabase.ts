import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../../../types.js";
import { broadcast, dockerUnavailableMessage, serializeError } from "../../../lib/core.js";
import {
  envFromResourceConfig,
  registerProfile,
  type DetectionSignal,
  type ProvisionInput,
  type ProvisionPlan,
  type ResourceProfile,
  type ResourceStatus
} from "../profiles.js";
import {
  createResource,
  deleteResource,
  getResource,
  linkResourceToService,
  listLinksForResource,
  resourceConfig,
  unlinkResource,
  updateResourceRuntimeState,
  updateResourceStatus,
  type ManagedResourceRow
} from "../lifecycle.js";
import { getResourceSecret, setResourceSecret } from "../secrets.js";
import { scanFunctionSecrets } from "../secretsScan.js";
import {
  clearFunctionsRuntime,
  isFunctionsServing,
  listEdgeFunctions,
  startFunctionsServe,
  stopFunctionsServe
} from "../functions.js";
import {
  checkSupabaseCli,
  parseSupabaseStatus,
  supabaseInit,
  supabaseMigrationApply,
  supabaseSeed,
  supabaseStart,
  supabaseStatus,
  supabaseStop,
  type SupabaseStatusInfo
} from "../supabaseCli.js";
import { restartOrRedeployService } from "../restart.js";

/**
 * Supabase resource profile (Database-Tracker Phases 2+3).
 *
 * Detection walks the service working dir for the spec'd signals (package
 * dependency, supabase/config.toml, migrations, edge functions, client code,
 * SUPABASE_* env keys) and scores them so Supabase apps are offered
 * "Add Local Supabase" instead of a misleading plain-Postgres flow.
 *
 * Provisioning (Phase 3) orchestrates the official Supabase CLI: preflight
 * (Docker + CLI + config.toml), `supabase start` from the service working dir,
 * `supabase status` parsing for URLs/keys/ports, schema-only migration apply
 * (seed only on explicit request), secret persistence (encrypted), service
 * linking, and restart/redeploy. No hosted data is ever imported.
 */

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
  ".vscode"
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export const SUPABASE_ENV_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY"
] as const;

/** Env values the local stack generates and injects into linked services. */
export const SUPABASE_GENERATED_ENV = [...SUPABASE_ENV_KEYS, "APP_URL"];

type ServiceRow = { id: string; project_id: string | null; working_dir: string | null };

function isEnvFile(name: string): boolean {
  return name.startsWith(".env");
}

function relPath(root: string, full: string): string {
  return path.relative(root, full) || path.basename(full);
}

function readFileBounded(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function packageSignal(filePath: string, rel: string): DetectionSignal | null {
  const content = readFileBounded(filePath);
  if (!content) return null;
  let parsed: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const declared = {
    ...parsed.dependencies,
    ...parsed.devDependencies,
    ...parsed.peerDependencies
  };
  if (!declared["@supabase/supabase-js"]) return null;
  return { kind: "package", value: "@supabase/supabase-js", source_file: rel, confidence: "high" };
}

function detectSupabaseSignals(servicePath: string): DetectionSignal[] {
  if (!servicePath || !fs.existsSync(servicePath)) return [];
  const signals: DetectionSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: DetectionSignal): void => {
    const key = `${signal.kind}:${signal.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(full, depth + 1);
        continue;
      }
      const rel = relPath(servicePath, full);
      const relPosix = rel.split(path.sep).join("/");

      // package.json dependency on @supabase/supabase-js.
      if (entry.name === "package.json") {
        const signal = packageSignal(full, rel);
        if (signal) push(signal);
        continue;
      }

      // supabase/config.toml.
      if (entry.name === "config.toml" && path.basename(dir) === "supabase") {
        push({ kind: "file", value: "supabase/config.toml", source_file: rel, confidence: "high" });
        continue;
      }

      // supabase/migrations/*.sql.
      if (/(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(relPosix)) {
        push({ kind: "migration", value: entry.name, source_file: rel, confidence: "high" });
        continue;
      }

      // supabase/functions/<name>/index.ts|js.
      const fnMatch = relPosix.match(/(^|\/)supabase\/functions\/([^/]+)\/index\.(ts|js)$/);
      if (fnMatch) {
        push({ kind: "function", value: fnMatch[2], source_file: rel, confidence: "high" });
        // Fall through: function code is also scanned for env keys below.
      }

      const isCode = CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      const isEnv = isEnvFile(entry.name);
      if (!isCode && !isEnv) continue;
      const content = readFileBounded(full);
      if (!content) continue;

      if (isCode) {
        // Source imports of the generated client module or direct createClient use.
        if (content.includes("@/integrations/supabase/client")) {
          push({
            kind: "code",
            value: "@/integrations/supabase/client",
            source_file: rel,
            confidence: "medium"
          });
        }
        if (content.includes("@supabase/supabase-js") && /\bcreateClient\s*\(/.test(content)) {
          push({
            kind: "code",
            value: "createClient(@supabase/supabase-js)",
            source_file: rel,
            confidence: "medium"
          });
        }
      }

      // SUPABASE env keys referenced in .env* files or code.
      for (const key of SUPABASE_ENV_KEYS) {
        if (new RegExp(`(^|[^A-Z0-9_])${key}([^A-Z0-9_]|$)`, "m").test(content)) {
          push({ kind: "env", value: key, source_file: rel, confidence: "medium" });
        }
      }
    }
  };

  walk(servicePath, 0);
  return signals;
}

/**
 * Confidence scoring per spec:
 *   high   — package dependency plus migrations or config.toml
 *   medium — package dependency plus env/code usage (or the dependency alone)
 *   low    — env usage only
 */
export function scoreSupabaseSignals(signals: DetectionSignal[]): "high" | "medium" | "low" | null {
  if (signals.length === 0) return null;
  const kinds = new Set(signals.map((signal) => signal.kind));
  const hasPackage = kinds.has("package");
  if (hasPackage && (kinds.has("migration") || kinds.has("file"))) return "high";
  if (hasPackage) return "medium";
  return "low";
}

function getServiceRow(ctx: AppContext, serviceId: string): ServiceRow {
  const service = ctx.db
    .prepare("SELECT id, project_id, working_dir FROM services WHERE id = ?")
    .get(serviceId) as ServiceRow | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

// ---- Phase 3: local stack provisioning --------------------------------------

type FullServiceRow = {
  id: string;
  project_id: string | null;
  name: string;
  type: string;
  working_dir: string | null;
  port: number | null;
  tunnel_url: string | null;
};

function getFullServiceRow(ctx: AppContext, serviceId: string): FullServiceRow {
  const service = ctx.db
    .prepare("SELECT id, project_id, name, type, working_dir, port, tunnel_url FROM services WHERE id = ?")
    .get(serviceId) as FullServiceRow | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

function emitResourceStatus(ctx: AppContext, resourceId: string, status: ResourceStatus): void {
  updateResourceStatus(ctx, resourceId, status);
  broadcast(ctx, { type: "resource_status", resourceId, status, profile: "supabase" });
}

function emitProvisionStep(ctx: AppContext, resourceId: string, step: string, message: string): void {
  broadcast(ctx, { type: "resource_provisioning", resourceId, step, message });
}

/** project_id from supabase/config.toml — keys the CLI's container labels/names. */
function supabaseProjectIdFromConfig(workdir: string): string | null {
  try {
    const content = fs.readFileSync(path.join(workdir, "supabase", "config.toml"), "utf8");
    const match = content.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort discovery of the stack's containers via the CLI's
 * `com.supabase.cli.project` label (fallback: supabase_* name prefix).
 * Failures yield [] — container names are diagnostics, not load-bearing.
 */
async function listSupabaseContainers(ctx: AppContext, workdir: string): Promise<string[]> {
  try {
    const projectId = supabaseProjectIdFromConfig(workdir);
    // dockerode wants every filter key mapped to string[] — build a uniform
    // Record instead of a union with optional keys (which breaks its typing).
    const filters: Record<string, string[]> = projectId
      ? { label: [`com.supabase.cli.project=${projectId}`] }
      : { name: ["supabase_"] };
    const containers = await ctx.docker.listContainers({ all: true, filters });
    return containers
      .map((container) => (container.Names?.[0] ?? "").replace(/^\//, ""))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function workdirOf(resource: ManagedResourceRow): string | null {
  const config = resourceConfig(resource);
  return typeof config.workdir === "string" && config.workdir ? config.workdir : null;
}

/**
 * Persist what `supabase status` reported for a running stack: config URLs
 * (api/graphql/studio/db), host ports, container names, and the generated
 * stack secrets. Shared by provisioning and start/restart so the values
 * recorded at provision time never go stale when supabase/config.toml changes.
 *
 * Guarded on purpose: empty/missing parsed fields NEVER clobber stored values
 * — a partial/odd status output keeps the last known-good info.
 */
export async function persistSupabaseStackInfo(
  ctx: AppContext,
  resourceId: string,
  statusInfo: SupabaseStatusInfo
): Promise<void> {
  const resource = getResource(ctx, resourceId);
  if (!resource) throw new Error("Resource not found");

  const config: Record<string, unknown> = { ...resourceConfig(resource) };
  if (statusInfo.api_url) config.api_url = statusInfo.api_url;
  if (statusInfo.graphql_url) config.graphql_url = statusInfo.graphql_url;
  if (statusInfo.studio_url) config.studio_url = statusInfo.studio_url;
  // db_url stays in config for control-plane use (introspection/bootstrap)
  // but is stripped from every API response (routes/resources.ts).
  if (statusInfo.db_url) config.db_url = statusInfo.db_url;

  const workdir = workdirOf(resource);
  const containers = workdir ? await listSupabaseContainers(ctx, workdir) : [];
  updateResourceRuntimeState(ctx, resourceId, {
    config,
    ports: Object.keys(statusInfo.ports).length > 0 ? statusInfo.ports : undefined,
    containers: containers.length > 0 ? containers : undefined
  });

  // Generated stack secrets — encrypted, preview-only in API responses.
  if (statusInfo.anon_key) {
    setResourceSecret(ctx, resourceId, "SUPABASE_ANON_KEY", statusInfo.anon_key, true);
  }
  if (statusInfo.service_role_key) {
    setResourceSecret(ctx, resourceId, "SUPABASE_SERVICE_ROLE_KEY", statusInfo.service_role_key, true);
  }
  if (statusInfo.jwt_secret) {
    setResourceSecret(ctx, resourceId, "SUPABASE_JWT_SECRET", statusInfo.jwt_secret, true);
  }
}

/**
 * Lightweight live status: container states from containers_json (no CLI
 * round-trip). Falls back to the persisted row status when Docker is
 * unreachable or no containers were recorded.
 */
export async function supabaseStackStatus(
  ctx: AppContext,
  resourceId: string
): Promise<{ status: ResourceStatus; details: Record<string, string> }> {
  const resource = getResource(ctx, resourceId);
  if (!resource) return { status: "error", details: {} };
  let containers: string[] = [];
  try {
    containers = JSON.parse(resource.containers_json || "[]") as string[];
  } catch {
    containers = [];
  }
  if (containers.length === 0) {
    return { status: resource.status as ResourceStatus, details: {} };
  }
  const details: Record<string, string> = {};
  try {
    for (const name of containers) {
      details[name] = await ctx.docker
        .getContainer(name)
        .inspect()
        .then((info) => String(info.State?.Status ?? "unknown"))
        .catch(() => "missing");
    }
  } catch {
    return { status: resource.status as ResourceStatus, details };
  }
  const states = Object.values(details);
  if (states.every((state) => state === "running")) return { status: "running", details };
  if (states.every((state) => state === "missing" || state === "exited")) {
    return { status: "stopped", details };
  }
  return { status: "degraded", details };
}

/** Start/stop/restart the local stack via the CLI from the recorded workdir. */
export async function supabaseResourceAction(
  ctx: AppContext,
  resourceId: string,
  action: "start" | "stop" | "restart"
): Promise<void> {
  const resource = getResource(ctx, resourceId);
  if (!resource) throw new Error("Resource not found");
  const workdir = workdirOf(resource);
  if (!workdir) throw new Error("Resource has no recorded working directory");
  const config = resourceConfig(resource);
  const functionsState =
    config.functions && typeof config.functions === "object"
      ? (config.functions as Record<string, unknown>)
      : {};
  const functionsWereEnabled = functionsState.enabled === true;
  if (action === "stop" || action === "restart") {
    // Functions serve first: it talks to the stack we're about to stop. On
    // restart we keep the persisted enabled flag so the start phase resumes it.
    await stopFunctionsServe(ctx, resource, { persist: action === "stop" });
    await supabaseStop(workdir);
    emitResourceStatus(ctx, resourceId, "stopped");
  }
  if (action === "start" || action === "restart") {
    await supabaseStart(workdir);
    // Re-read `supabase status` so the recorded ports/URLs/keys follow
    // supabase/config.toml changes instead of going stale (best effort — a
    // status/parse failure keeps the last known-good values; the stack itself
    // is up either way).
    try {
      await persistSupabaseStackInfo(ctx, resourceId, parseSupabaseStatus(await supabaseStatus(workdir)));
    } catch (error) {
      emitProvisionStep(
        ctx,
        resourceId,
        "status",
        `Could not refresh stack info after ${action}: ${serializeError(error)}`
      );
    }
    emitResourceStatus(ctx, resourceId, "running");
    // Resume function serving when it was enabled before (best effort —
    // failures degrade functions, never the stack action). startFunctionsServe
    // rewrites the env file first, so refreshed URLs/keys reach the functions.
    if (functionsWereEnabled || isFunctionsServing(resourceId)) {
      await startFunctionsServe(ctx, getResource(ctx, resourceId)!);
    }
  }
}

async function provisionSupabase(ctx: AppContext, input: ProvisionInput): Promise<ManagedResourceRow> {
  const service = getFullServiceRow(ctx, input.serviceId);
  // config.workdir override: services deployed in static-dist mode point their
  // working_dir at the built artifact (dist/), but the Supabase project files
  // (config.toml, migrations, functions) live at the clone root — the caller
  // passes that root explicitly.
  const workdirOverride =
    typeof input.config?.workdir === "string" && input.config.workdir ? input.config.workdir : null;
  const workdir = workdirOverride ?? service.working_dir ?? "";
  const mode = input.mode ?? "schema-only";

  // 1. Resource row first — even preflight failures leave a diagnosable row.
  const baseConfig: Record<string, unknown> = {
    mode,
    workdir,
    disabled_secrets: input.disabledSecrets ?? [],
    ...(input.config ?? {})
  };
  const resource = createResource(ctx, {
    projectId: input.projectId ?? service.project_id,
    name: input.name ?? `${service.name}-supabase`,
    profile: "supabase",
    status: "provisioning",
    config: baseConfig
  });
  emitResourceStatus(ctx, resource.id, "provisioning");

  let stackStarted = false;
  try {
    // Operator-provided secrets (encrypted at rest; never marked generated).
    for (const [key, value] of Object.entries(input.secrets ?? {})) {
      setResourceSecret(ctx, resource.id, key, value, false);
    }

    // 2. Preflight: Docker reachable, CLI installed, config.toml present.
    emitProvisionStep(ctx, resource.id, "preflight", "Checking Docker and Supabase CLI");
    if (!workdir || !fs.existsSync(workdir)) {
      throw new Error("Service working directory does not exist — deploy the service first.");
    }
    try {
      await ctx.docker.ping();
    } catch (error) {
      throw new Error(dockerUnavailableMessage(error) ?? `Docker is not reachable: ${serializeError(error)}`);
    }
    const cli = await checkSupabaseCli();
    if (!cli.available) throw new Error(cli.instructions ?? "Supabase CLI not found");

    const configToml = path.join(workdir, "supabase", "config.toml");
    if (!fs.existsSync(configToml)) {
      // `init: true` is the explicit user confirmation required by the spec.
      if (baseConfig.init === true) {
        emitProvisionStep(ctx, resource.id, "init", "Creating supabase/config.toml via supabase init");
        await supabaseInit(workdir);
      } else {
        throw new Error(
          "No supabase/config.toml in the service working directory. Confirm initialization (config.init=true) to create one, or pick another profile."
        );
      }
    }

    // 3. Start the local stack and capture its URLs/keys/ports.
    emitProvisionStep(ctx, resource.id, "start", "Starting local Supabase stack (supabase start)");
    await supabaseStart(workdir);
    stackStarted = true;

    emitProvisionStep(ctx, resource.id, "status", "Reading stack status (supabase status)");
    const statusInfo = parseSupabaseStatus(await supabaseStatus(workdir));
    if (!statusInfo.api_url || !statusInfo.anon_key) {
      throw new Error("Could not parse `supabase status` output (missing API URL or anon key).");
    }

    // Shared persistence (also used by start/restart re-parse): config URLs,
    // ports, container names, and the generated stack secrets — encrypted,
    // preview-only in API responses.
    await persistSupabaseStackInfo(ctx, resource.id, statusInfo);

    // AI_KEY_ENCRYPTION_KEY: generate when function code reads it and the
    // operator didn't provide one (spec: generated local function secret).
    const functionSecrets = scanFunctionSecrets(workdir);
    if (
      functionSecrets.some((secret) => secret.key === "AI_KEY_ENCRYPTION_KEY") &&
      getResourceSecret(ctx, resource.id, "AI_KEY_ENCRYPTION_KEY") === null
    ) {
      setResourceSecret(
        ctx,
        resource.id,
        "AI_KEY_ENCRYPTION_KEY",
        crypto.randomBytes(32).toString("base64"),
        true
      );
    }

    // 4. Migrations per mode. Never imports hosted data.
    if (mode === "schema-and-seed") {
      emitProvisionStep(ctx, resource.id, "migrate", "Applying migrations + seed (supabase db reset)");
      await supabaseSeed(workdir);
    } else if (mode === "schema-only") {
      emitProvisionStep(ctx, resource.id, "migrate", "Applying schema migrations (supabase migration up)");
      await supabaseMigrationApply(workdir);
    } else {
      emitProvisionStep(ctx, resource.id, "migrate", "Empty stack requested — skipping migrations");
    }

    // 5. Edge Functions (Phase 4): serve supabase/functions/* locally as a
    // resource-managed process with a generated env file under
    // $SURVHUB_DATA_DIR/resources/<resourceId>/supabase/.env. Serve failures
    // and missing optional secrets DEGRADE functions — they never fail
    // provisioning (spec "Local Function Secrets").
    const edgeFunctions = listEdgeFunctions(workdir);
    if (edgeFunctions.length > 0 && input.serveFunctions !== false) {
      emitProvisionStep(
        ctx,
        resource.id,
        "functions",
        `Serving ${edgeFunctions.length} Edge Function(s) locally (supabase functions serve)`
      );
      const serve = await startFunctionsServe(ctx, getResource(ctx, resource.id)!);
      if (!serve.started) {
        emitProvisionStep(
          ctx,
          resource.id,
          "functions",
          `Edge Function serving failed — functions marked degraded: ${serve.error ?? "unknown error"}`
        );
      }
    }

    // 6. Link the requesting service so env injection activates.
    linkResourceToService(ctx, { serviceId: service.id, resourceId: resource.id });

    // 7./8. Restart or rebuild so the service picks up the injected env.
    if (input.restart !== false) {
      emitProvisionStep(ctx, resource.id, "restart", "Restarting/redeploying service with new env");
      try {
        await restartOrRedeployService(ctx, service.id);
      } catch (error) {
        // The stack is healthy and env is linked — a restart failure degrades
        // UX but must not tear down the freshly provisioned resource.
        emitProvisionStep(
          ctx,
          resource.id,
          "restart",
          `Service restart failed (stack is up): ${serializeError(error)}`
        );
      }
    }

    emitResourceStatus(ctx, resource.id, "ready");
    emitProvisionStep(ctx, resource.id, "done", "Local Supabase stack is ready");
    return getResource(ctx, resource.id)!;
  } catch (error) {
    // Cleanup path: stop the stack (and any serve process) if we started it,
    // keep the row + error for diagnostics (spec: cleanup for failed provisioning).
    if (stackStarted) {
      try {
        const startedResource = getResource(ctx, resource.id);
        if (startedResource) await stopFunctionsServe(ctx, startedResource, { persist: false });
      } catch {
        /* best effort */
      }
      try {
        await supabaseStop(workdir);
      } catch {
        /* best effort */
      }
    }
    const failedResource = getResource(ctx, resource.id);
    if (failedResource) {
      updateResourceRuntimeState(ctx, resource.id, {
        config: { ...resourceConfig(failedResource), error: serializeError(error) }
      });
    }
    emitResourceStatus(ctx, resource.id, "failed");
    emitProvisionStep(ctx, resource.id, "failed", serializeError(error));
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Boot reconcile: bring previously-running local Supabase stacks (and their
 * edge-function serve processes) back up after a ServerHoster restart. The
 * serve child dies with us, and the CLI's containers may be stopped after a
 * host reboot — without this, a hosted app's backend silently stays down
 * until someone presses Start. Failures log per-resource and never block boot.
 */
export async function reconcileSupabaseResourcesOnBoot(ctx: AppContext): Promise<void> {
  const rows = ctx.db
    .prepare(
      "SELECT id, name FROM managed_resources WHERE profile = 'supabase' AND status IN ('ready', 'running', 'degraded')"
    )
    .all() as Array<{ id: string; name: string }>;
  for (const row of rows) {
    try {
      await supabaseResourceAction(ctx, row.id, "start");
      broadcast(ctx, { type: "resource_status", resourceId: row.id, status: "running", profile: "supabase" });
    } catch (error) {
      emitProvisionStep(
        ctx,
        row.id,
        "boot",
        `Boot reconcile failed for ${row.name}: ${serializeError(error)}`
      );
    }
  }
}

export const supabaseProfile: ResourceProfile = {
  id: "supabase",
  label: "Local Supabase",
  detect(servicePath: string): DetectionSignal[] {
    return detectSupabaseSignals(servicePath);
  },
  async plan(ctx, serviceId): Promise<ProvisionPlan> {
    const service = getServiceRow(ctx, serviceId);
    const workingDir = service.working_dir ?? "";
    const signals = detectSupabaseSignals(workingDir);
    const confidence = scoreSupabaseSignals(signals) ?? "low";
    const functionSecrets = scanFunctionSecrets(workingDir);
    const hasFunctions = signals.some((signal) => signal.kind === "function");

    return {
      profile: "supabase",
      service_id: serviceId,
      project_id: service.project_id,
      confidence,
      signals,
      actions: [
        { id: "start-stack", label: "Start local Supabase stack", risk: "safe", default_enabled: true },
        {
          id: "apply-migrations",
          label: "Apply schema migrations (schema only)",
          risk: "safe",
          default_enabled: true
        },
        {
          id: "run-seed",
          label: "Run seed data",
          risk: "destructive",
          default_enabled: false
        },
        {
          id: "serve-functions",
          label: "Serve Edge Functions locally",
          risk: "safe",
          default_enabled: hasFunctions
        },
        {
          id: "bootstrap-user",
          label: "Create first local user/admin/org",
          risk: "safe",
          default_enabled: false
        }
      ],
      env: {
        generated: [...SUPABASE_GENERATED_ENV],
        required_user_input: [],
        optional_user_input: functionSecrets
          .filter((secret) => secret.classification === "optional-external")
          .map((secret) => secret.key),
        injected: []
      }
    };
  },
  async provision(ctx, input): Promise<ManagedResourceRow> {
    return provisionSupabase(ctx, input);
  },
  async status(ctx, resourceId): Promise<ResourceStatus> {
    const { status } = await supabaseStackStatus(ctx, resourceId);
    return status;
  },
  /**
   * SYNCHRONOUS by contract — resolved from config_json + resource_secrets
   * only (getServiceEnvWithLinks is sync and shared by deploy + runtime).
   *
   * Exposure policy: anon key + API URL go to every linked service (they are
   * public by design). The SERVICE ROLE key bypasses RLS, so it is only
   * injected into process/docker (backend) services — NEVER into static
   * frontends, whose built bundle is world-readable; a static service can
   * still opt in explicitly via its link's env_map. The JWT secret and db_url
   * are control-plane internals and are never injected. APP_URL is added when
   * the linked service has a public tunnel or local port.
   */
  env(ctx, resourceId, serviceId): Record<string, string> {
    const resource = getResource(ctx, resourceId);
    if (!resource) return {};
    const config = resourceConfig(resource);
    // Manual/legacy env maps still apply (config_json.env), generated values win.
    const env: Record<string, string> = envFromResourceConfig(resource);

    const apiUrl = typeof config.api_url === "string" && config.api_url ? config.api_url : null;
    if (apiUrl) {
      env.SUPABASE_URL = apiUrl;
      env.VITE_SUPABASE_URL = apiUrl;
    }
    const anonKey = getResourceSecret(ctx, resourceId, "SUPABASE_ANON_KEY");
    if (anonKey) {
      env.SUPABASE_ANON_KEY = anonKey;
      env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey;
    }

    const service = ctx.db
      .prepare("SELECT type, port, tunnel_url FROM services WHERE id = ?")
      .get(serviceId) as { type: string; port: number | null; tunnel_url: string | null } | undefined;
    if (service && service.type !== "static") {
      const serviceRoleKey = getResourceSecret(ctx, resourceId, "SUPABASE_SERVICE_ROLE_KEY");
      if (serviceRoleKey) env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
    }
    const appUrl = service?.tunnel_url || (service?.port ? `http://localhost:${service.port}` : null);
    if (appUrl) env.APP_URL = appUrl;

    // Operator-disabled keys (config_json.disabled_secrets) are never injected.
    const disabled = Array.isArray(config.disabled_secrets) ? config.disabled_secrets : [];
    for (const key of disabled) {
      if (typeof key === "string") delete env[key];
    }
    return env;
  },
  async remove(ctx, resourceId): Promise<void> {
    const resource = getResource(ctx, resourceId);
    if (!resource) return;
    // Best-effort teardown: functions serve first, then the stack; the row
    // must go away even when the CLI fails.
    try {
      await stopFunctionsServe(ctx, resource, { persist: false });
    } catch {
      /* best effort */
    }
    clearFunctionsRuntime(resourceId);
    const resourceDataDir = path.join(ctx.config.dataRoot, "resources", resourceId);
    try {
      fs.rmSync(resourceDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    const workdir = workdirOf(resource);
    if (workdir) {
      try {
        await supabaseStop(workdir);
      } catch {
        /* best effort */
      }
    }
    // Deactivate links first so env injection stops even if delete fails.
    for (const link of listLinksForResource(ctx, resourceId)) {
      unlinkResource(ctx, link.service_id, resourceId);
    }
    deleteResource(ctx, resourceId);
  }
};

registerProfile(supabaseProfile);
