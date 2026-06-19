import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security.js";

type ServiceRow = {
  id: string;
  name: string;
  status: string;
  project_id: string | null;
};

type ProjectRow = {
  id: string;
  name: string;
};

type EnvSecretRow = {
  id: string;
  key: string;
  value: string;
  is_secret: number;
  system?: number;
  service_id?: string;
  service_name?: string;
  service_status?: string;
  project_id?: string | null;
  project_name?: string | null;
};

const serviceSecretSchema = z.object({
  serviceId: z.string().min(1),
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name"),
  value: z.string().min(1)
});

const sharedSecretSchema = z.object({
  projectId: z.string().min(1),
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name"),
  value: z.string().min(1)
});

const promoteSchema = z.object({
  serviceEnvId: z.string().min(1),
  projectId: z.string().optional()
});

function serviceLink(service: Pick<ServiceRow, "id" | "name" | "status">) {
  return {
    id: service.id,
    name: service.name,
    status: service.status,
    needs_redeploy: true as const
  };
}

function servicesForProject(ctx: AppContext, projectId: string): ServiceRow[] {
  return ctx.db
    .prepare("SELECT id, name, status, project_id FROM services WHERE project_id = ? ORDER BY name ASC")
    .all(projectId) as ServiceRow[];
}

function projectById(ctx: AppContext, projectId: string): ProjectRow {
  const project = ctx.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as
    | ProjectRow
    | undefined;
  if (!project) throw new Error("Project not found");
  return project;
}

function serviceById(ctx: AppContext, serviceId: string): ServiceRow {
  const service = ctx.db
    .prepare("SELECT id, name, status, project_id FROM services WHERE id = ?")
    .get(serviceId) as ServiceRow | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

function serviceSecretItem(ctx: AppContext, row: EnvSecretRow) {
  const value = decryptSecret(row.value, ctx.config.secretKey);
  return {
    id: row.id,
    key: row.key,
    scope: "service" as const,
    value_preview: maskSecret(value),
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    service_id: row.service_id ?? null,
    service_name: row.service_name ?? null,
    linked_services:
      row.service_id && row.service_name && row.service_status
        ? [serviceLink({ id: row.service_id, name: row.service_name, status: row.service_status })]
        : [],
    system: Boolean(row.system)
  };
}

function sharedSecretItem(ctx: AppContext, row: EnvSecretRow, linkedServices?: ServiceRow[]) {
  const value = decryptSecret(row.value, ctx.config.secretKey);
  const services = linkedServices ?? (row.project_id ? servicesForProject(ctx, row.project_id) : []);
  return {
    id: row.id,
    key: row.key,
    scope: "shared" as const,
    value_preview: maskSecret(value),
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    service_id: null,
    service_name: null,
    linked_services: services.map(serviceLink),
    system: false
  };
}

function getSharedSecretById(ctx: AppContext, id: string): EnvSecretRow {
  const row = ctx.db
    .prepare(
      `SELECT pev.id, pev.key, pev.value, pev.is_secret, pev.project_id, p.name AS project_name
       FROM project_env_vars pev
       LEFT JOIN projects p ON p.id = pev.project_id
       WHERE pev.id = ? AND pev.is_secret = 1`
    )
    .get(id) as EnvSecretRow | undefined;
  if (!row) throw new Error("Shared secret not found");
  return row;
}

function getServiceSecretById(ctx: AppContext, id: string): EnvSecretRow {
  const row = ctx.db
    .prepare(
      `SELECT ev.id, ev.key, ev.value, ev.is_secret, COALESCE(ev.system, 0) AS system,
              ev.service_id, s.name AS service_name, s.status AS service_status,
              s.project_id, p.name AS project_name
       FROM env_vars ev
       LEFT JOIN services s ON s.id = ev.service_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE ev.id = ? AND ev.is_secret = 1`
    )
    .get(id) as EnvSecretRow | undefined;
  if (!row) throw new Error("Service secret not found");
  return row;
}

export function registerSecretRoutes(ctx: AppContext): void {
  ctx.app.get("/secrets", async () => {
    const serviceRows = ctx.db
      .prepare(
        `SELECT ev.id, ev.key, ev.value, ev.is_secret, COALESCE(ev.system, 0) AS system,
                ev.service_id, s.name AS service_name, s.status AS service_status,
                s.project_id, p.name AS project_name
         FROM env_vars ev
         LEFT JOIN services s ON s.id = ev.service_id
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE ev.is_secret = 1
         ORDER BY ev.key ASC, s.name ASC`
      )
      .all() as EnvSecretRow[];
    const sharedRows = ctx.db
      .prepare(
        `SELECT pev.id, pev.key, pev.value, pev.is_secret, pev.project_id, p.name AS project_name
         FROM project_env_vars pev
         LEFT JOIN projects p ON p.id = pev.project_id
         WHERE pev.is_secret = 1
         ORDER BY pev.key ASC, p.name ASC`
      )
      .all() as EnvSecretRow[];
    return {
      secrets: [
        ...sharedRows.map((row) => sharedSecretItem(ctx, row)),
        ...serviceRows.map((row) => serviceSecretItem(ctx, row))
      ]
    };
  });

  ctx.app.post("/secrets/service", async (req) => {
    const body = serviceSecretSchema.parse(req.body);
    const service = serviceById(ctx, body.serviceId);
    const stored = encryptSecret(body.value, ctx.config.secretKey);
    const existing = ctx.db
      .prepare(
        "SELECT id, COALESCE(system, 0) AS system FROM env_vars WHERE service_id = ? AND key = ? ORDER BY COALESCE(system, 0) DESC LIMIT 1"
      )
      .get(body.serviceId, body.key) as { id: string; system: number } | undefined;
    if (existing?.system) {
      const err = new Error("This key is managed by ServerHoster. Add a different key or change the owning feature.");
      (err as Error & { statusCode?: number }).statusCode = 409;
      throw err;
    }
    const id = existing?.id ?? nanoid();
    if (existing) {
      ctx.db.prepare("UPDATE env_vars SET value = ?, is_secret = 1 WHERE id = ?").run(stored, existing.id);
    } else {
      ctx.db
        .prepare(
          "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES (?, ?, ?, ?, 1, 0)"
        )
        .run(id, body.serviceId, body.key, stored);
    }
    const row = getServiceSecretById(ctx, id);
    return {
      ok: true,
      secret: serviceSecretItem(ctx, row),
      affected_services: [serviceLink(service)],
      redeploy_required: true,
      message: "Secret saved. Redeploy or restart this service before the new value is live."
    };
  });

  ctx.app.post("/secrets/shared", async (req) => {
    const body = sharedSecretSchema.parse(req.body);
    const project = projectById(ctx, body.projectId);
    const stored = encryptSecret(body.value, ctx.config.secretKey);
    const existing = ctx.db
      .prepare("SELECT id FROM project_env_vars WHERE project_id = ? AND key = ? LIMIT 1")
      .get(body.projectId, body.key) as { id: string } | undefined;
    const id = existing?.id ?? nanoid();
    if (existing) {
      ctx.db
        .prepare("UPDATE project_env_vars SET value = ?, is_secret = 1 WHERE id = ?")
        .run(stored, existing.id);
    } else {
      ctx.db
        .prepare(
          "INSERT INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, 1)"
        )
        .run(id, body.projectId, body.key, stored);
    }
    const linked = servicesForProject(ctx, project.id);
    const row = getSharedSecretById(ctx, id);
    return {
      ok: true,
      secret: sharedSecretItem(ctx, row, linked),
      affected_services: linked.map(serviceLink),
      redeploy_required: true,
      message: "Shared secret saved. Redeploy or restart linked services before the new value is live."
    };
  });

  ctx.app.post("/secrets/promote", async (req) => {
    const body = promoteSchema.parse(req.body);
    const source = getServiceSecretById(ctx, body.serviceEnvId);
    if (!source.service_id) throw new Error("Service secret not found");
    const service = serviceById(ctx, source.service_id);
    const projectId = body.projectId ?? service.project_id;
    if (!projectId) throw new Error("Service has no project for shared secrets");
    const value = decryptSecret(source.value, ctx.config.secretKey);
    const stored = encryptSecret(value, ctx.config.secretKey);
    const existing = ctx.db
      .prepare("SELECT id FROM project_env_vars WHERE project_id = ? AND key = ? LIMIT 1")
      .get(projectId, source.key) as { id: string } | undefined;
    const id = existing?.id ?? nanoid();
    if (existing) {
      ctx.db
        .prepare("UPDATE project_env_vars SET value = ?, is_secret = 1 WHERE id = ?")
        .run(stored, existing.id);
    } else {
      ctx.db
        .prepare(
          "INSERT INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, 1)"
        )
        .run(id, projectId, source.key, stored);
    }
    const linked = servicesForProject(ctx, projectId);
    const row = getSharedSecretById(ctx, id);
    return {
      ok: true,
      secret: sharedSecretItem(ctx, row, linked),
      affected_services: linked.map(serviceLink),
      redeploy_required: true,
      message:
        "Secret copied to shared scope. Redeploy or restart linked services; remove service overrides when you want the shared value to win."
    };
  });

  ctx.app.delete("/secrets/service/:id", async (req) => {
    const { id } = req.params as { id: string };
    const row = getServiceSecretById(ctx, id);
    if (row.system) throw new Error("System-managed secrets cannot be deleted here");
    ctx.db.prepare("DELETE FROM env_vars WHERE id = ? AND COALESCE(system, 0) = 0").run(id);
    const affected =
      row.service_id && row.service_name && row.service_status
        ? [serviceLink({ id: row.service_id, name: row.service_name, status: row.service_status })]
        : [];
    return {
      ok: true,
      affected_services: affected,
      redeploy_required: true,
      message: "Secret deleted. Redeploy or restart affected services before the deletion is live."
    };
  });

  ctx.app.delete("/secrets/shared/:id", async (req) => {
    const { id } = req.params as { id: string };
    const row = getSharedSecretById(ctx, id);
    const linked = row.project_id ? servicesForProject(ctx, row.project_id) : [];
    ctx.db.prepare("DELETE FROM project_env_vars WHERE id = ?").run(id);
    return {
      ok: true,
      affected_services: linked.map(serviceLink),
      redeploy_required: true,
      message: "Shared secret deleted. Redeploy or restart linked services before the deletion is live."
    };
  });
}
