import yaml from "js-yaml";
import { z } from "zod";

/**
 * ServerHoster CI config. This is not a GitHub Actions workflow: nothing here
 * is sent to GitHub, and a private repo does not spend Actions minutes.
 * The file lives at `.survhub/ci.yml` in the repo, or is pasted in the CI tab.
 */

export const CI_CONFIG_PATH = ".survhub/ci.yml";

export const DEFAULT_CI_IMAGE = "node:22-bookworm";
export const DEFAULT_CI_TIMEOUT_MINUTES = 20;
export const DEFAULT_CI_MEMORY_MB = 2048;
export const DEFAULT_CI_CPUS = 1;

export const EXAMPLE_CI_YAML = `# Runs on the ServerHoster machine, in Docker. GitHub Actions is not used.
image: node:22-bookworm
timeoutMinutes: 20
memoryMb: 2048
steps:
  - name: Install
    run: npm ci
  - name: Test
    run: npm test
  - name: Build
    run: npm run build
# Pull a service or project env var into the job. Anything not listed stays out,
# including production DATABASE_URL.
# secrets:
#   - NPM_TOKEN
`;

const ALLOWED_ROOT = [
  "name",
  "image",
  "timeoutMinutes",
  "memoryMb",
  "cpus",
  "gateDeploy",
  "env",
  "secrets",
  "steps"
] as const;

const IMAGE_RE = /^[a-z0-9][a-z0-9._:@/-]{0,200}$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiConfigError";
  }
}

export type CiDefaults = {
  image: string;
  timeoutMinutes: number;
  memoryMb: number;
  cpus: number;
};

export type CiConfig = {
  image: string;
  timeoutMinutes: number;
  memoryMb: number;
  cpus: number;
  env: Record<string, string>;
  secrets: string[];
  steps: Array<{ name: string; run: string }>;
};

export type CiPlan = "deploy-only" | "deploy-and-ci" | "ci-then-deploy";

const stepSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    run: z.string().trim().min(1).max(8000)
  })
  .strict();

const fileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    image: z.string().trim().min(1).max(200).optional(),
    timeoutMinutes: z.number().int().min(1).max(120).optional(),
    memoryMb: z.number().int().min(128).max(8192).optional(),
    cpus: z.number().min(0.25).max(4).optional(),
    // Accepted so a file can mention it, but the dashboard toggle wins.
    gateDeploy: z.boolean().optional(),
    env: z.record(z.string().max(4000)).optional(),
    secrets: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    steps: z.array(stepSchema).min(1).max(30)
  })
  .strict();

export function assertImageRef(image: string): string {
  const value = image.trim();
  if (!IMAGE_RE.test(value) || value.includes("..")) {
    throw new CiConfigError(
      `Image "${image}" is not a plain Docker reference. Use something like node:22-bookworm.`
    );
  }
  return value;
}

export function parseCiConfig(source: string, defaults: CiDefaults): CiConfig {
  const text = source.trim();
  if (!text) throw new CiConfigError(`CI config is empty. Expected steps, or a ${CI_CONFIG_PATH} file.`);
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiConfigError(`CI config is not valid YAML: ${message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CiConfigError("CI config must be a YAML mapping with a steps list.");
  }
  const unknown = Object.keys(raw).filter(
    (key) => !ALLOWED_ROOT.includes(key as (typeof ALLOWED_ROOT)[number])
  );
  if (unknown.length > 0) {
    throw new CiConfigError(
      `Unknown field ${unknown.join(", ")}. This file is run by ServerHoster on this machine, not by GitHub Actions. Allowed fields: ${ALLOWED_ROOT.join(", ")}.`
    );
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? issue.path.join(".") : "config";
    throw new CiConfigError(`CI config: ${where} ${issue?.message ?? "is invalid"}.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data.env ?? {})) {
    if (!ENV_KEY_RE.test(key)) throw new CiConfigError(`Env name "${key}" is not a valid variable name.`);
    if (value.includes("\0")) throw new CiConfigError(`Env ${key} contains a NUL byte.`);
    env[key] = value;
  }
  const secrets: string[] = [];
  for (const key of parsed.data.secrets ?? []) {
    if (!ENV_KEY_RE.test(key)) throw new CiConfigError(`Secret name "${key}" is not a valid variable name.`);
    if (!secrets.includes(key)) secrets.push(key);
  }
  return {
    image: assertImageRef(parsed.data.image ?? defaults.image),
    timeoutMinutes: parsed.data.timeoutMinutes ?? defaults.timeoutMinutes,
    memoryMb: parsed.data.memoryMb ?? defaults.memoryMb,
    cpus: parsed.data.cpus ?? defaults.cpus,
    env,
    secrets,
    steps: parsed.data.steps.map((step) => ({ name: step.name, run: step.run }))
  };
}

/**
 * Whether a new commit should deploy immediately, deploy and also run CI, or
 * wait until CI passes. Disabled and missing pipelines do not change deploys.
 */
export function planForPipeline(
  pipeline: { enabled: number; gate_deploy: number } | null | undefined
): CiPlan {
  if (!pipeline || !pipeline.enabled) return "deploy-only";
  if (pipeline.gate_deploy) return "ci-then-deploy";
  return "deploy-and-ci";
}

export function commitsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Drop userinfo from an https git URL so a checkout cannot keep a PAT. */
export function stripGitCredentials(repoUrl: string): string {
  if (!/^https?:\/\//i.test(repoUrl)) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return repoUrl.replace(/\/\/(?:[^@/\s]+)@/g, "//");
  }
}

function secretValues(secrets: Array<string | null | undefined>): string[] {
  return [
    ...new Set(secrets.filter((value): value is string => typeof value === "string" && value.length > 0))
  ].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secretValues(secrets)) out = out.split(secret).join("***");
  out = out.replace(/x-access-token:[^@\s]+/gi, "x-access-token:***");
  out = out.replace(/https?:\/\/[^:\s@/]+:[^@\s/]+@/gi, (match) =>
    match.toLowerCase().startsWith("http://") ? "http://***@" : "https://***@"
  );
  return out;
}

/**
 * Mask secrets that are split across Docker's stdout chunks.
 * A chunk is only emitted once it cannot still be the start of a secret;
 * call flush when the stream ends.
 */
export function createLogRedactor(secrets: Array<string | null | undefined>): {
  push(chunk: string): string;
  flush(): string;
} {
  const values = secretValues(secrets);
  const hold = values.reduce((max, secret) => Math.max(max, secret.length - 1), 0);
  let pending = "";
  return {
    push(chunk: string): string {
      if (!chunk) return "";
      pending = redactSecrets(pending + chunk, values);
      if (pending.length <= hold) return "";
      const ready = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      return ready;
    },
    flush(): string {
      const ready = pending;
      pending = "";
      return ready;
    }
  };
}

export function buildCiEnv(
  config: CiConfig,
  available: Record<string, string>,
  meta: { commit: string | null; branch: string; serviceName: string }
): { env: Record<string, string>; redactions: string[] } {
  const env: Record<string, string> = {
    CI: "true",
    SURVHUB_CI: "1",
    SURVHUB_BRANCH: meta.branch,
    SURVHUB_SERVICE: meta.serviceName,
    ...config.env
  };
  if (meta.commit) env.SURVHUB_COMMIT = meta.commit;
  const redactions: string[] = [];
  for (const key of config.secrets) {
    const value = available[key];
    if (!value) {
      throw new CiConfigError(
        `Secret ${key} is not set on this service or its project. CI only receives secrets named in the config, and ${key} is missing.`
      );
    }
    if (value.includes("\0") || value.includes("\n")) {
      throw new CiConfigError(`Secret ${key} cannot be passed into a container (it contains a newline).`);
    }
    env[key] = value;
    redactions.push(value);
  }
  return { env, redactions };
}

export function sanitizeLogChunk(chunk: string): string {
  if (chunk.includes("\0")) return "[binary output omitted]\n";
  if (chunk.length > 16_000) return `${chunk.slice(0, 16_000)}\n…[chunk truncated]\n`;
  return chunk;
}

export function capLog(existing: string, chunk: string, max = 200_000): string {
  const next = existing + chunk;
  if (next.length <= max) return next;
  return `…[earlier log truncated]\n${next.slice(next.length - max)}`;
}
