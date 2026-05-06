import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

const railwayServiceSchema = z.object({
  name: z.string(),
  type: z.enum(["docker", "process", "static"]).default("docker"),
  image: z.string().optional(),
  command: z.string().optional(),
  port: z.number().int().optional()
});

const railwayProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  services: z.array(railwayServiceSchema).default([])
});

const railwayImportSchema = z.object({
  dryRun: z.boolean().default(true),
  projects: z.array(railwayProjectSchema)
});

const pythonAnywhereAppSchema = z.object({
  name: z.string(),
  entrypoint: z.string().default("python app.py"),
  workingDir: z.string().default(""),
  port: z.number().int().optional()
});

const pythonAnywhereImportSchema = z.object({
  dryRun: z.boolean().default(true),
  apps: z.array(pythonAnywhereAppSchema)
});

function insertService(
  ctx: AppContext,
  projectId: string,
  service: {
    name: string;
    type: "docker" | "process" | "static";
    image?: string;
    command?: string;
    port?: number;
    workingDir?: string;
  }
) {
  const serviceId = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services (
    id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
    auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      serviceId,
      projectId,
      service.name,
      service.type,
      service.command ?? "",
      service.workingDir ?? "",
      service.image ?? "",
      "",
      service.port ?? null,
      "stopped",
      1,
      0,
      5,
      "manual",
      nowIso(),
      nowIso()
    );
  return serviceId;
}

export function registerMigrationRoutes(ctx: AppContext): void {
  ctx.app.post("/migrations/railway/import", async (req) => {
    const parsed = railwayImportSchema.parse(req.body);
    if (parsed.dryRun) {
      return {
        dryRun: true,
        summary: parsed.projects.map((project) => ({
          project: project.name,
          services: project.services.length
        }))
      };
    }

    const imported: Array<{ projectId: string; serviceIds: string[] }> = [];
    for (const project of parsed.projects) {
      const projectId = nanoid();
      ctx.db
        .prepare(
          "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(projectId, project.name, project.description ?? "Imported from Railway", "", nowIso(), nowIso());

      const serviceIds: string[] = [];
      for (const service of project.services) {
        const serviceId = insertService(ctx, projectId, {
          name: service.name,
          type: service.type,
          image: service.image,
          command: service.command,
          port: service.port
        });
        serviceIds.push(serviceId);
      }
      imported.push({ projectId, serviceIds });
    }
    return { dryRun: false, imported };
  });

  ctx.app.post("/migrations/pythonanywhere/import", async (req) => {
    const parsed = pythonAnywhereImportSchema.parse(req.body);
    if (parsed.dryRun) {
      return {
        dryRun: true,
        summary: parsed.apps.map((app) => ({ app: app.name, entrypoint: app.entrypoint }))
      };
    }

    const projectId = nanoid();
    ctx.db
      .prepare(
        "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(projectId, "PythonAnywhere Migration", "Imported from PythonAnywhere", "", nowIso(), nowIso());

    const serviceIds: string[] = [];
    for (const appDef of parsed.apps) {
      const serviceId = insertService(ctx, projectId, {
        name: appDef.name,
        type: "process",
        command: appDef.entrypoint,
        port: appDef.port,
        workingDir: appDef.workingDir
      });
      serviceIds.push(serviceId);
    }
    return { dryRun: false, projectId, serviceIds };
  });
}
