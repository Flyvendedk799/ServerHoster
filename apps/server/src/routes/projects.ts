import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso, serializeError } from "../lib/core.js";
import { restartService, startService, stopService } from "../services/runtime.js";
import { deployFromGit, applyPostDeployServiceState, stopServiceIfRunning } from "../services/deploy.js";

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  gitUrl: z.string().url().optional()
});
const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  gitUrl: z.string().url().optional()
});

const templateCreateSchema = z.object({
  name: z.string().min(1),
  template: z.enum(["node-api", "python-api", "static-site"]),
  projectName: z.string().optional()
});

export function registerProjectRoutes(ctx: AppContext): void {
  ctx.app.get("/projects", async () =>
    ctx.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all()
  );

  ctx.app.post("/projects", async (req) => {
    const p = projectSchema.parse(req.body);
    const row = {
      id: nanoid(),
      name: p.name,
      description: p.description ?? "",
      git_url: p.gitUrl ?? "",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    ctx.db
      .prepare(
        "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(row.id, row.name, row.description, row.git_url, row.created_at, row.updated_at);
    return row;
  });

  ctx.app.put("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const p = projectUpdateSchema.parse(req.body);
    const existing = ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw new Error("Project not found");
    const name = p.name ?? String(existing.name ?? "");
    const description = p.description ?? String(existing.description ?? "");
    const gitUrl = p.gitUrl ?? String(existing.git_url ?? "");
    ctx.db
      .prepare("UPDATE projects SET name = ?, description = ?, git_url = ?, updated_at = ? WHERE id = ?")
      .run(name, description, gitUrl, nowIso(), id);
    return { id, name, description, git_url: gitUrl };
  });

  ctx.app.delete("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    ctx.db
      .prepare("DELETE FROM env_vars WHERE service_id IN (SELECT id FROM services WHERE project_id = ?)")
      .run(id);
    ctx.db.prepare("DELETE FROM services WHERE project_id = ?").run(id);
    ctx.db.prepare("DELETE FROM databases WHERE project_id = ?").run(id);
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return { ok: true };
  });

  // --- Project-level bulk actions (Phase 8.2) -------------------------------
  async function runProjectAction(
    ctx: AppContext,
    projectId: string,
    action: (serviceId: string) => Promise<void>
  ): Promise<{ results: Array<{ serviceId: string; ok: boolean; error?: string }> }> {
    const rows = ctx.db.prepare("SELECT id FROM services WHERE project_id = ?").all(projectId) as Array<{
      id: string;
    }>;
    const results: Array<{ serviceId: string; ok: boolean; error?: string }> = [];
    for (const row of rows) {
      try {
        await action(row.id);
        results.push({ serviceId: row.id, ok: true });
      } catch (error) {
        results.push({ serviceId: row.id, ok: false, error: serializeError(error) });
      }
    }
    return { results };
  }

  ctx.app.post("/projects/:id/start-all", async (req) =>
    runProjectAction(ctx, (req.params as { id: string }).id, (sid) => startService(ctx, sid))
  );
  ctx.app.post("/projects/:id/stop-all", async (req) =>
    runProjectAction(ctx, (req.params as { id: string }).id, (sid) => stopService(ctx, sid))
  );
  ctx.app.post("/projects/:id/restart-all", async (req) =>
    runProjectAction(ctx, (req.params as { id: string }).id, (sid) => restartService(ctx, sid))
  );
  ctx.app.post("/projects/:id/deploy-all", async (req) => {
    const { id } = req.params as { id: string };
    const rows = ctx.db
      .prepare(
        "SELECT id, github_repo_url, github_branch FROM services WHERE project_id = ? AND github_repo_url IS NOT NULL"
      )
      .all(id) as Array<{ id: string; github_repo_url: string; github_branch?: string }>;
    const results: Array<{ serviceId: string; ok: boolean; status?: string; error?: string }> = [];
    for (const r of rows) {
      try {
        await stopServiceIfRunning(ctx, r.id);
        const deployment = await deployFromGit(
          ctx,
          r.id,
          r.github_repo_url,
          r.github_branch || "main",
          "manual"
        );
        await applyPostDeployServiceState(ctx, r.id, deployment, { startAfterDeploy: true });
        results.push({ serviceId: r.id, ok: deployment.status === "success", status: deployment.status });
      } catch (error) {
        results.push({ serviceId: r.id, ok: false, error: serializeError(error) });
      }
    }
    return { results };
  });

  // --- Project env vars (inherited by all services in the project) ---------
  ctx.app.get("/projects/:id/env", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.db
      .prepare("SELECT id, key, value, is_secret FROM project_env_vars WHERE project_id = ? ORDER BY key ASC")
      .all(id);
  });

  ctx.app.post("/projects/:id/env", async (req) => {
    const { id } = req.params as { id: string };
    const p = z
      .object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().default(false) })
      .parse(req.body);
    const rowId = nanoid();
    ctx.db
      .prepare(
        "INSERT INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret"
      )
      .run(rowId, id, p.key, p.value, p.isSecret ? 1 : 0);
    return { ok: true };
  });

  ctx.app.delete("/projects/:id/env/:key", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    ctx.db.prepare("DELETE FROM project_env_vars WHERE project_id = ? AND key = ?").run(id, key);
    return { ok: true };
  });

  ctx.app.get("/project-templates", async () => ({
    templates: [
      { id: "node-api", name: "Node API", serviceType: "process", command: "npm run dev" },
      { id: "python-api", name: "Python API", serviceType: "process", command: "python app.py" },
      { id: "static-site", name: "Static Site", serviceType: "static", command: "npm run dev" }
    ]
  }));

  ctx.app.post("/projects/from-template", async (req) => {
    const p = templateCreateSchema.parse(req.body);
    const projectId = nanoid();
    const createdAt = nowIso();
    const projectName = p.projectName?.trim() || `${p.name} project`;
    ctx.db
      .prepare(
        "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(projectId, projectName, `Generated from ${p.template}`, "", createdAt, createdAt);

    const serviceId = nanoid();
    const serviceRoot = path.join(ctx.config.projectsDir, serviceId);
    fs.mkdirSync(serviceRoot, { recursive: true });

    let command = "npm run dev";
    let type: "process" | "static" = "process";
    if (p.template === "python-api") command = "python app.py";
    if (p.template === "static-site") type = "static";

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
        p.name,
        type,
        command,
        serviceRoot,
        "",
        "",
        null,
        "stopped",
        1,
        0,
        5,
        "manual",
        createdAt,
        createdAt
      );

    if (p.template === "node-api" || p.template === "static-site") {
      fs.writeFileSync(
        path.join(serviceRoot, "package.json"),
        JSON.stringify(
          {
            name: p.name.toLowerCase().replace(/\s+/g, "-"),
            version: "1.0.0",
            scripts: { dev: "node index.js" }
          },
          null,
          2
        )
      );
      fs.writeFileSync(
        path.join(serviceRoot, "index.js"),
        "console.log('SURVHub template service running');\n"
      );
    } else {
      fs.writeFileSync(
        path.join(serviceRoot, "app.py"),
        "print('SURVHub python template service running')\n"
      );
      fs.writeFileSync(path.join(serviceRoot, "requirements.txt"), "");
    }
    return { projectId, serviceId, serviceRoot };
  });
}
