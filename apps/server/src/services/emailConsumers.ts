import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types.js";

/**
 * Does anything in this project actually READ the SMTP env we inject?
 *
 * "Enable email" writes SMTP_* into project_env_vars and patches a linked
 * Supabase stack's GoTrue config. Neither does anything for an app that has no
 * mail code: the env is injected, the apply reports success, the service is
 * restarted, and signup still goes straight through with no email — which looks
 * exactly like a broken relay and sends you hunting through Cloudflare and the
 * tunnel instead of the repo.
 *
 * So before claiming success, look. This is a heuristic on purpose: a false
 * "yes" costs nothing (the apply proceeds either way) and a "no" is reported as
 * a warning, never an error — the operator may be about to write the mail code.
 */

const MAX_DEPTH = 5;
const MAX_FILE_BYTES = 256 * 1024;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor"
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
  ".java",
  ".json"
]);

/** Server-side mail libraries. Finding one is strong evidence mail is sent. */
const MAIL_PACKAGES = [
  "nodemailer",
  "resend",
  "@sendgrid/mail",
  "sendgrid",
  "postmark",
  "mailgun.js",
  "mailgun-js",
  "@aws-sdk/client-ses",
  "emailjs",
  "smtplib",
  "django-anymail",
  "flask-mail",
  "gomail",
  "lettre"
];

/**
 * A read of one of the injected keys. Deliberately narrow: a bare mention of
 * "SMTP_HOST" in a README or a .env.example proves nothing, so only real
 * accessor syntax counts.
 */
const ENV_READ_PATTERNS = [
  /process\.env\.(SMTP_[A-Z0-9_]+|EMAIL_ENABLED)\b/,
  /process\.env\[\s*['"](SMTP_[A-Z0-9_]+|EMAIL_ENABLED)['"]\s*\]/,
  /import\.meta\.env\.(SMTP_[A-Z0-9_]+|EMAIL_ENABLED)\b/,
  /(?:os\.)?getenv\(\s*['"](SMTP_[A-Z0-9_]+|EMAIL_ENABLED)['"]/,
  /os\.environ(?:\.get\(\s*|\[\s*)['"](SMTP_[A-Z0-9_]+|EMAIL_ENABLED)['"]/,
  /ENV\[\s*['"](SMTP_[A-Z0-9_]+|EMAIL_ENABLED)['"]\s*\]/,
  /Deno\.env\.get\(\s*['"](SMTP_[A-Z0-9_]+|EMAIL_ENABLED)['"]/
];

export type EmailConsumer = {
  service_id: string;
  name: string;
  /** True when this service's checkout reads SMTP_* or ships a mail library. */
  consumes: boolean;
  /** Where that was found, relative to the checkout — for the operator, not logic. */
  evidence: string | null;
  /** Set when the checkout isn't on disk yet (never deployed), so "no" is unproven. */
  unscannable?: string;
};

function isScannableFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === "requirements.txt" || base === "go.mod" || base === "Gemfile") return true;
  return SCANNED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** A mail package named in a manifest (package.json, requirements.txt, go.mod…). */
function manifestMailPackage(base: string, content: string): string | null {
  const isManifest =
    base === "package.json" || base === "requirements.txt" || base === "go.mod" || base === "Gemfile";
  if (!isManifest) return null;
  const lowered = content.toLowerCase();
  for (const pkg of MAIL_PACKAGES) {
    if (lowered.includes(pkg.toLowerCase())) return pkg;
  }
  return null;
}

/** First piece of evidence under `root`, or null after walking the whole tree. */
function findEvidence(root: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        const hit = walk(full, depth + 1);
        if (hit) return hit;
        continue;
      }
      if (entry.name !== "package.json" && !isScannableFile(full)) continue;
      let content: string;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(root, full) || entry.name;
      const pkg = manifestMailPackage(entry.name, content);
      if (pkg) return `${rel} depends on ${pkg}`;
      for (const pattern of ENV_READ_PATTERNS) {
        const match = pattern.exec(content);
        if (match) return `${rel} reads ${match[1]}`;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * One row per service in the project, saying whether its checkout can use the
 * SMTP env. Services whose clone isn't on disk report `unscannable` rather than
 * a confident "no" — an app that was never deployed has nothing to look at.
 */
export function detectEmailConsumers(ctx: AppContext, projectId: string): EmailConsumer[] {
  const services = ctx.db
    .prepare("SELECT id, name, working_dir FROM services WHERE project_id = ? ORDER BY name")
    .all(projectId) as Array<{ id: string; name: string; working_dir: string | null }>;

  return services.map((service) => {
    // The clone root, not working_dir: in a monorepo the web service's
    // working_dir is apps/web while the mail code lives in apps/api, and
    // scanning only the former would report a confident, wrong "no".
    const cloneDir = path.join(ctx.config.projectsDir, service.id);
    const root = fs.existsSync(cloneDir) ? cloneDir : (service.working_dir ?? "");
    if (!root || !fs.existsSync(root)) {
      return {
        service_id: service.id,
        name: service.name,
        consumes: false,
        evidence: null,
        unscannable: "No checkout on disk yet — deploy this service before trusting this result."
      };
    }
    const evidence = findEvidence(root);
    return { service_id: service.id, name: service.name, consumes: Boolean(evidence), evidence };
  });
}
