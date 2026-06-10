import { nanoid } from "nanoid";
import { nowIso } from "../../lib/core.js";
import type { AppContext } from "../../types.js";

/**
 * CRUD helpers for the generic resource layer (Database-Tracker Phase 1).
 *
 * `managed_resources` rows describe provisioned local dependencies (Postgres,
 * Supabase stacks, Redis, …) owned by a resource profile;
 * `service_resource_links` rows attach a resource to a service so its env can
 * be injected at build/runtime. The legacy `databases` table and
 * `services.linked_database_id` are intentionally left untouched.
 */

export type ResourceProfileId = "postgres" | "supabase" | "redis" | "mysql" | "mongo" | "manual";

export type ResourceStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "stopped"
  | "degraded"
  | "failed"
  | "error";

export type ManagedResourceRow = {
  id: string;
  project_id: string | null;
  name: string;
  profile: string;
  status: string;
  config_json: string;
  ports_json: string;
  containers_json: string;
  created_at: string;
  updated_at: string;
};

export type ServiceResourceLinkRow = {
  id: string;
  service_id: string;
  resource_id: string;
  active: number;
  env_map_json: string;
  created_at: string;
  updated_at: string;
};

export type CreateResourceInput = {
  projectId?: string | null;
  name: string;
  profile: ResourceProfileId | string;
  status?: ResourceStatus | string;
  config?: Record<string, unknown>;
  ports?: Record<string, number>;
  containers?: string[];
};

export function createResource(ctx: AppContext, input: CreateResourceInput): ManagedResourceRow {
  const id = nanoid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO managed_resources
       (id, project_id, name, profile, status, config_json, ports_json, containers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.projectId ?? null,
      input.name,
      input.profile,
      input.status ?? "provisioning",
      JSON.stringify(input.config ?? {}),
      JSON.stringify(input.ports ?? {}),
      JSON.stringify(input.containers ?? []),
      now,
      now
    );
  return getResource(ctx, id)!;
}

export function getResource(ctx: AppContext, id: string): ManagedResourceRow | null {
  return (
    (ctx.db.prepare("SELECT * FROM managed_resources WHERE id = ?").get(id) as
      | ManagedResourceRow
      | undefined) ?? null
  );
}

export function listResources(ctx: AppContext, projectId?: string): ManagedResourceRow[] {
  if (projectId) {
    return ctx.db
      .prepare("SELECT * FROM managed_resources WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as ManagedResourceRow[];
  }
  return ctx.db.prepare("SELECT * FROM managed_resources ORDER BY created_at").all() as ManagedResourceRow[];
}

export function updateResourceStatus(ctx: AppContext, id: string, status: ResourceStatus | string): void {
  ctx.db
    .prepare("UPDATE managed_resources SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), id);
}

/** Patch a resource's runtime state (config/ports/containers) after provisioning steps. */
export function updateResourceRuntimeState(
  ctx: AppContext,
  id: string,
  patch: {
    config?: Record<string, unknown>;
    ports?: Record<string, number>;
    containers?: string[];
  }
): void {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [nowIso()];
  if (patch.config !== undefined) {
    sets.push("config_json = ?");
    params.push(JSON.stringify(patch.config));
  }
  if (patch.ports !== undefined) {
    sets.push("ports_json = ?");
    params.push(JSON.stringify(patch.ports));
  }
  if (patch.containers !== undefined) {
    sets.push("containers_json = ?");
    params.push(JSON.stringify(patch.containers));
  }
  params.push(id);
  ctx.db.prepare(`UPDATE managed_resources SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/** Removes the resource row plus its secrets and service links. */
export function deleteResource(ctx: AppContext, id: string): void {
  ctx.db.prepare("DELETE FROM resource_secrets WHERE resource_id = ?").run(id);
  ctx.db.prepare("DELETE FROM service_resource_links WHERE resource_id = ?").run(id);
  ctx.db.prepare("DELETE FROM managed_resources WHERE id = ?").run(id);
}

export type LinkResourceInput = {
  serviceId: string;
  resourceId: string;
  /** Optional per-link env overrides applied on top of the profile's env(). */
  envMap?: Record<string, string>;
};

/**
 * Link a resource to a service (upsert). Re-linking an existing pair
 * reactivates it and replaces its env map.
 */
export function linkResourceToService(ctx: AppContext, input: LinkResourceInput): ServiceResourceLinkRow {
  const existing = ctx.db
    .prepare("SELECT * FROM service_resource_links WHERE service_id = ? AND resource_id = ?")
    .get(input.serviceId, input.resourceId) as ServiceResourceLinkRow | undefined;
  const now = nowIso();
  if (existing) {
    ctx.db
      .prepare("UPDATE service_resource_links SET active = 1, env_map_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(input.envMap ?? JSON.parse(existing.env_map_json || "{}")), now, existing.id);
    return ctx.db
      .prepare("SELECT * FROM service_resource_links WHERE id = ?")
      .get(existing.id) as ServiceResourceLinkRow;
  }
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO service_resource_links
       (id, service_id, resource_id, active, env_map_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    )
    .run(id, input.serviceId, input.resourceId, JSON.stringify(input.envMap ?? {}), now, now);
  return ctx.db
    .prepare("SELECT * FROM service_resource_links WHERE id = ?")
    .get(id) as ServiceResourceLinkRow;
}

/** Deactivates the link (kept for history) so env injection stops immediately. */
export function unlinkResource(ctx: AppContext, serviceId: string, resourceId: string): void {
  ctx.db
    .prepare(
      "UPDATE service_resource_links SET active = 0, updated_at = ? WHERE service_id = ? AND resource_id = ?"
    )
    .run(nowIso(), serviceId, resourceId);
}

export function listLinksForService(
  ctx: AppContext,
  serviceId: string,
  activeOnly = true
): ServiceResourceLinkRow[] {
  const sql = activeOnly
    ? "SELECT * FROM service_resource_links WHERE service_id = ? AND active = 1 ORDER BY created_at, rowid"
    : "SELECT * FROM service_resource_links WHERE service_id = ? ORDER BY created_at, rowid";
  return ctx.db.prepare(sql).all(serviceId) as ServiceResourceLinkRow[];
}

export function listLinksForResource(
  ctx: AppContext,
  resourceId: string,
  activeOnly = true
): ServiceResourceLinkRow[] {
  const sql = activeOnly
    ? "SELECT * FROM service_resource_links WHERE resource_id = ? AND active = 1 ORDER BY created_at, rowid"
    : "SELECT * FROM service_resource_links WHERE resource_id = ? ORDER BY created_at, rowid";
  return ctx.db.prepare(sql).all(resourceId) as ServiceResourceLinkRow[];
}

/** Parse a resource row's config_json, tolerating corrupt JSON. */
export function resourceConfig(resource: ManagedResourceRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resource.config_json || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
