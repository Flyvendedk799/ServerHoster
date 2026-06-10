import fs from "node:fs";
import path from "node:path";

/**
 * Supabase Edge Function secret scanning (Database-Tracker Phase 2,
 * spec "Local Function Secrets").
 *
 * Walks `supabase/functions/**` under a service's working directory and
 * extracts every env key the function code reads via:
 *
 *   - Deno.env.get("KEY") / Deno.env.get('KEY')
 *   - process.env.KEY / process.env["KEY"]
 *   - import.meta.env.KEY
 *
 * Each key is classified so the provisioning UI can decide what to generate,
 * what to ask the operator for, and what to surface as degraded-if-missing:
 *
 *   - "auto-generated":    ServerHoster creates these when provisioning the
 *                          local Supabase stack (SUPABASE_URL, keys, APP_URL…).
 *   - "optional-external": third-party provider keys — missing values degrade
 *                          the affected function but never block provisioning.
 *   - "infrastructure":    DB URLs provided by the local stack internals and
 *                          not exposed to the frontend by default.
 *   - "unknown":           anything we can't confidently classify.
 */

export type FunctionSecretClassification =
  | "auto-generated"
  | "optional-external"
  | "infrastructure"
  | "unknown";

export type FunctionSecretRequirement = {
  key: string;
  classification: FunctionSecretClassification;
  /** Paths (relative to the service dir) of every file referencing the key. */
  source_files: string[];
};

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
  ".vscode"
]);

const FUNCTION_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const ENV_READ_PATTERNS = [
  /Deno\.env\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g
];

const AUTO_GENERATED_KEYS = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AI_KEY_ENCRYPTION_KEY",
  "APP_URL",
  // Frontend variants of the generated stack values.
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY"
]);

const INFRASTRUCTURE_KEYS = new Set([
  "DATABASE_URL",
  "POSTGRES_URL",
  "SUPABASE_DB_URL",
  "MYSQL_URL",
  "MONGO_URL",
  "REDIS_URL"
]);

const KNOWN_EXTERNAL_KEYS = new Set([
  "LOVABLE_API_KEY",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "SENDGRID_API_KEY"
]);

/** Runtime/noise keys that are not secrets and should not be surfaced. */
const IGNORED_KEYS = new Set(["NODE_ENV", "ENV", "PORT", "HOST", "PATH", "HOME", "TZ", "DEBUG", "LOG_LEVEL"]);

export function classifyFunctionSecret(key: string): FunctionSecretClassification {
  if (AUTO_GENERATED_KEYS.has(key)) return "auto-generated";
  if (INFRASTRUCTURE_KEYS.has(key) || /_DB_URL$|_DATABASE_URL$/.test(key)) return "infrastructure";
  if (KNOWN_EXTERNAL_KEYS.has(key) || key.startsWith("STRIPE_")) return "optional-external";
  // Unknown provider credentials: anything shaped like *_API_KEY / *_SECRET / *_TOKEN.
  if (/(_API_KEY|_SECRET|_TOKEN)$/.test(key)) return "optional-external";
  return "unknown";
}

function extractEnvReads(content: string): string[] {
  const keys = new Set<string>();
  for (const pattern of ENV_READ_PATTERNS) {
    for (const match of content.matchAll(pattern)) keys.add(match[1]);
  }
  return Array.from(keys);
}

/** Find every `supabase/functions` directory up to MAX_DEPTH below the service dir. */
export function findFunctionsDirs(servicePath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "functions" && path.basename(dir) === "supabase") {
        found.push(full);
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(servicePath, 0);
  return found;
}

function collectEnvReads(dir: string, relativeRoot: string, byKey: Map<string, Set<string>>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectEnvReads(full, relativeRoot, byKey);
      continue;
    }
    if (!FUNCTION_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
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
    const rel = path.relative(relativeRoot, full) || entry.name;
    for (const key of extractEnvReads(content)) {
      if (IGNORED_KEYS.has(key)) continue;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)!.add(rel);
    }
  }
}

function toRequirements(byKey: Map<string, Set<string>>): FunctionSecretRequirement[] {
  return Array.from(byKey.entries())
    .map(([key, files]) => ({
      key,
      classification: classifyFunctionSecret(key),
      source_files: Array.from(files).sort()
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Scan ONE directory subtree for env reads (source_files relative to
 * `relativeRoot`). Used by `listEdgeFunctions` (functions.ts) to attribute
 * keys per Edge Function directory.
 */
export function scanDirSecrets(dir: string, relativeRoot: string): FunctionSecretRequirement[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const byKey = new Map<string, Set<string>>();
  collectEnvReads(dir, relativeRoot, byKey);
  return toRequirements(byKey);
}

/**
 * Scan `supabase/functions/**` for env reads and classify each key.
 * Returns one entry per key, sorted, with every referencing file listed so
 * missing-secret diagnostics can point at the exact source.
 */
export function scanFunctionSecrets(servicePath: string): FunctionSecretRequirement[] {
  if (!servicePath || !fs.existsSync(servicePath)) return [];
  const byKey = new Map<string, Set<string>>();
  for (const functionsDir of findFunctionsDirs(servicePath)) {
    collectEnvReads(functionsDir, servicePath, byKey);
  }
  return toRequirements(byKey);
}
