/**
 * Running a compose stack: build, lifecycle, and observed status.
 *
 * Split from `compose.ts` (which is pure path/parse/name resolution, and
 * unit-testable without Docker or a database) so the side-effecting half can be
 * read on its own. It also keeps the import graph acyclic: `runtime.ts` imports
 * this module, so this module must never import `runtime.ts`. That is why every
 * entry point takes the merged service env as a PARAMETER rather than looking
 * it up through `getServiceEnvWithLinks`.
 */

import path from "node:path";
import { broadcast, insertLog, runCommand, updateServiceStatus } from "../lib/core.js";
import type { AppContext } from "../types.js";
import {
  type ComposeConfig,
  type ComposeContainer,
  composeCommandPrefix,
  composeStatusFrom,
  parseComposePs,
  resolveComposeConfig,
  writeComposeEnvFile
} from "./compose.js";

/** Compose build has to accommodate real image builds — apt, pnpm, Playwright. */
const COMPOSE_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
/** `up -d` waits on healthchecks and ordered startup, but must not hang forever. */
const COMPOSE_UP_TIMEOUT_MS = 10 * 60 * 1000;
/** Lifecycle calls that only signal containers that already exist. */
const COMPOSE_LIFECYCLE_TIMEOUT_MS = 3 * 60 * 1000;
/** Read-only introspection; stays short because it runs on the status sweep. */
const COMPOSE_QUERY_TIMEOUT_MS = 30 * 1000;

export type ComposeRunResult = { code: number; output: string; command: string };

/** The checkout directory the deploy system owns for a service. */
export function composeProjectPath(ctx: AppContext, serviceId: string): string {
  return path.join(ctx.config.projectsDir, serviceId);
}

/**
 * Resolve a service's compose config from its checkout, or null when it has
 * none (not a compose service, or never deployed).
 */
export function composeConfigFor(ctx: AppContext, serviceId: string): ComposeConfig | null {
  return resolveComposeConfig(ctx, serviceId, composeProjectPath(ctx, serviceId));
}

/**
 * Run one `docker compose` subcommand for a service.
 *
 * The env file is rewritten immediately before every invocation, not only at
 * deploy time, so an env var edited in the dashboard takes effect on the next
 * start or restart — matching how process and docker services already behave.
 */
export async function runComposeCommand(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  subcommand: string,
  opts: {
    env: Record<string, string>;
    timeoutMs?: number;
    onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<ComposeRunResult> {
  const envFile = writeComposeEnvFile(ctx, serviceId, opts.env).path;
  const command = `${composeCommandPrefix(cfg, envFile)} ${subcommand}`;
  // `cfg.dir` as cwd keeps relative build contexts and bind mounts declared in
  // the compose file resolving exactly as they do when run there by hand.
  const result = await runCommand(command, cfg.dir, { ...process.env, ...opts.env }, {
    timeoutMs: opts.timeoutMs ?? COMPOSE_LIFECYCLE_TIMEOUT_MS,
    onChunk: opts.onChunk
  });
  return { ...result, command };
}

/** `docker compose build` — the deploy pipeline's build step for a compose service. */
export async function composeBuild(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>,
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<ComposeRunResult> {
  return runComposeCommand(ctx, serviceId, cfg, "build", {
    env,
    timeoutMs: COMPOSE_BUILD_TIMEOUT_MS,
    onChunk
  });
}

/**
 * `docker compose up -d --remove-orphans`.
 *
 * `--remove-orphans` clears containers for services deleted from the compose
 * file; without it they linger indefinitely, still holding their published
 * ports. Compose recreates only what actually changed, so a stack whose images
 * did not change keeps serving across this call.
 */
export async function composeUp(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>,
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<ComposeRunResult> {
  return runComposeCommand(ctx, serviceId, cfg, "up -d --remove-orphans", {
    env,
    timeoutMs: COMPOSE_UP_TIMEOUT_MS,
    onChunk
  });
}

/**
 * `docker compose stop` — stops the containers but keeps them, their network
 * and their volumes.
 *
 * Deliberately NOT `down`. `down` removes containers and the network, and is a
 * single flag (`-v`) away from destroying named volumes. A stack holding a
 * database has to survive stop/start, so `down` is wired to no routine
 * lifecycle action in this module at all.
 */
export async function composeStop(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>
): Promise<ComposeRunResult> {
  return runComposeCommand(ctx, serviceId, cfg, "stop", { env });
}

/** `docker compose restart` — signals existing containers, no rebuild. */
export async function composeRestart(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>
): Promise<ComposeRunResult> {
  return runComposeCommand(ctx, serviceId, cfg, "restart", { env });
}

/** `docker compose kill` — force-stop. Still never `down`, still never volumes. */
export async function composeKill(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>
): Promise<ComposeRunResult> {
  return runComposeCommand(ctx, serviceId, cfg, "kill", { env });
}

/** Current containers of the stack. Empty on any failure — never throws. */
export async function composePs(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>
): Promise<ComposeContainer[]> {
  try {
    const result = await runComposeCommand(ctx, serviceId, cfg, "ps --all --format json", {
      env,
      timeoutMs: COMPOSE_QUERY_TIMEOUT_MS
    });
    if (result.code !== 0) return [];
    return parseComposePs(result.output);
  } catch {
    return [];
  }
}

/** Recent log lines from every container in the stack. */
export async function composeLogs(
  ctx: AppContext,
  serviceId: string,
  cfg: ComposeConfig,
  env: Record<string, string>,
  tail = 200
): Promise<string> {
  const result = await runComposeCommand(
    ctx,
    serviceId,
    cfg,
    `logs --no-color --tail ${Number(tail) || 200}`,
    { env, timeoutMs: COMPOSE_QUERY_TIMEOUT_MS }
  );
  return result.output;
}

/**
 * Bring a compose service up, mirroring `startDockerService`'s status / log /
 * broadcast contract so the dashboard treats a compose service like any other.
 */
export async function startComposeService(
  ctx: AppContext,
  serviceId: string,
  env: Record<string, string>
): Promise<void> {
  const cfg = composeConfigFor(ctx, serviceId);
  if (!cfg) {
    throw new Error(
      "No compose file found for this service. Deploy it once so ServerHoster can clone the " +
        "repository, or set composeFile on the service to point at the stack."
    );
  }

  updateServiceStatus(ctx, serviceId, "starting");
  insertLog(ctx, serviceId, "info", `Starting compose project "${cfg.project}" from ${cfg.file}`);
  broadcast(ctx, {
    type: "service_lifecycle",
    serviceId,
    stage: "starting",
    composeProject: cfg.project
  });
  // Mirror the process and docker paths: a (re)start clears any lingering stop
  // intent, so a prior stop cannot leave a stale manuallyStopped entry behind.
  ctx.manuallyStopped.delete(serviceId);

  const result = await composeUp(ctx, serviceId, cfg, env, (chunk) => {
    const text = chunk.trimEnd();
    if (text) insertLog(ctx, serviceId, "info", text);
  });

  if (result.code !== 0) {
    updateServiceStatus(ctx, serviceId, "crashed", result.code);
    insertLog(ctx, serviceId, "error", `compose up failed (exit ${result.code})`);
    throw new Error(`docker compose up failed with exit code ${result.code}`);
  }

  // Record the resolved project and file on first successful start, which is
  // what makes the project name authoritative from then on. See
  // `resolveComposeProject` for why that matters.
  ctx.db
    .prepare("UPDATE services SET compose_project = ?, compose_file = ? WHERE id = ?")
    .run(cfg.project, cfg.file, serviceId);

  updateServiceStatus(ctx, serviceId, "running", 0);
  insertLog(ctx, serviceId, "info", `Compose project "${cfg.project}" is up.`);
}

/** Stop every container in the stack, keeping containers, network and volumes. */
export async function stopComposeService(
  ctx: AppContext,
  serviceId: string,
  env: Record<string, string>
): Promise<void> {
  const cfg = composeConfigFor(ctx, serviceId);
  if (!cfg) return;
  const result = await composeStop(ctx, serviceId, cfg, env);
  if (result.code !== 0) insertLog(ctx, serviceId, "warn", `compose stop exited ${result.code}`);
}

/** Force-stop: SIGKILL the containers. Cannot remove a volume. */
export async function forceStopComposeService(
  ctx: AppContext,
  serviceId: string,
  env: Record<string, string>
): Promise<void> {
  const cfg = composeConfigFor(ctx, serviceId);
  if (!cfg) return;
  const result = await composeKill(ctx, serviceId, cfg, env);
  if (result.code !== 0) insertLog(ctx, serviceId, "warn", `compose kill exited ${result.code}`);
}

/**
 * Observed status of a compose stack, for the periodic reconciliation sweep.
 *
 * Returns null when the stack cannot be inspected at all, which the caller MUST
 * treat as "no information" rather than as "stopped" — a transient docker
 * hiccup should never flip a healthy service to stopped and trigger a restart.
 */
export async function observeComposeStatus(
  ctx: AppContext,
  serviceId: string,
  env: Record<string, string>
): Promise<"running" | "stopped" | "crashed" | null> {
  const cfg = composeConfigFor(ctx, serviceId);
  if (!cfg) return null;
  const containers = await composePs(ctx, serviceId, cfg, env);
  if (containers.length === 0) return null;
  return composeStatusFrom(containers);
}
