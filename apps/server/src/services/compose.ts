/**
 * Docker Compose stacks as a single service.
 *
 * ServerHoster already had two ways to touch a compose file, and neither runs
 * one: `POST /services/import-compose` SHREDS a compose file into one native
 * service per container, and `embeddedDatabases.ts` reads one to discover a
 * database to adopt. Shredding is right for a stack that is really N unrelated
 * containers, and wrong for one whose containers reach each other over the
 * compose network (`db:5432`, `redis:6379`) or share a named volume — native
 * services run on the default bridge and would lose both.
 *
 * A `compose` service is ONE ServerHoster service that drives a whole stack
 * through `docker compose`. Compose keeps owning the network, the volumes, the
 * published ports and the container lifecycle; ServerHoster owns the git
 * checkout, the build trigger, the env and the tunnel route.
 *
 * Two invariants make this safe to point at a stack that is already running:
 *
 *   1. The project name is resolved explicitly and NEVER derived from the
 *      checkout directory (see `resolveComposeProject`). Compose identifies a
 *      stack — its containers, its network, its named volumes — by project
 *      name. Deriving it from `/root/.survhub/projects/<serviceId>/` would
 *      point compose at a NEW, empty project and silently orphan the data.
 *      Keeping the declared name means adopting the running stack in place.
 *
 *   2. The interpolation env is written OUTSIDE the checkout, under the
 *      service's data dir, and passed with `--env-file`. The deploy system
 *      resets the checkout on every pull, so an in-checkout `.env` would be
 *      destroyed — or, worse, committed.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AppContext } from "../types.js";

/** Compose filenames, in the order compose itself prefers them. */
const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
] as const;

/** Directories a compose file commonly lives in when it isn't at the repo root. */
const COMPOSE_SUBDIRS = ["deploy", "docker", "compose", "infra", ".docker"] as const;

export type ComposeConfig = {
  /** The repo checkout root. */
  root: string;
  /** Compose file path, relative to the checkout root (POSIX separators). */
  file: string;
  /** Absolute path to the compose file. */
  absFile: string;
  /** Directory the compose file lives in — compose's working directory. */
  dir: string;
  /** Explicit compose project name. Never derived from the checkout path. */
  project: string;
  /** Extra compose files layered on top, relative to the root (`-f` order matters). */
  overlays: string[];
};

/**
 * Locate a compose file in a checkout: repo root first, then the conventional
 * subdirectories. Returns a checkout-relative path, or null.
 *
 * Deliberately NOT a deep walk, unlike `findDockerfile`: a compose file buried
 * in an `examples/` directory or a test fixture is not the stack we want to
 * run, and guessing wrong here STARTS CONTAINERS rather than merely failing a
 * build. A repo that keeps its stack somewhere else pins `compose_file`.
 */
export function findComposeFile(projectPath: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    if (fs.existsSync(path.join(projectPath, name))) return name;
  }
  for (const dir of COMPOSE_SUBDIRS) {
    for (const name of COMPOSE_FILENAMES) {
      if (fs.existsSync(path.join(projectPath, dir, name))) return `${dir}/${name}`;
    }
  }
  return null;
}

/**
 * Overlay files sitting beside the compose file, if the repo ships any.
 *
 * Compose auto-loads `docker-compose.override.yml` ONLY when it resolves the
 * compose file itself; passing `-f` explicitly disables that. We re-add it so
 * behaviour matches running `docker compose` by hand in that directory, and
 * also honour a `.serverhoster.yml` overlay — the escape hatch for a repo that
 * needs different bindings under ServerHoster than in local development.
 */
export function findComposeOverlays(projectPath: string, composeFile: string): string[] {
  const dir = path.posix.dirname(composeFile.split(path.sep).join("/"));
  const base = path.posix.basename(composeFile.split(path.sep).join("/"));
  const ext = base.match(/\.(ya?ml)$/i)?.[0] ?? ".yml";
  const stem = base.slice(0, base.length - ext.length);
  const out: string[] = [];
  for (const candidate of [`${stem}.override${ext}`, `${stem}.serverhoster${ext}`]) {
    const rel = dir === "." ? candidate : `${dir}/${candidate}`;
    if (fs.existsSync(path.join(projectPath, rel))) out.push(rel);
  }
  return out;
}

/** The `name:` key declared inside a compose file, if any. */
export function readComposeProjectName(absComposeFile: string): string | null {
  try {
    const parsed = yaml.load(fs.readFileSync(absComposeFile, "utf8")) as { name?: unknown } | null;
    const name = parsed?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Compose project names are lowercase alphanumeric plus `_` and `-`, and must
 * start with a letter or digit. Mirrors compose's own validation so a bad name
 * fails here with a clear message instead of as a compose usage error.
 */
export function normalizeComposeProject(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "");
  return cleaned || "compose";
}

/**
 * Resolve the project name, in priority order:
 *
 *   1. the `compose_project` column — recorded on first deploy, then
 *      authoritative forever, so a later edit to the compose file's `name:`
 *      cannot silently repoint a live service at a different set of volumes;
 *   2. the compose file's own `name:` — this is what lets ServerHoster adopt a
 *      stack that is already running, started by hand, with its data in place;
 *   3. the SERVICE NAME, slugified.
 *
 * Never the checkout directory: that is the opaque service id, and using it
 * would create a fresh empty project on the first deploy.
 */
export function resolveComposeProject(opts: {
  stored?: string | null;
  declared?: string | null;
  serviceName?: string | null;
}): string {
  const stored = opts.stored?.trim();
  if (stored) return normalizeComposeProject(stored);
  const declared = opts.declared?.trim();
  if (declared) return normalizeComposeProject(declared);
  return normalizeComposeProject(opts.serviceName?.trim() || "compose");
}

/**
 * Build the compose config for a service, or null when this service has no
 * compose file to run.
 *
 * `compose_file` on the row is a PIN and wins over detection — the same
 * contract as the `dockerfile` column, and necessary for the common case of a
 * monorepo whose root looks like a node app while its stack lives in `deploy/`.
 * A pin naming a file that no longer exists falls back to detection rather than
 * failing, so a moved compose file self-heals on the next deploy.
 */
export function resolveComposeConfig(
  ctx: AppContext,
  serviceId: string,
  projectPath: string
): ComposeConfig | null {
  const row = ctx.db
    .prepare("SELECT name, compose_file, compose_project FROM services WHERE id = ?")
    .get(serviceId) as
    | { name?: string; compose_file?: string | null; compose_project?: string | null }
    | undefined;

  const pinned = row?.compose_file?.trim();
  const file =
    pinned && fs.existsSync(path.join(projectPath, pinned)) ? pinned : findComposeFile(projectPath);
  if (!file) return null;

  const absFile = path.join(projectPath, file);
  return {
    root: projectPath,
    file,
    absFile,
    dir: path.dirname(absFile),
    project: resolveComposeProject({
      stored: row?.compose_project,
      declared: readComposeProjectName(absFile),
      serviceName: row?.name
    }),
    overlays: findComposeOverlays(projectPath, file)
  };
}

/** Path of the ServerHoster-managed interpolation env file for a service. */
export function composeEnvFilePath(ctx: AppContext, serviceId: string): string {
  // Built from `serviceDataDir` directly rather than calling runtime.ts's
  // `serviceDataDirFor` — runtime.ts imports this module, and reaching back
  // would close an import cycle.
  return path.join(ctx.config.serviceDataDir, serviceId, "compose.env");
}

/**
 * Write the merged service env to `compose.env`, for `--env-file`.
 *
 * Kept out of the checkout on purpose (see the module header), and 0600 because
 * it holds whatever secrets the stack interpolates.
 *
 * Compose's env-file parser is NOT a shell: it reads `KEY=VALUE` literally to
 * end of line, with no quoting or escaping. A value containing a newline would
 * therefore corrupt every following line — and a key that isn't a valid env
 * identifier is ignored by compose anyway. Both are skipped and reported so the
 * caller can surface them in the build log, rather than silently mangled.
 */
export function writeComposeEnvFile(
  ctx: AppContext,
  serviceId: string,
  env: Record<string, string>
): { path: string; written: number; skipped: string[] } {
  const target = composeEnvFilePath(ctx, serviceId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines: string[] = [
    "# Generated by ServerHoster from this service's env vars.",
    "# Rewritten on every deploy, start and restart — edits here are lost.",
    ""
  ];
  const skipped: string[] = [];
  let written = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      skipped.push(key);
      continue;
    }
    lines.push(`${key}=${value}`);
    written += 1;
  }
  fs.writeFileSync(target, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort — a non-POSIX host has no mode to set */
  }
  return { path: target, written, skipped };
}

/**
 * The `docker compose …` prefix for a config: explicit project name, our
 * managed env file, then every compose file in overlay order.
 *
 * `--env-file` replaces compose's default `.env` auto-loading, which is the
 * point: a `.env` shipped in the checkout must not shadow the values an
 * operator set in the dashboard.
 */
export function composeCommandPrefix(cfg: ComposeConfig, envFile: string): string {
  const files = [cfg.file, ...cfg.overlays]
    .map((rel) => `-f ${JSON.stringify(path.join(cfg.root, rel))}`)
    .join(" ");
  return `docker compose -p ${JSON.stringify(cfg.project)} --env-file ${JSON.stringify(envFile)} ${files}`;
}

/** One row of `docker compose ps`. */
export type ComposeContainer = {
  name: string;
  service: string;
  state: string;
  health: string;
  exitCode: number;
};

/**
 * Parse `docker compose ps --format json`.
 *
 * Compose has emitted BOTH shapes depending on version: a JSON array, and
 * newline-delimited JSON objects (one per container). Handle both, and tolerate
 * a partial line rather than throwing — this feeds status reconciliation, which
 * must never take a service down because compose changed its output format.
 */
export function parseComposePs(raw: string): ComposeContainer[] {
  const pick = (entry: Record<string, unknown>): ComposeContainer => ({
    name: String(entry.Name ?? entry.name ?? ""),
    service: String(entry.Service ?? entry.service ?? ""),
    state: String(entry.State ?? entry.state ?? "").toLowerCase(),
    health: String(entry.Health ?? entry.health ?? "").toLowerCase(),
    exitCode: Number(entry.ExitCode ?? entry.exitCode ?? 0) || 0
  });

  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) ? arr.map((e) => pick(e as Record<string, unknown>)) : [];
    } catch {
      return [];
    }
  }

  const out: ComposeContainer[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(pick(JSON.parse(trimmed) as Record<string, unknown>));
    } catch {
      /* a truncated or interleaved line is not worth failing a status check over */
    }
  }
  return out;
}

/**
 * Collapse per-container states into one service status.
 *
 * A compose stack is `running` when at least one container is up and none has
 * died badly. `exited 0` is NOT a failure — one-shot init/migration containers
 * legitimately finish, and treating them as crashed would flap the status of
 * every stack that has one. A non-zero exit, or `dead`, is a crash.
 */
export function composeStatusFrom(containers: ComposeContainer[]): "running" | "stopped" | "crashed" {
  if (containers.length === 0) return "stopped";
  const crashed = containers.some(
    (c) => c.state === "dead" || (c.state === "exited" && c.exitCode !== 0)
  );
  const anyUp = containers.some((c) => c.state === "running" || c.state === "restarting");
  if (anyUp) return crashed ? "crashed" : "running";
  return crashed ? "crashed" : "stopped";
}
