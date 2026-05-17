import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types.js";
import { decryptSecret, maskSecret } from "../security.js";
import { buildConnectionString, getDatabase } from "./databases.js";

const MAX_DEPTH = 5;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".godot"
]);

const SCANNED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".php",
  ".rs",
  ".env",
  ".md",
  ".toml",
  ".yaml",
  ".yml"
]);

const IGNORED_KEYS = new Set([
  "CI",
  "DEBUG",
  "ENV",
  "HOME",
  "HOST",
  "LOG_LEVEL",
  "NODE_ENV",
  "PATH",
  "PORT",
  "PWD",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "GITHUB_TOKEN",
  "API_DOMAIN",
  "CORS_ALLOWED_ORIGINS",
  "FRONTEND_URL",
  "PLACEHOLDER_IMAGE_URL",
  "TZ"
]);

const SECRET_OR_INTEGRATION_PATTERNS = [
  /(^|_)API_KEY$/,
  /(^|_)SECRET(_|$)/,
  /(^|_)TOKEN$/,
  /(^|_)ACCESS_KEY(_|$)/,
  /^R2_/,
  /^S3_/,
  /^AWS_/,
  /^STRIPE_/,
  /^SENDGRID_/,
  /^RESEND_/,
  /^CLERK_/,
  /^AUTH0_/,
  /^SUPABASE_/,
  /^OPENAI_/
];

const DEFAULT_INFRA_KEYS = new Set(["DATABASE_URL", "POSTGRES_URL", "MYSQL_URL", "MONGO_URL", "REDIS_URL"]);

export type EnvRequirement = {
  key: string;
  source_file: string;
  reason: "required-check" | "production-config" | "integration-secret" | "infrastructure-url";
  status: "missing" | "present";
  provided_by?: "service" | "project" | "linked-database";
  value_preview?: string;
};

type ServiceRow = {
  id: string;
  project_id: string | null;
  type: string;
  working_dir: string | null;
  linked_database_id: string | null;
};

function isScannableFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === "Dockerfile" || base === "Procfile" || base.startsWith(".env")) return true;
  return SCANNED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function extractEnvKeys(content: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /\bENV\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
    /\b([A-Z][A-Z0-9_]{2,})\s*=\s*os\.getenv\(/g
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) keys.add(match[1]);
  }
  return Array.from(keys);
}

function reasonForKey(content: string, key: string): EnvRequirement["reason"] | null {
  if (IGNORED_KEYS.has(key)) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directRequired = new RegExp(
    `(if\\s+not\\s+(?:settings\\.)?${escaped}\\b[\\s\\S]{0,220}(raise\\s+ValueError|throw\\s+new\\s+Error))|` +
      `(all\\(\\[[\\s\\S]{0,500}\\b${escaped}\\b[\\s\\S]{0,500}\\][\\s\\S]{0,220}(raise\\s+ValueError|throw\\s+new\\s+Error))`,
    "i"
  ).test(content);
  if (directRequired) {
    return /production/i.test(
      content.slice(Math.max(0, content.indexOf(key) - 300), content.indexOf(key) + 500)
    )
      ? "production-config"
      : "required-check";
  }
  if (/^R2_/.test(key) || /^S3_/.test(key) || /^AWS_/.test(key) || key === "OPENAI_API_KEY")
    return "integration-secret";
  if (DEFAULT_INFRA_KEYS.has(key)) return "infrastructure-url";
  return null;
}

function effectiveEnv(
  ctx: AppContext,
  service: ServiceRow
): Map<string, { value: string; providedBy: EnvRequirement["provided_by"] }> {
  const env = new Map<string, { value: string; providedBy: EnvRequirement["provided_by"] }>();
  if (service.project_id) {
    const rows = ctx.db
      .prepare("SELECT key, value, is_secret FROM project_env_vars WHERE project_id = ?")
      .all(service.project_id) as Array<{ key: string; value: string; is_secret: number }>;
    for (const row of rows) {
      env.set(row.key, {
        value: row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value,
        providedBy: "project"
      });
    }
  }
  if (service.linked_database_id) {
    const db = getDatabase(ctx, service.linked_database_id);
    if (db) {
      const host = service.type === "docker" ? "host.docker.internal" : "localhost";
      env.set("DATABASE_URL", { value: buildConnectionString(db, host), providedBy: "linked-database" });
    }
  }
  const rows = ctx.db
    .prepare("SELECT key, value, is_secret FROM env_vars WHERE service_id = ?")
    .all(service.id) as Array<{ key: string; value: string; is_secret: number }>;
  for (const row of rows) {
    env.set(row.key, {
      value: row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value,
      providedBy: "service"
    });
  }
  return env;
}

export function scanServiceEnvRequirements(ctx: AppContext, serviceId: string): EnvRequirement[] {
  const service = ctx.db
    .prepare("SELECT id, project_id, type, working_dir, linked_database_id FROM services WHERE id = ?")
    .get(serviceId) as ServiceRow | undefined;
  if (!service?.working_dir || !fs.existsSync(service.working_dir)) return [];

  const available = effectiveEnv(ctx, service);
  const byKey = new Map<string, EnvRequirement>();

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!isScannableFile(full)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const sourceFile = path.relative(service.working_dir!, full) || entry.name;
      for (const key of extractEnvKeys(content)) {
        const reason = reasonForKey(content, key);
        if (!reason) continue;
        const existing = byKey.get(key);
        if (existing && existing.reason !== "integration-secret") continue;
        const provided = available.get(key);
        byKey.set(key, {
          key,
          source_file: existing?.source_file ?? sourceFile,
          reason,
          status: provided?.value ? "present" : "missing",
          provided_by: provided?.providedBy,
          value_preview: provided?.value ? maskSecret(provided.value) : undefined
        });
      }
    }
  };

  walk(service.working_dir, 0);
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.status !== b.status) return a.status === "missing" ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export function listServiceEnvRequirements(
  ctx: AppContext
): Array<{ service_id: string; requirements: EnvRequirement[] }> {
  const services = ctx.db.prepare("SELECT id FROM services").all() as Array<{ id: string }>;
  return services.map((service) => ({
    service_id: service.id,
    requirements: scanServiceEnvRequirements(ctx, service.id)
  }));
}
