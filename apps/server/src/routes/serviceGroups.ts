import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso, serializeError } from "../lib/core.js";
import { restartService, startService, stopService } from "../services/runtime.js";

type ServiceGroupRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

type ServiceSummaryRow = {
  id: string;
  project_id: string;
  name: string;
  type: string;
  command: string | null;
  working_dir: string | null;
  docker_image: string | null;
  dockerfile: string | null;
  port: number | null;
  status: string;
  auto_restart: number;
  restart_count: number;
  max_restarts: number;
  stop_with_hoster: number;
  created_at: string;
  updated_at: string;
  healthcheck_path?: string | null;
  start_mode?: string | null;
  last_exit_code?: number | null;
  last_started_at?: string | null;
  last_stopped_at?: string | null;
  github_repo_url?: string | null;
  github_branch?: string | null;
  github_auto_pull?: number | null;
  ssl_status?: string | null;
  linked_database_id?: string | null;
  depends_on?: string | null;
  environment?: string | null;
  compose_service_name?: string | null;
  compose_file_hash?: string | null;
  tunnel_url?: string | null;
  quick_tunnel_enabled?: number | null;
  last_attempted_commit?: string | null;
  runtime_pgid?: number | null;
  serve_built_dist?: number | null;
  persisted_paths_config?: string | null;
};

type ServiceGroupDetail = ServiceGroupRow & {
  service_ids: string[];
  services: ServiceSummaryRow[];
};

const serviceGroupSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  serviceIds: z.array(z.string().min(1)).default([])
});

const serviceGroupUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  serviceIds: z.array(z.string().min(1)).optional()
});

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function servicePlaceholders(ids: string[]): string {
  return ids.map(() => "?").join(", ");
}

function validateServiceIds(ctx: AppContext, serviceIds: string[]): string[] {
  const ids = uniqueIds(serviceIds);
  if (ids.length === 0) return [];
  const rows = ctx.db
    .prepare(`SELECT id FROM services WHERE id IN (${servicePlaceholders(ids)})`)
    .all(...ids) as Array<{ id: string }>;
  if (rows.length !== ids.length) {
    throw httpError(400, "One or more selected services do not exist");
  }
  return ids;
}

function listGroupServices(ctx: AppContext, groupId: string): ServiceSummaryRow[] {
  return ctx.db
    .prepare(
      `SELECT s.*
       FROM service_group_members m
       JOIN services s ON s.id = m.service_id
       WHERE m.group_id = ?
       ORDER BY lower(s.name) ASC`
    )
    .all(groupId) as ServiceSummaryRow[];
}

function groupDetail(ctx: AppContext, group: ServiceGroupRow): ServiceGroupDetail {
  const services = listGroupServices(ctx, group.id);
  return {
    ...group,
    description: group.description ?? "",
    service_ids: services.map((service) => service.id),
    services
  };
}

function getGroup(ctx: AppContext, id: string): ServiceGroupRow {
  const row = ctx.db.prepare("SELECT * FROM service_groups WHERE id = ?").get(id) as
    | ServiceGroupRow
    | undefined;
  if (!row) throw httpError(404, "Service group not found");
  return row;
}

function replaceGroupMembers(ctx: AppContext, groupId: string, serviceIds: string[]): void {
  const createdAt = nowIso();
  const insert = ctx.db.prepare(
    "INSERT INTO service_group_members (group_id, service_id, created_at) VALUES (?, ?, ?)"
  );
  ctx.db.prepare("DELETE FROM service_group_members WHERE group_id = ?").run(groupId);
  for (const serviceId of serviceIds) {
    insert.run(groupId, serviceId, createdAt);
  }
}

async function runGroupAction(
  ctx: AppContext,
  groupId: string,
  action: (serviceId: string) => Promise<void>
): Promise<{ results: Array<{ serviceId: string; ok: boolean; error?: string }> }> {
  getGroup(ctx, groupId);
  const rows = ctx.db
    .prepare(
      `SELECT service_id AS serviceId
       FROM service_group_members
       WHERE group_id = ?
       ORDER BY created_at ASC`
    )
    .all(groupId) as Array<{ serviceId: string }>;
  const results: Array<{ serviceId: string; ok: boolean; error?: string }> = [];
  for (const row of rows) {
    try {
      await action(row.serviceId);
      results.push({ serviceId: row.serviceId, ok: true });
    } catch (error) {
      results.push({ serviceId: row.serviceId, ok: false, error: serializeError(error) });
    }
  }
  return { results };
}

export function registerServiceGroupRoutes(ctx: AppContext): void {
  ctx.app.get("/service-groups", async () => {
    const rows = ctx.db
      .prepare("SELECT * FROM service_groups ORDER BY created_at DESC")
      .all() as ServiceGroupRow[];
    return rows.map((row) => groupDetail(ctx, row));
  });

  ctx.app.post("/service-groups", async (req) => {
    const parsed = serviceGroupSchema.parse(req.body);
    const serviceIds = validateServiceIds(ctx, parsed.serviceIds);
    const now = nowIso();
    const group: ServiceGroupRow = {
      id: nanoid(),
      name: parsed.name,
      description: parsed.description ?? "",
      created_at: now,
      updated_at: now
    };
    const create = ctx.db.transaction(() => {
      ctx.db
        .prepare(
          "INSERT INTO service_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(group.id, group.name, group.description, group.created_at, group.updated_at);
      replaceGroupMembers(ctx, group.id, serviceIds);
    });
    create();
    return groupDetail(ctx, group);
  });

  ctx.app.put("/service-groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    const existing = getGroup(ctx, id);
    const parsed = serviceGroupUpdateSchema.parse(req.body);
    const serviceIds = parsed.serviceIds ? validateServiceIds(ctx, parsed.serviceIds) : null;
    const updated: ServiceGroupRow = {
      ...existing,
      name: parsed.name ?? existing.name,
      description: parsed.description ?? existing.description ?? "",
      updated_at: nowIso()
    };
    const update = ctx.db.transaction(() => {
      ctx.db
        .prepare("UPDATE service_groups SET name = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(updated.name, updated.description, updated.updated_at, id);
      if (serviceIds) replaceGroupMembers(ctx, id, serviceIds);
    });
    update();
    return groupDetail(ctx, updated);
  });

  ctx.app.delete("/service-groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    getGroup(ctx, id);
    const remove = ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM service_group_members WHERE group_id = ?").run(id);
      ctx.db.prepare("DELETE FROM service_groups WHERE id = ?").run(id);
    });
    remove();
    return { ok: true };
  });

  ctx.app.post("/service-groups/:id/start-all", async (req) =>
    runGroupAction(ctx, (req.params as { id: string }).id, (serviceId) => startService(ctx, serviceId))
  );
  ctx.app.post("/service-groups/:id/stop-all", async (req) =>
    runGroupAction(ctx, (req.params as { id: string }).id, (serviceId) => stopService(ctx, serviceId))
  );
  ctx.app.post("/service-groups/:id/restart-all", async (req) =>
    runGroupAction(ctx, (req.params as { id: string }).id, (serviceId) => restartService(ctx, serviceId))
  );
}
