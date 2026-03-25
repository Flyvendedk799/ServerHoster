import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

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
  ctx.app.get("/projects", async () => ctx.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all());

  ctx.app.post("/projects", async (req) => {
    const p = projectSchema.parse(req.body);
    const row = { id: nanoid(), name: p.name, description: p.description ?? "", git_url: p.gitUrl ?? "", created_at: nowIso(), updated_at: nowIso() };
    ctx.db.prepare("INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.description, row.git_url, row.created_at, row.updated_at);
    return row;
  });

  ctx.app.put("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const p = projectUpdateSchema.parse(req.body);
    const existing = ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!existing) throw new Error("Project not found");
    const name = p.name ?? String(existing.name ?? "");
    const description = p.description ?? String(existing.description ?? "");
    const gitUrl = p.gitUrl ?? String(existing.git_url ?? "");
    ctx.db.prepare("UPDATE projects SET name = ?, description = ?, git_url = ?, updated_at = ? WHERE id = ?")
      .run(name, description, gitUrl, nowIso(), id);
    return { id, name, description, git_url: gitUrl };
  });

  ctx.app.delete("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    ctx.db.prepare("DELETE FROM env_vars WHERE service_id IN (SELECT id FROM services WHERE project_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM services WHERE project_id = ?").run(id);
    ctx.db.prepare("DELETE FROM databases WHERE project_id = ?").run(id);
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
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
    ctx.db.prepare("INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, projectName, `Generated from ${p.template}`, "", createdAt, createdAt);

    const serviceId = nanoid();
    const serviceRoot = path.join(ctx.config.projectsDir, serviceId);
    fs.mkdirSync(serviceRoot, { recursive: true });

    let command = "npm run dev";
    let type: "process" | "static" = "process";
    if (p.template === "python-api") command = "python app.py";
    if (p.template === "static-site") type = "static";

    ctx.db.prepare(`INSERT INTO services (
      id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
      auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serviceId, projectId, p.name, type, command, serviceRoot, "", "", null, "stopped",
      1, 0, 5, "manual", createdAt, createdAt
    );

    if (p.template === "node-api" || p.template === "static-site") {
      fs.writeFileSync(path.join(serviceRoot, "package.json"), JSON.stringify({
        name: p.name.toLowerCase().replace(/\s+/g, "-"),
        version: "1.0.0",
        scripts: { dev: "node index.js" }
      }, null, 2));
      fs.writeFileSync(path.join(serviceRoot, "index.js"), "console.log('SURVHub template service running');\n");
    } else {
      fs.writeFileSync(path.join(serviceRoot, "app.py"), "print('SURVHub python template service running')\n");
      fs.writeFileSync(path.join(serviceRoot, "requirements.txt"), "");
    }
    return { projectId, serviceId, serviceRoot };
  });
}
