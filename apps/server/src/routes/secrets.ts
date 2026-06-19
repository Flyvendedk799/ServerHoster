import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  const value = inventoryValue(ctx, row);
  return {
    id: row.id,
    key: row.key,
    scope: "service" as const,
    value_preview: maskSecret(value),
    storage: storageForRow(row),
    source_file: null,
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
  const value = inventoryValue(ctx, row);
  const services = linkedServices ?? (row.project_id ? servicesForProject(ctx, row.project_id) : []);
  return {
    id: row.id,
    key: row.key,
    scope: "shared" as const,
    value_preview: maskSecret(value),
    storage: storageForRow(row),
    source_file: null,
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    service_id: null,
    service_name: null,
  linked_services: services.map(serviceLink),
    system: false
  };
}

type SecretInventoryItem = {
  id: string;
  key: string;
  scope: "service" | "shared";
  value_preview: string;
  storage?: "encrypted" | "plain-env" | "repo-detected";
  source_file?: string | null;
  project_id: string | null;
  project_name: string | null;
  service_id: string | null;
  service_name: string | null;
  linked_services: ReturnType<typeof serviceLink>[];
  system?: boolean;
};

const PUBLIC_SECRET_KEY_EXCEPTIONS = [
  /^NEXT_PUBLIC_/,
  /^PUBLIC_/,
  /^VITE_/,
  /(^|_)PUBLISHABLE_KEY$/,
  /(^|_)PUBLIC_KEY$/,
  /(^|_)ANON_KEY$/,
  /(^|_)URL$/,
  /(^|_)URI$/
];

const SECRET_KEY_PATTERNS = [
  /(^|_)API_KEY$/,
  /(^|_)SECRET(_|$)/,
  /(^|_)TOKEN$/,
  /(^|_)ACCESS_KEY(_|$)/,
  /(^|_)PRIVATE_KEY$/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^PLATFORM_API_KEY$/,
  /^STRIPE_/,
  /^RESEND_/,
  /^SENDGRID_/,
  /^CLERK_SECRET_/,
  /^SUPABASE_SERVICE_ROLE_KEY$/,
  /^AWS_/,
  /^R2_/,
  /^S3_/
];

const REPO_SECRET_SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

const REPO_SECRET_MAX_DEPTH = 5;
const REPO_SECRET_MAX_FILE_BYTES = 96 * 1024;

function looksLikeSecretKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (!normalized) return false;
  if (PUBLIC_SECRET_KEY_EXCEPTIONS.some((pattern) => pattern.test(normalized))) return false;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeRealSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  const lowered = trimmed.toLowerCase();
  if (
    /^(changeme|change-me|example|placeholder|replace_me|replace-me|todo|undefined|null)$/i.test(trimmed) ||
    lowered.includes("your_") ||
    lowered.includes("your-") ||
    lowered.includes("not-used") ||
    lowered.includes("dummy") ||
    lowered.includes("example")
  ) {
    return false;
  }
  return true;
}

function inventoryValue(ctx: AppContext, row: Pick<EnvSecretRow, "value" | "is_secret">): string {
  return row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value;
}

function storageForRow(row: Pick<EnvSecretRow, "is_secret">): "encrypted" | "plain-env" {
  return row.is_secret ? "encrypted" : "plain-env";
}

function shouldShowEnvRow(row: Pick<EnvSecretRow, "key" | "is_secret" | "value">): boolean {
  if (row.is_secret) return true;
  return looksLikeSecretKey(row.key) && looksLikeRealSecretValue(row.value);
}

function assertInventoryRow(row: EnvSecretRow, label: string): void {
  if (shouldShowEnvRow(row)) return;
  throw new Error(`${label} not found`);
}

function envFileValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function isEnvFileName(name: string): boolean {
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return !/\.(example|sample|template|dist)$/i.test(name);
}

function repoSecretId(serviceId: string, sourceFile: string, key: string, line: number): string {
  return `repo:${crypto
    .createHash("sha256")
    .update(`${serviceId}:${sourceFile}:${key}:${line}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function scanRootForService(ctx: AppContext, service: { id: string; working_dir?: string | null }): string | null {
  if (!service.working_dir) return null;
  const workingDir = path.resolve(service.working_dir);
  const cloneRoot = path.resolve(path.join(ctx.config.projectsDir, service.id));
  if (workingDir === cloneRoot || workingDir.startsWith(`${cloneRoot}${path.sep}`)) return cloneRoot;
  return fs.existsSync(workingDir) ? workingDir : null;
}

function listRepoDetectedSecrets(ctx: AppContext): SecretInventoryItem[] {
  const services = ctx.db
    .prepare(
      `SELECT s.id, s.name, s.status, s.project_id, s.working_dir, p.name AS project_name
       FROM services s
       LEFT JOIN projects p ON p.id = s.project_id
       ORDER BY s.created_at DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    status: string;
    project_id: string | null;
    working_dir: string | null;
    project_name: string | null;
  }>;

  const detections: SecretInventoryItem[] = [];
  const seen = new Set<string>();

  for (const service of services) {
    const root = scanRootForService(ctx, service);
    if (!root || !fs.existsSync(root)) continue;

    const walk = (dir: string, depth: number): void => {
      if (depth > REPO_SECRET_MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (REPO_SECRET_SKIP_DIRS.has(entry.name)) continue;
          walk(full, depth + 1);
          continue;
        }
        if (!isEnvFileName(entry.name)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > REPO_SECRET_MAX_FILE_BYTES) continue;

        let content = "";
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }

        const sourceFile = path.relative(root, full) || entry.name;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
          if (!match) return;
          const key = match[1];
          const value = envFileValue(match[2]);
          if (!looksLikeSecretKey(key) || !looksLikeRealSecretValue(value)) return;
          const dedupeKey = `${service.id}:${sourceFile}:${key}:${index + 1}`;
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          detections.push({
            id: repoSecretId(service.id, sourceFile, key, index + 1),
            key,
            scope: "service",
            value_preview: maskSecret(value),
            storage: "repo-detected",
            source_file: sourceFile,
            project_id: service.project_id,
            project_name: service.project_name,
            service_id: service.id,
            service_name: service.name,
            linked_services: [serviceLink(service)],
            system: false
          });
        });
      }
    };

    walk(root, 0);
  }

  return detections;
}

function getSharedSecretById(ctx: AppContext, id: string): EnvSecretRow {
  const row = ctx.db
    .prepare(
      `SELECT pev.id, pev.key, pev.value, pev.is_secret, pev.project_id, p.name AS project_name
       FROM project_env_vars pev
       LEFT JOIN projects p ON p.id = pev.project_id
       WHERE pev.id = ?`
    )
    .get(id) as EnvSecretRow | undefined;
  if (!row) throw new Error("Shared secret not found");
  assertInventoryRow(row, "Shared secret");
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
       WHERE ev.id = ?`
    )
    .get(id) as EnvSecretRow | undefined;
  if (!row) throw new Error("Service secret not found");
  assertInventoryRow(row, "Service secret");
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
         ORDER BY ev.key ASC, s.name ASC`
      )
      .all() as EnvSecretRow[];
    const sharedRows = ctx.db
      .prepare(
        `SELECT pev.id, pev.key, pev.value, pev.is_secret, pev.project_id, p.name AS project_name
         FROM project_env_vars pev
         LEFT JOIN projects p ON p.id = pev.project_id
         ORDER BY pev.key ASC, p.name ASC`
      )
      .all() as EnvSecretRow[];
    return {
      secrets: [
        ...sharedRows.filter(shouldShowEnvRow).map((row) => sharedSecretItem(ctx, row)),
        ...serviceRows.filter(shouldShowEnvRow).map((row) => serviceSecretItem(ctx, row)),
        ...listRepoDetectedSecrets(ctx)
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
    const value = inventoryValue(ctx, source);
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

  ctx.app.post("/secrets/service/:id/protect", async (req) => {
    const { id } = req.params as { id: string };
    const row = getServiceSecretById(ctx, id);
    if (row.system) throw new Error("System-managed secrets cannot be changed here");
    if (!row.is_secret) {
      ctx.db
        .prepare("UPDATE env_vars SET value = ?, is_secret = 1 WHERE id = ?")
        .run(encryptSecret(row.value, ctx.config.secretKey), id);
    }
    const updated = getServiceSecretById(ctx, id);
    const affected =
      updated.service_id && updated.service_name && updated.service_status
        ? [serviceLink({ id: updated.service_id, name: updated.service_name, status: updated.service_status })]
        : [];
    return {
      ok: true,
      secret: serviceSecretItem(ctx, updated),
      affected_services: affected,
      redeploy_required: true,
      message: "Secret encrypted at rest. Redeploy or restart affected services before the new value is live."
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

  ctx.app.post("/secrets/shared/:id/protect", async (req) => {
    const { id } = req.params as { id: string };
    const row = getSharedSecretById(ctx, id);
    if (!row.is_secret) {
      ctx.db
        .prepare("UPDATE project_env_vars SET value = ?, is_secret = 1 WHERE id = ?")
        .run(encryptSecret(row.value, ctx.config.secretKey), id);
    }
    const updated = getSharedSecretById(ctx, id);
    const linked = updated.project_id ? servicesForProject(ctx, updated.project_id) : [];
    return {
      ok: true,
      secret: sharedSecretItem(ctx, updated, linked),
      affected_services: linked.map(serviceLink),
      redeploy_required: true,
      message: "Shared secret encrypted at rest. Redeploy or restart linked services before the new value is live."
    };
  });
}
