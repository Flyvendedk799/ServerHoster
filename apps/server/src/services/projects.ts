import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

type ProjectRow = {
  id: string;
  name: string;
  description?: string | null;
  git_url?: string | null;
};

const GENERIC_PROJECT_NAMES = new Set(["", "imported apps", "default project"]);

export function inferAppProjectName(serviceName: string): string {
  const cleaned = serviceName
    .replace(/\s*[-_:|/]\s*(api|backend|front-end|frontend|web|server|worker|client)$/i, "")
    .replace(/\s+(api|backend|front-end|frontend|web|server|worker|client)$/i, "")
    .replace(/[-_]+(api|backend|front-end|frontend|web|server|worker|client)$/i, "")
    .trim();
  return cleaned || serviceName.trim() || "App";
}

function slugifyProjectId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "app";
  return `app-${slug}`;
}

function findProjectByName(ctx: AppContext, name: string): ProjectRow | undefined {
  return ctx.db
    .prepare("SELECT id, name, description, git_url FROM projects WHERE lower(name) = lower(?) LIMIT 1")
    .get(name) as ProjectRow | undefined;
}

export function ensureAppProject(
  ctx: AppContext,
  serviceName: string,
  opts: { gitUrl?: string; description?: string } = {}
): ProjectRow {
  const appName = inferAppProjectName(serviceName);
  const existing = findProjectByName(ctx, appName);
  if (existing) return existing;

  const createdAt = nowIso();
  let id = slugifyProjectId(appName);
  const idExists = ctx.db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (idExists) id = nanoid();

  const row = {
    id,
    name: appName,
    description: opts.description ?? `Application workspace for ${appName}`,
    git_url: opts.gitUrl ?? "",
    created_at: createdAt,
    updated_at: createdAt
  };
  ctx.db
    .prepare(
      "INSERT INTO projects (id, name, description, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(row.id, row.name, row.description, row.git_url, row.created_at, row.updated_at);
  return row;
}

export function resolveServiceProjectId(
  ctx: AppContext,
  projectId: string | undefined,
  serviceName: string,
  opts: { gitUrl?: string } = {}
): string {
  if (projectId?.trim()) {
    const project = ctx.db
      .prepare("SELECT id, name FROM projects WHERE id = ?")
      .get(projectId) as { id: string; name: string } | undefined;
    if (project && !GENERIC_PROJECT_NAMES.has(project.name.trim().toLowerCase())) return project.id;
  }
  return ensureAppProject(ctx, serviceName, { gitUrl: opts.gitUrl }).id;
}

export function reconcileGenericAppProjects(ctx: AppContext): { movedServices: number; removedProjects: number } {
  const services = ctx.db
    .prepare(
      `SELECT s.id, s.name, s.project_id, s.github_repo_url, p.name AS project_name
       FROM services s
       LEFT JOIN projects p ON p.id = s.project_id`
    )
    .all() as Array<{
    id: string;
    name: string;
    project_id: string | null;
    github_repo_url?: string | null;
    project_name?: string | null;
  }>;

  let movedServices = 0;
  for (const service of services) {
    const currentName = (service.project_name ?? "").trim().toLowerCase();
    if (service.project_id && !GENERIC_PROJECT_NAMES.has(currentName)) continue;
    const project = ensureAppProject(ctx, service.name, { gitUrl: service.github_repo_url ?? undefined });
    if (service.project_id !== project.id) {
      ctx.db.prepare("UPDATE services SET project_id = ?, updated_at = ? WHERE id = ?").run(project.id, nowIso(), service.id);
      ctx.db
        .prepare("UPDATE databases SET project_id = ? WHERE id IN (SELECT linked_database_id FROM services WHERE id = ?)")
        .run(project.id, service.id);
      movedServices++;
    }
  }

  const removable = ctx.db
    .prepare(
      `SELECT p.id
       FROM projects p
       LEFT JOIN services s ON s.project_id = p.id
       LEFT JOIN databases d ON d.project_id = p.id
       LEFT JOIN project_env_vars pev ON pev.project_id = p.id
       WHERE lower(p.name) IN ('backup-test', 'imported apps', 'default project')
       GROUP BY p.id
       HAVING count(s.id) = 0 AND count(d.id) = 0 AND count(pev.id) = 0`
    )
    .all() as Array<{ id: string }>;
  for (const row of removable) {
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
  }
  return { movedServices, removedProjects: removable.length };
}
