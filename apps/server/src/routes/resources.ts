import { z } from "zod";
import type { AppContext } from "../types.js";
import { broadcast, serializeError } from "../lib/core.js";
import { maskSecret } from "../security.js";
import { containerAction, getDatabase } from "../services/databases.js";
import { createNotification } from "../services/notifications.js";
import {
  getResource,
  linkResourceToService,
  listLinksForResource,
  listResources,
  resourceConfig,
  unlinkResource,
  updateResourceRuntimeState,
  updateResourceStatus,
  type ManagedResourceRow,
  type ServiceResourceLinkRow
} from "../services/resources/lifecycle.js";
import {
  classifySecretStates,
  functionStatuses,
  getFunctionsLogs,
  isFunctionsServing,
  startFunctionsServe,
  writeFunctionEnvFile,
  type EdgeFunctionStatus,
  type FunctionSecretStateEntry
} from "../services/resources/functions.js";
import {
  buildBootstrapPlan,
  executeBootstrap,
  introspectBootstrapSchema,
  requireBootstrapResource,
  type BootstrapRequest
} from "../services/resources/bootstrap.js";
import { getProfile, listProfiles } from "../services/resources/profiles.js";
import { supabaseResourceAction } from "../services/resources/profiles/supabase.js";
import { getLatestScan, listLatestScans, runDependencyScan } from "../services/resources/scan.js";
import { listResourceSecrets, setResourceSecret } from "../services/resources/secrets.js";
import { scanFunctionSecrets } from "../services/resources/secretsScan.js";
import { refreshLoginIngress } from "../services/cloudflare.js";

/**
 * Resource API (Database-Tracker Phases 2+3): profile listing, dependency
 * scans, managed-resource views, provisioning, lifecycle actions, logs, and
 * service linking.
 *
 * Secret hygiene: responses never carry raw secret values — resource secrets
 * are preview-only (listResourceSecrets), env values stored in config_json /
 * link env maps are masked before serialization, and control-plane internals
 * (db_url) are stripped from config entirely. The service role key, JWT
 * secret, and db_url are NEVER returned by any route.
 */

const provisionSchema = z.object({
  serviceId: z.string().min(1),
  profile: z.enum(["supabase", "postgres", "redis", "mysql", "mongo", "manual"]),
  mode: z.enum(["schema-only", "schema-and-seed", "empty"]).default("schema-only"),
  restart: z.boolean().default(true),
  name: z.string().min(1).optional(),
  secrets: z.record(z.string()).optional(),
  disabledSecrets: z.array(z.string()).optional(),
  serveFunctions: z.boolean().optional(),
  config: z.record(z.unknown()).optional()
});

const secretsUpdateSchema = z.object({
  /** Upsert user-provided secrets (stored encrypted, is_generated=false). */
  secrets: z.record(z.string()).optional(),
  /** Keys to disable locally (config_json.disabled_secrets). */
  disable: z.array(z.string()).optional(),
  /** Keys to re-enable. */
  enable: z.array(z.string()).optional()
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  makePlatformAdmin: z.boolean().optional(),
  organization: z
    .object({
      create: z.boolean(),
      name: z.string().min(1),
      slug: z.string().min(1)
    })
    .optional()
});

const linkSchema = z.object({
  serviceId: z.string().min(1),
  envMap: z.record(z.string()).optional()
});

const unlinkSchema = z.object({ serviceId: z.string().min(1) });

/** Config keys that never leave the control plane (Security Requirements). */
const INTERNAL_CONFIG_KEYS = new Set(["db_url"]);

function refreshPublicResourceIngress(ctx: AppContext): void {
  try {
    refreshLoginIngress(ctx);
  } catch (error) {
    ctx.app.log?.warn?.({ err: error }, "refreshLoginIngress after resource link change failed");
  }
}

function maskEnvValues(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      typeof entry === "string" ? maskSecret(entry) : entry
    ])
  );
}

function redactedConfig(resource: ManagedResourceRow): Record<string, unknown> {
  const config: Record<string, unknown> = { ...resourceConfig(resource) };
  for (const key of INTERNAL_CONFIG_KEYS) delete config[key];
  if ("env" in config) {
    config.env = maskEnvValues(config.env);
  }
  return config;
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json || "null");
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function serializeResource(ctx: AppContext, resource: ManagedResourceRow) {
  return {
    id: resource.id,
    project_id: resource.project_id,
    name: resource.name,
    profile: resource.profile,
    status: resource.status,
    config: redactedConfig(resource),
    ports: parseJson<Record<string, number>>(resource.ports_json, {}),
    containers: parseJson<string[]>(resource.containers_json, []),
    created_at: resource.created_at,
    updated_at: resource.updated_at,
    secrets: listResourceSecrets(ctx, resource.id),
    links: listLinksForResource(ctx, resource.id, false).map(serializeLink)
  };
}

function serializeLink(link: ServiceResourceLinkRow) {
  return {
    id: link.id,
    service_id: link.service_id,
    resource_id: link.resource_id,
    active: Boolean(link.active),
    env_map: maskEnvValues(parseJson<Record<string, string>>(link.env_map_json, {})) as Record<
      string,
      string
    >,
    created_at: link.created_at,
    updated_at: link.updated_at
  };
}

/**
 * Secret-state view for one resource (spec "Local Function Secrets" UI
 * states): per-function statuses plus the aggregate key list, every key
 * classified as generated | provided | missing-optional | disabled |
 * missing-required with the referencing source files.
 */
function envRequirementsView(
  ctx: AppContext,
  resource: ManagedResourceRow
): {
  resource_id: string;
  serving: boolean;
  functions: EdgeFunctionStatus[];
  aggregate: FunctionSecretStateEntry[];
} {
  const config = resourceConfig(resource);
  const workdir = typeof config.workdir === "string" ? config.workdir : "";
  return {
    resource_id: resource.id,
    serving: isFunctionsServing(resource.id),
    functions: functionStatuses(ctx, resource),
    aggregate: classifySecretStates(ctx, resource, scanFunctionSecrets(workdir))
  };
}

/** Profiles backed by a legacy `databases` row (config_json.database_id). */
const LEGACY_DB_PROFILES = new Set(["postgres", "mysql", "mongo"]);

/**
 * Start/stop/restart dispatch per profile. Supabase resources go through the
 * CLI (whole-stack semantics; start/restart re-reads `supabase status` so
 * recorded ports/keys never go stale); postgres/mysql/mongo resources act on
 * the legacy database container they wrap. Other profiles have no runtime to
 * act on.
 */
async function runResourceAction(
  ctx: AppContext,
  resource: ManagedResourceRow,
  action: "start" | "stop" | "restart"
): Promise<void> {
  if (resource.profile === "supabase") {
    await supabaseResourceAction(ctx, resource.id, action);
    return;
  }
  if (LEGACY_DB_PROFILES.has(resource.profile)) {
    const config = resourceConfig(resource);
    const databaseId = typeof config.database_id === "string" ? config.database_id : null;
    const db = databaseId ? getDatabase(ctx, databaseId) : null;
    if (!db) throw new Error("Resource has no backing database container");
    await containerAction(ctx, db, action);
    updateResourceStatus(ctx, resource.id, action === "stop" ? "stopped" : "running");
    return;
  }
  throw new Error(`${action} is not supported for the "${resource.profile}" profile`);
}

export function registerResourceRoutes(ctx: AppContext): void {
  ctx.app.get("/resources/profiles", async () => {
    return listProfiles().map((profile) => ({ id: profile.id, label: profile.label }));
  });

  /** Latest persisted dependency scan per service. */
  ctx.app.get("/resources/scans", async () => {
    return listLatestScans(ctx);
  });

  ctx.app.get("/resources/scans/:serviceId", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    const service = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(serviceId);
    if (!service) throw new Error("Service not found");
    const scan = getLatestScan(ctx, serviceId);
    if (!scan) throw new Error("No dependency scan recorded for this service");
    return scan;
  });

  ctx.app.post("/resources/scans/:serviceId/run", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    return runDependencyScan(ctx, serviceId);
  });

  ctx.app.get("/resources", async () => {
    return listResources(ctx).map((resource) => serializeResource(ctx, resource));
  });

  ctx.app.get("/resources/:id", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    return serializeResource(ctx, resource);
  });

  /**
   * Provision a resource for a service through its profile. Long-running
   * (supabase start can pull images) and awaited like the deploy routes;
   * progress streams over WS as resource_provisioning / resource_status
   * events. User-supplied secrets are stored encrypted with
   * is_generated=false; disabled keys land in config_json.disabled_secrets.
   */
  ctx.app.post("/resources/provision", async (req) => {
    const p = provisionSchema.parse(req.body);
    const service = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(p.serviceId);
    if (!service) throw new Error("Service not found");
    const profile = getProfile(p.profile);
    if (!profile) throw new Error(`Unknown resource profile: ${p.profile}`);
    const resource = await profile.provision(ctx, {
      serviceId: p.serviceId,
      mode: p.mode,
      restart: p.restart,
      name: p.name,
      secrets: p.secrets,
      disabledSecrets: p.disabledSecrets,
      serveFunctions: p.serveFunctions,
      config: p.config
    });
    refreshPublicResourceIngress(ctx);
    return serializeResource(ctx, resource);
  });

  for (const action of ["start", "stop", "restart"] as const) {
    ctx.app.post(`/resources/:id/${action}`, async (req) => {
      const resource = getResource(ctx, (req.params as { id: string }).id);
      if (!resource) throw new Error("Resource not found");
      await runResourceAction(ctx, resource, action);
      return { ok: true, resource: serializeResource(ctx, getResource(ctx, resource.id)!) };
    });
  }

  /**
   * Remove a resource via its profile. Mirrors the /databases removal
   * semantics: actively linked services are warned (notification + log) —
   * their injected env will point at a backend that no longer exists — but
   * removal proceeds so the operator can re-provision deliberately.
   */
  ctx.app.delete("/resources/:id", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    const links = listLinksForResource(ctx, resource.id);
    for (const link of links) {
      const svc = ctx.db.prepare("SELECT id, name FROM services WHERE id = ?").get(link.service_id) as
        | { id: string; name: string }
        | undefined;
      if (!svc) continue;
      ctx.app.log?.warn?.(
        { serviceId: svc.id, serviceName: svc.name, resourceId: resource.id, resourceName: resource.name },
        "linked_resource_removed: service env now points to a removed resource"
      );
      createNotification(ctx, {
        kind: "system",
        severity: "warning",
        title: `Resource removed for service "${svc.name}"`,
        body: `Resource "${resource.name}" (${resource.profile}) was removed while service "${svc.name}" was linked to it. Its injected env now points at a backend that no longer exists — re-provision or re-link before the next deploy. Generated local data is gone.`,
        serviceId: svc.id
      });
    }
    const profile = getProfile(resource.profile);
    if (!profile) throw new Error(`Unknown resource profile: ${resource.profile}`);
    await profile.remove(ctx, resource.id);
    refreshPublicResourceIngress(ctx);
    broadcast(ctx, {
      type: "resource_status",
      resourceId: resource.id,
      status: "removed",
      profile: resource.profile
    });
    return { ok: true, strandedServices: links.length };
  });

  /**
   * Combined logs: docker logs for every container in containers_json plus
   * the captured `supabase functions serve` output as a `=== functions ===`
   * section. `?source=containers|functions|all` (default all) narrows the view.
   */
  ctx.app.get("/resources/:id/logs", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    const query = req.query as { tail?: string; source?: string };
    const tailRaw = Number(query.tail ?? 500);
    const tail = Math.min(Math.max(Number.isFinite(tailRaw) ? tailRaw : 500, 50), 5000);
    const source = query.source === "containers" || query.source === "functions" ? query.source : "all";

    const sections: string[] = [];
    if (source !== "functions") {
      const containers = parseJson<string[]>(resource.containers_json, []);
      for (const name of containers) {
        try {
          const stream = (await ctx.docker.getContainer(name).logs({
            stdout: true,
            stderr: true,
            tail,
            timestamps: true,
            follow: false
          })) as unknown as Buffer;
          sections.push(`=== ${name} ===\n${stream.toString("utf8")}`);
        } catch (error) {
          sections.push(`=== ${name} ===\nFailed to read logs: ${serializeError(error)}`);
        }
      }
    }
    if (source !== "containers") {
      const functionLogs = getFunctionsLogs(resource.id, tail);
      if (functionLogs) sections.push(`=== functions ===\n${functionLogs}`);
    }
    if (sections.length === 0) {
      return {
        logs:
          source === "functions"
            ? "No function logs recorded for this resource."
            : "No containers recorded for this resource."
      };
    }
    return { logs: sections.join("\n\n") };
  });

  /**
   * Per-function and aggregate secret states (Phase 4). Drives the secret
   * classification UI: generated / provided / missing-optional / disabled /
   * missing-required, with the files referencing each key.
   */
  ctx.app.get("/resources/:id/env-requirements", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    return envRequirementsView(ctx, resource);
  });

  /**
   * Update resource secrets and the local disable list. User values are
   * stored encrypted (is_generated=false); the function env file is rewritten
   * and a live serve process is restarted so changes take effect immediately.
   * The response carries previews + requirement states only — never raw values.
   */
  ctx.app.post("/resources/:id/secrets", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    const p = secretsUpdateSchema.parse(req.body);

    for (const [key, value] of Object.entries(p.secrets ?? {})) {
      setResourceSecret(ctx, resource.id, key, value, false);
    }

    if (p.disable?.length || p.enable?.length) {
      const config = resourceConfig(resource);
      const disabled = new Set(
        (Array.isArray(config.disabled_secrets) ? config.disabled_secrets : []).filter(
          (key): key is string => typeof key === "string"
        )
      );
      for (const key of p.disable ?? []) disabled.add(key);
      for (const key of p.enable ?? []) disabled.delete(key);
      updateResourceRuntimeState(ctx, resource.id, {
        config: { ...config, disabled_secrets: Array.from(disabled).sort() }
      });
    }

    const updated = getResource(ctx, resource.id)!;
    if (updated.profile === "supabase") {
      // Keep the on-disk env file in sync; restart a live serve process so the
      // new values actually reach the functions (env files are read at start).
      try {
        writeFunctionEnvFile(ctx, updated.id);
      } catch {
        /* no stack info yet — file is rewritten on the next serve start */
      }
      if (isFunctionsServing(updated.id)) {
        await startFunctionsServe(ctx, updated);
      }
    }

    return {
      ok: true,
      secrets: listResourceSecrets(ctx, updated.id),
      requirements: envRequirementsView(ctx, getResource(ctx, updated.id)!)
    };
  });

  /**
   * Bootstrap plan (Phase 5): live DB introspection (role enums, profile/org
   * tables, bootstrap triggers) plus the ordered operation preview the wizard
   * shows before execution. 404 unknown resource, 400 non-supabase/not-ready/
   * non-local target, 502 when the local database is unreachable.
   */
  ctx.app.get("/resources/:id/bootstrap/plan", async (req) => {
    const id = (req.params as { id: string }).id;
    const { resource, apiUrl } = requireBootstrapResource(ctx, id);
    const schema = await introspectBootstrapSchema(ctx, id);
    return {
      resource_id: resource.id,
      resource_name: resource.name,
      // Spec safety: always show the target resource name and LOCAL url.
      api_url: apiUrl,
      schema,
      plan: buildBootstrapPlan(schema)
    };
  });

  /**
   * Execute the first-user/admin/org bootstrap (Phase 5). The password is
   * used only for the local Auth admin API call: it is never stored, never
   * broadcast, never echoed in the response, and the audit hook records only
   * method + path (no bodies), so it cannot reach audit logs either.
   */
  ctx.app.post("/resources/:id/bootstrap", async (req) => {
    const id = (req.params as { id: string }).id;
    requireBootstrapResource(ctx, id);
    const body = bootstrapSchema.parse(req.body) as BootstrapRequest;
    return executeBootstrap(ctx, id, body);
  });

  /** Link (or re-link) a resource to a service so env injection activates. */
  ctx.app.post("/resources/:id/link", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    const p = linkSchema.parse(req.body);
    const service = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(p.serviceId);
    if (!service) throw new Error("Service not found");
    const link = linkResourceToService(ctx, {
      serviceId: p.serviceId,
      resourceId: resource.id,
      envMap: p.envMap
    });
    refreshPublicResourceIngress(ctx);
    return { ok: true, link: serializeLink(link) };
  });

  /** Deactivate a service link; env injection stops immediately. */
  ctx.app.post("/resources/:id/unlink", async (req) => {
    const resource = getResource(ctx, (req.params as { id: string }).id);
    if (!resource) throw new Error("Resource not found");
    const p = unlinkSchema.parse(req.body);
    unlinkResource(ctx, p.serviceId, resource.id);
    refreshPublicResourceIngress(ctx);
    return { ok: true };
  });
}
