import { nanoid } from "nanoid";
import type { AppContext } from "../../../types.js";
import {
  broadcast,
  dbReservedPorts,
  dockerUnavailableMessage,
  findFreePort,
  nowIso,
  serializeError
} from "../../../lib/core.js";
import {
  buildConnectionString,
  containerNameForDatabase,
  createManagedDatabase,
  getContainerStatus,
  getDatabase,
  removeDatabase
} from "../../databases.js";
import { scanForDatabaseDrivers } from "../../codeScan.js";
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
import { setResourceSecret } from "../secrets.js";
import {
  envFromResourceConfig,
  registerProfile,
  type DetectionSignal,
  type ProvisionInput,
  type ProvisionPlan,
  type ResourceProfile,
  type ResourceStatus
} from "../profiles.js";
import { restartOrRedeployService } from "../restart.js";

/**
 * Postgres profile (Database-Tracker Phases 2+3).
 *
 * Detection wraps the existing manifest driver scan so dependency scans can
 * recommend Postgres for pg/Prisma/Drizzle apps.
 *
 * Provisioning (Phase 3) goes through the SAME primitive as POST /databases
 * and the embedded-SQLite promote flow (`createManagedDatabase`), so a
 * resource-provisioned Postgres is a first-class legacy database too: it
 * writes the `databases` row, points `services.linked_database_id` at it, and
 * records a `managed_resources` row carrying `config_json.database_id`. All
 * existing /databases/* management (backups, logs, transfer, browser) keeps
 * working on it unchanged.
 */

/** Driver labels from scanForDatabaseDrivers that indicate a Postgres app. */
const POSTGRES_DRIVERS = new Set(["PostgreSQL", "Prisma", "Drizzle ORM"]);

/** Port window shared with the embedded-SQLite promote flow. */
const POSTGRES_PORT_RANGE: [number, number] = [54320, 54420];

function detectPostgresSignals(servicePath: string): DetectionSignal[] {
  return scanForDatabaseDrivers(servicePath)
    .filter((signal) => POSTGRES_DRIVERS.has(signal.driver))
    .map((signal) => ({
      kind: "package" as const,
      value: signal.driver,
      source_file: signal.source_file,
      // A direct driver is near-certain; an ORM alone could target another DB.
      confidence: signal.driver === "PostgreSQL" ? ("high" as const) : ("medium" as const)
    }));
}

function highestConfidence(signals: DetectionSignal[]): "high" | "medium" | "low" {
  if (signals.some((signal) => signal.confidence === "high")) return "high";
  if (signals.some((signal) => signal.confidence === "medium")) return "medium";
  return "low";
}

type ServiceRow = {
  id: string;
  project_id: string | null;
  name: string;
  working_dir: string | null;
};

function getServiceRow(ctx: AppContext, serviceId: string): ServiceRow {
  const service = ctx.db
    .prepare("SELECT id, project_id, name, working_dir FROM services WHERE id = ?")
    .get(serviceId) as ServiceRow | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

/** The legacy databases row backing this resource (config_json.database_id). */
function legacyDatabaseFor(ctx: AppContext, resource: ManagedResourceRow) {
  const config = resourceConfig(resource);
  const databaseId = typeof config.database_id === "string" ? config.database_id : null;
  return databaseId ? getDatabase(ctx, databaseId) : null;
}

async function provisionPostgres(ctx: AppContext, input: ProvisionInput): Promise<ManagedResourceRow> {
  const service = getServiceRow(ctx, input.serviceId);
  const resource = createResource(ctx, {
    projectId: input.projectId ?? service.project_id,
    name: input.name ?? `${service.name}-db`,
    profile: "postgres",
    status: "provisioning",
    config: { ...(input.config ?? {}) }
  });
  broadcast(ctx, {
    type: "resource_status",
    resourceId: resource.id,
    status: "provisioning",
    profile: "postgres"
  });

  try {
    try {
      await ctx.docker.ping();
    } catch (error) {
      throw new Error(dockerUnavailableMessage(error) ?? `Docker is not reachable: ${serializeError(error)}`);
    }

    const port = await findFreePort(POSTGRES_PORT_RANGE[0], POSTGRES_PORT_RANGE[1], dbReservedPorts(ctx));
    const databaseName = service.name.replace(/[^a-zA-Z0-9_]/g, "_") || "appdb";
    const db = await createManagedDatabase(ctx, {
      projectId: input.projectId ?? service.project_id ?? "",
      name: input.name ?? `${service.name}-db`,
      engine: "postgres",
      port,
      username: "postgres",
      password: nanoid(16),
      databaseName
    });

    // Legacy compatibility: the service keeps its DATABASE_URL injection path.
    ctx.db
      .prepare("UPDATE services SET linked_database_id = ?, updated_at = ? WHERE id = ?")
      .run(db.id, nowIso(), service.id);

    updateResourceRuntimeState(ctx, resource.id, {
      config: { ...resourceConfig(getResource(ctx, resource.id)!), database_id: db.id },
      ports: { postgres: port },
      containers: [containerNameForDatabase(db)]
    });
    // Encrypted copy of the connection string (the legacy row keeps its own
    // plaintext columns — unchanged existing behavior).
    setResourceSecret(ctx, resource.id, "DATABASE_URL", buildConnectionString(db), true);

    linkResourceToService(ctx, { serviceId: service.id, resourceId: resource.id });

    if (input.restart !== false) {
      try {
        await restartOrRedeployService(ctx, service.id);
      } catch (error) {
        broadcast(ctx, {
          type: "resource_provisioning",
          resourceId: resource.id,
          step: "restart",
          message: `Service restart failed (database is up): ${serializeError(error)}`
        });
      }
    }

    updateResourceStatus(ctx, resource.id, "ready");
    broadcast(ctx, {
      type: "resource_status",
      resourceId: resource.id,
      status: "ready",
      profile: "postgres"
    });
    return getResource(ctx, resource.id)!;
  } catch (error) {
    const failed = getResource(ctx, resource.id);
    if (failed) {
      updateResourceRuntimeState(ctx, resource.id, {
        config: { ...resourceConfig(failed), error: serializeError(error) }
      });
    }
    updateResourceStatus(ctx, resource.id, "failed");
    broadcast(ctx, {
      type: "resource_status",
      resourceId: resource.id,
      status: "failed",
      profile: "postgres"
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export const postgresProfile: ResourceProfile = {
  id: "postgres",
  label: "PostgreSQL",
  detect(servicePath: string): DetectionSignal[] {
    return detectPostgresSignals(servicePath);
  },
  async plan(ctx: AppContext, serviceId): Promise<ProvisionPlan> {
    const service = ctx.db
      .prepare("SELECT id, project_id, working_dir FROM services WHERE id = ?")
      .get(serviceId) as { id: string; project_id: string | null; working_dir: string | null } | undefined;
    if (!service) throw new Error("Service not found");
    const signals = detectPostgresSignals(service.working_dir ?? "");
    return {
      profile: "postgres",
      service_id: serviceId,
      project_id: service.project_id,
      confidence: signals.length > 0 ? highestConfidence(signals) : "low",
      signals,
      actions: [
        {
          id: "create-postgres",
          label: "Create managed Postgres and inject DATABASE_URL",
          risk: "safe",
          default_enabled: true
        }
      ],
      env: { generated: ["DATABASE_URL"], required_user_input: [], optional_user_input: [], injected: [] }
    };
  },
  async provision(ctx, input): Promise<ManagedResourceRow> {
    return provisionPostgres(ctx, input);
  },
  async status(ctx, resourceId): Promise<ResourceStatus> {
    const resource = getResource(ctx, resourceId);
    if (!resource) return "error";
    const db = legacyDatabaseFor(ctx, resource);
    if (!db) return (resource.status as ResourceStatus) ?? "error";
    try {
      const { state } = await getContainerStatus(ctx, db);
      if (state === "running") return "running";
      if (state === "not-found") return "error";
      return "stopped";
    } catch {
      return (resource.status as ResourceStatus) ?? "error";
    }
  },
  /** SYNC: DATABASE_URL resolved from the legacy databases row (local DB only). */
  env(ctx, resourceId): Record<string, string> {
    const resource = getResource(ctx, resourceId);
    if (!resource) return {};
    const env = envFromResourceConfig(resource);
    const db = legacyDatabaseFor(ctx, resource);
    if (db) env.DATABASE_URL = buildConnectionString(db);
    return env;
  },
  async remove(ctx, resourceId): Promise<void> {
    const resource = getResource(ctx, resourceId);
    if (!resource) return;
    const db = legacyDatabaseFor(ctx, resource);
    if (db) {
      // Shared removal path: drops the container+volume row and warns services
      // whose linked_database_id pointed at it (same semantics as /databases).
      await removeDatabase(ctx, db);
    }
    for (const link of listLinksForResource(ctx, resourceId)) {
      unlinkResource(ctx, link.service_id, resourceId);
    }
    deleteResource(ctx, resourceId);
  }
};

registerProfile(postgresProfile);
