import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import simpleGit from "simple-git";
import type { AppContext } from "../types.js";
import { broadcast, ensureDir, getServiceEnv, insertLog, nowIso, serializeError } from "../lib/core.js";
import { decryptSecret } from "../security.js";
import { buildGitEnv, getSecretSetting, injectGitCredentials } from "./settings.js";
import { createNotification } from "./notifications.js";
import type { CiSandbox as DockerSandbox } from "./ciDocker.js";
import {
  CI_CONFIG_PATH,
  DEFAULT_CI_CPUS,
  DEFAULT_CI_IMAGE,
  DEFAULT_CI_MEMORY_MB,
  DEFAULT_CI_TIMEOUT_MINUTES,
  EXAMPLE_CI_YAML,
  type CiConfig,
  type CiPlan,
  CiConfigError,
  assertImageRef,
  buildCiEnv,
  capLog,
  commitsMatch,
  createLogRedactor,
  parseCiConfig,
  planForPipeline,
  redactSecrets,
  sanitizeLogChunk,
  stripGitCredentials
} from "./ciConfig.js";

export { CI_CONFIG_PATH, EXAMPLE_CI_YAML, CiConfigError, assertImageRef, parseCiConfig, planForPipeline };
export type { CiPlan, CiConfig };

const CI_MAX_CONCURRENT = 1;

export const CI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ci_pipelines (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  gate_deploy INTEGER NOT NULL DEFAULT 0,
  config_source TEXT NOT NULL DEFAULT 'repo',
  inline_config TEXT,
  image TEXT NOT NULL DEFAULT 'node:22-bookworm',
  timeout_minutes INTEGER NOT NULL DEFAULT 20,
  memory_mb INTEGER NOT NULL DEFAULT 2048,
  cpus REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ci_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  commit_hash TEXT,
  branch TEXT,
  status TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  deploy_after INTEGER NOT NULL DEFAULT 0,
  deploy_status TEXT,
  config_snapshot TEXT,
  setup_log TEXT NOT NULL DEFAULT '',
  failure_step TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ci_runs_service ON ci_runs(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_runs_pipeline ON ci_runs(pipeline_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ci_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  log TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ci_steps_run ON ci_run_steps(run_id, position);
`;

type DbLike = { exec(sql: string): void };

export function ensureCiSchema(db: DbLike): void {
  db.exec(CI_SCHEMA);
}

type PipelineRow = {
  id: string;
  service_id: string;
  name: string;
  enabled: number;
  gate_deploy: number;
  config_source: string;
  inline_config: string | null;
  image: string;
  timeout_minutes: number;
  memory_mb: number;
  cpus: number;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  pipeline_id: string;
  service_id: string;
  commit_hash: string | null;
  branch: string | null;
  status: string;
  trigger_source: string;
  deploy_after: number;
  deploy_status: string | null;
  config_snapshot: string | null;
  setup_log: string;
  failure_step: string | null;
  error: string | null;
  cancel_requested: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type CiTrigger = "manual" | "gitops-poller" | "webhook";

export type CheckoutInput = {
  dir: string;
  repoUrl: string;
  branch: string;
  commit: string | null;
  gitEnv: NodeJS.ProcessEnv;
  redactions: string[];
  signal?: AbortSignal;
};

export type CiDeployInput = {
  serviceId: string;
  repoUrl: string;
  branch: string;
  trigger: CiTrigger;
  commit: string | null;
};

export type CiRunDeps = {
  sandbox?: DockerSandbox;
  checkout?: (input: CheckoutInput) => Promise<void>;
  remoteHead?: (repoUrl: string, branch: string) => Promise<string | null>;
  deploy?: (input: CiDeployInput) => Promise<{ status: string } | void>;
};

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function workRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataRoot, "ci-workspaces");
}

function defaultsOf(pipeline: PipelineRow) {
  return {
    image: pipeline.image || DEFAULT_CI_IMAGE,
    timeoutMinutes: pipeline.timeout_minutes || DEFAULT_CI_TIMEOUT_MINUTES,
    memoryMb: pipeline.memory_mb || DEFAULT_CI_MEMORY_MB,
    cpus: pipeline.cpus || DEFAULT_CI_CPUS
  };
}

function emitRun(ctx: AppContext, runId: string, status: string, serviceId: string): void {
  broadcast(ctx, { type: "ci_run", runId, status, serviceId });
}

export function listCiPipelines(ctx: AppContext) {
  const pipelines = ctx.db
    .prepare(
      `SELECT p.*, s.name AS service_name, s.github_repo_url, s.github_branch,
              (SELECT status FROM ci_runs r WHERE r.pipeline_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_status,
              (SELECT created_at FROM ci_runs r WHERE r.pipeline_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_run_at,
              (SELECT commit_hash FROM ci_runs r WHERE r.pipeline_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_commit
       FROM ci_pipelines p
       JOIN services s ON s.id = p.service_id
       ORDER BY p.updated_at DESC`
    )
    .all();
  const attachableServices = ctx.db
    .prepare(
      `SELECT id, name, github_repo_url, github_branch FROM services
       WHERE github_repo_url IS NOT NULL AND trim(github_repo_url) != ''
         AND id NOT IN (SELECT service_id FROM ci_pipelines)
       ORDER BY name`
    )
    .all();
  return { pipelines, attachableServices, exampleYaml: EXAMPLE_CI_YAML };
}

export function listCiRuns(ctx: AppContext, limit = 40) {
  const capped = Math.min(Math.max(limit, 1), 100);
  return ctx.db
    .prepare(
      `SELECT r.id, r.pipeline_id, r.service_id, s.name AS service_name, r.commit_hash, r.branch,
              r.status, r.trigger_source, r.deploy_after, r.deploy_status, r.failure_step, r.error,
              r.started_at, r.finished_at, r.created_at
       FROM ci_runs r
       LEFT JOIN services s ON s.id = r.service_id
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(capped);
}

export function getCiRun(ctx: AppContext, runId: string) {
  const run = ctx.db
    .prepare(
      `SELECT r.*, s.name AS service_name
       FROM ci_runs r
       LEFT JOIN services s ON s.id = r.service_id
       WHERE r.id = ?`
    )
    .get(runId);
  if (!run) throw httpError(404, "CI run not found");
  const steps = ctx.db
    .prepare("SELECT * FROM ci_run_steps WHERE run_id = ? ORDER BY position ASC")
    .all(runId);
  return { ...(run as RunRow), steps };
}

export type PipelineInput = {
  serviceId?: string;
  name?: string;
  enabled?: boolean;
  gateDeploy?: boolean;
  configSource?: "repo" | "inline";
  inlineConfig?: string | null;
  image?: string;
  timeoutMinutes?: number;
  memoryMb?: number;
  cpus?: number;
};

function validatePipelineConfig(input: PipelineInput, current?: PipelineRow): void {
  const image = input.image ?? current?.image ?? DEFAULT_CI_IMAGE;
  assertImageRef(image);
  const source = input.configSource ?? current?.config_source ?? "repo";
  const inline = input.inlineConfig === undefined ? current?.inline_config : input.inlineConfig;
  if (source === "inline") {
    parseCiConfig(inline ?? "", {
      image,
      timeoutMinutes: input.timeoutMinutes ?? current?.timeout_minutes ?? DEFAULT_CI_TIMEOUT_MINUTES,
      memoryMb: input.memoryMb ?? current?.memory_mb ?? DEFAULT_CI_MEMORY_MB,
      cpus: input.cpus ?? current?.cpus ?? DEFAULT_CI_CPUS
    });
  }
}

export function createCiPipeline(ctx: AppContext, input: PipelineInput) {
  if (!input.serviceId) throw httpError(400, "Pick a service to attach CI to.");
  const service = ctx.db
    .prepare("SELECT id, name, github_repo_url FROM services WHERE id = ?")
    .get(input.serviceId) as { id: string; name: string; github_repo_url?: string | null } | undefined;
  if (!service) throw httpError(404, "Service not found");
  if (!service.github_repo_url)
    throw httpError(400, "Link the service to a GitHub repository before enabling CI.");
  const existing = ctx.db.prepare("SELECT id FROM ci_pipelines WHERE service_id = ?").get(service.id) as
    | { id: string }
    | undefined;
  if (existing) throw httpError(409, "This service already has a CI pipeline.");
  validatePipelineConfig(input);
  const now = nowIso();
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO ci_pipelines
       (id, service_id, name, enabled, gate_deploy, config_source, inline_config, image, timeout_minutes, memory_mb, cpus, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      service.id,
      (input.name ?? `${service.name} CI`).slice(0, 80),
      input.enabled === false ? 0 : 1,
      input.gateDeploy ? 1 : 0,
      input.configSource ?? "repo",
      input.inlineConfig ?? null,
      assertImageRef(input.image ?? DEFAULT_CI_IMAGE),
      input.timeoutMinutes ?? DEFAULT_CI_TIMEOUT_MINUTES,
      input.memoryMb ?? DEFAULT_CI_MEMORY_MB,
      input.cpus ?? DEFAULT_CI_CPUS,
      now,
      now
    );
  return { id };
}

export function updateCiPipeline(ctx: AppContext, id: string, input: PipelineInput) {
  const current = ctx.db.prepare("SELECT * FROM ci_pipelines WHERE id = ?").get(id) as
    | PipelineRow
    | undefined;
  if (!current) throw httpError(404, "CI pipeline not found");
  validatePipelineConfig(input, current);
  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE ci_pipelines SET
         name = ?, enabled = ?, gate_deploy = ?, config_source = ?, inline_config = ?,
         image = ?, timeout_minutes = ?, memory_mb = ?, cpus = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      input.name ?? current.name,
      input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      input.gateDeploy === undefined ? current.gate_deploy : input.gateDeploy ? 1 : 0,
      input.configSource ?? current.config_source,
      input.inlineConfig === undefined ? current.inline_config : input.inlineConfig,
      assertImageRef(input.image ?? current.image),
      input.timeoutMinutes ?? current.timeout_minutes,
      input.memoryMb ?? current.memory_mb,
      input.cpus ?? current.cpus,
      now,
      id
    );
  return { id };
}

export function deleteCiPipeline(ctx: AppContext, id: string): void {
  const current = ctx.db.prepare("SELECT id FROM ci_pipelines WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (!current) throw httpError(404, "CI pipeline not found");
  const active = ctx.db
    .prepare("SELECT id FROM ci_runs WHERE pipeline_id = ? AND status IN ('queued', 'running') LIMIT 1")
    .get(id) as { id: string } | undefined;
  if (active) throw httpError(409, "Cancel the queued or running job before deleting this pipeline.");
  const runIds = ctx.db.prepare("SELECT id FROM ci_runs WHERE pipeline_id = ?").all(id) as Array<{
    id: string;
  }>;
  for (const run of runIds) {
    ctx.db.prepare("DELETE FROM ci_run_steps WHERE run_id = ?").run(run.id);
  }
  ctx.db.prepare("DELETE FROM ci_runs WHERE pipeline_id = ?").run(id);
  ctx.db.prepare("DELETE FROM ci_pipelines WHERE id = ?").run(id);
}

function trimRunHistory(ctx: AppContext, pipelineId: string): void {
  const stale = ctx.db
    .prepare(
      `SELECT id FROM ci_runs
       WHERE pipeline_id = ? AND status NOT IN ('queued', 'running')
         AND id NOT IN (
           SELECT id FROM ci_runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 40
         )`
    )
    .all(pipelineId, pipelineId) as Array<{ id: string }>;
  for (const run of stale) {
    ctx.db.prepare("DELETE FROM ci_run_steps WHERE run_id = ?").run(run.id);
    ctx.db.prepare("DELETE FROM ci_runs WHERE id = ?").run(run.id);
  }
}

export function enqueueCiRun(
  ctx: AppContext,
  input: {
    serviceId: string;
    commit: string | null;
    branch: string;
    trigger: CiTrigger;
    deployAfter: boolean;
  }
): { id: string; deduped: boolean } {
  const pipeline = ctx.db.prepare("SELECT * FROM ci_pipelines WHERE service_id = ?").get(input.serviceId) as
    | PipelineRow
    | undefined;
  if (!pipeline || !pipeline.enabled) throw httpError(409, "CI is not enabled for this service.");
  const commit = input.commit?.trim() ? input.commit.trim() : null;
  if (commit) {
    const existing = ctx.db
      .prepare(
        `SELECT id, deploy_after FROM ci_runs
         WHERE service_id = ? AND commit_hash = ? AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(input.serviceId, commit) as { id: string; deploy_after: number } | undefined;
    if (existing) {
      if (input.deployAfter && !existing.deploy_after) {
        ctx.db.prepare("UPDATE ci_runs SET deploy_after = 1 WHERE id = ?").run(existing.id);
      }
      return { id: existing.id, deduped: true };
    }
  }
  const now = nowIso();
  const id = nanoid();
  ctx.db
    .prepare(
      `UPDATE ci_runs SET status = 'cancelled', finished_at = ?, error = 'Superseded by a newer commit', cancel_requested = 1
       WHERE pipeline_id = ? AND status = 'queued'`
    )
    .run(now, pipeline.id);
  ctx.db
    .prepare(
      `INSERT INTO ci_runs
       (id, pipeline_id, service_id, commit_hash, branch, status, trigger_source, deploy_after, setup_log, cancel_requested, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '', 0, ?)`
    )
    .run(
      id,
      pipeline.id,
      input.serviceId,
      commit,
      input.branch,
      input.trigger,
      input.deployAfter ? 1 : 0,
      now
    );
  trimRunHistory(ctx, pipeline.id);
  emitRun(ctx, id, "queued", input.serviceId);
  kickCi(ctx);
  return { id, deduped: false };
}

/**
 * Called when GitOps or a GitHub push webhook sees a new commit.
 * Returns the plan the caller should follow. A gate does not deploy here;
 * the runner deploys after the job passes, and only if the branch still
 * points at the commit that was tested.
 */
export function handleIncomingCommit(
  ctx: AppContext,
  input: {
    serviceId: string;
    repoUrl: string;
    branch: string;
    commit: string;
    trigger: "gitops-poller" | "webhook";
  }
): CiPlan {
  const pipeline = ctx.db
    .prepare("SELECT enabled, gate_deploy FROM ci_pipelines WHERE service_id = ?")
    .get(input.serviceId) as { enabled: number; gate_deploy: number } | undefined;
  const plan = planForPipeline(pipeline);
  if (plan === "deploy-only") return plan;
  enqueueCiRun(ctx, {
    serviceId: input.serviceId,
    commit: input.commit,
    branch: input.branch,
    trigger: input.trigger,
    deployAfter: plan === "ci-then-deploy"
  });
  return plan;
}

export async function queueManualCiRun(ctx: AppContext, pipelineId: string): Promise<{ id: string }> {
  const pipeline = ctx.db.prepare("SELECT * FROM ci_pipelines WHERE id = ?").get(pipelineId) as
    | PipelineRow
    | undefined;
  if (!pipeline) throw httpError(404, "CI pipeline not found");
  if (!pipeline.enabled) throw httpError(409, "Enable the pipeline before running it.");
  const service = ctx.db
    .prepare("SELECT github_repo_url, github_branch FROM services WHERE id = ?")
    .get(pipeline.service_id) as
    | { github_repo_url?: string | null; github_branch?: string | null }
    | undefined;
  if (!service?.github_repo_url) throw httpError(400, "The service is no longer linked to a repository.");
  const branch = service.github_branch || "main";
  let commit: string | null = null;
  try {
    commit = await remoteHead(ctx, service.github_repo_url, branch);
  } catch {
    commit = null;
  }
  const queued = enqueueCiRun(ctx, {
    serviceId: pipeline.service_id,
    commit,
    branch,
    trigger: "manual",
    deployAfter: false
  });
  return { id: queued.id };
}

export function requestCancelCiRun(ctx: AppContext, runId: string): void {
  const run = ctx.db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) throw httpError(404, "CI run not found");
  if (run.status !== "queued" && run.status !== "running") {
    throw httpError(409, "This run has already finished.");
  }
  const now = nowIso();
  if (run.status === "queued") {
    ctx.db
      .prepare(
        `UPDATE ci_runs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, error = 'Cancelled' WHERE id = ?`
      )
      .run(now, runId);
    emitRun(ctx, runId, "cancelled", run.service_id);
    return;
  }
  ctx.db.prepare("UPDATE ci_runs SET cancel_requested = 1 WHERE id = ?").run(runId);
}

function projectSecrets(ctx: AppContext, projectId: string | null): Record<string, string> {
  if (!projectId) return {};
  let rows: Array<{ key: string; value: string; is_secret: number }> = [];
  try {
    rows = ctx.db
      .prepare("SELECT key, value, is_secret FROM project_env_vars WHERE project_id = ?")
      .all(projectId) as Array<{ key: string; value: string; is_secret: number }>;
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.key] = row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value;
  }
  return out;
}

function secretBag(ctx: AppContext, serviceId: string, projectId: string | null): Record<string, string> {
  return { ...projectSecrets(ctx, projectId), ...getServiceEnv(ctx, serviceId, true) };
}

function githubPat(ctx: AppContext): string | null {
  try {
    return getSecretSetting(ctx, "github_pat");
  } catch {
    return null;
  }
}

async function remoteHead(ctx: AppContext, repoUrl: string, branch: string): Promise<string | null> {
  const git = simpleGit().env(buildGitEnv(ctx) as Record<string, string>);
  const authed = injectGitCredentials(ctx, repoUrl);
  const remotes = await git.listRemote(["--heads", authed, branch]);
  return remotes.split("\t")[0]?.trim() || null;
}

class CiAbortError extends Error {
  constructor() {
    super("CI stopped");
    this.name = "CiAbortError";
  }
}

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CiAbortError());
      return;
    }
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    const kill = () => {
      child.kill();
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", kill);
      if (options.signal?.aborted) {
        reject(new CiAbortError());
        return;
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} exited ${code}`));
    });
  });
}

export async function checkoutCiWorkspace(input: CheckoutInput): Promise<void> {
  if (input.signal?.aborted) throw new CiAbortError();
  await fs.promises.rm(input.dir, { recursive: true, force: true });
  if (input.signal?.aborted) throw new CiAbortError();
  ensureDir(path.dirname(input.dir));
  const env = input.gitEnv;
  const gitError = (error: unknown): Error => {
    if (error instanceof CiAbortError) return error;
    return new Error(redactSecrets(serializeError(error), input.redactions));
  };
  try {
    await runGit(
      ["clone", "--branch", input.branch, "--single-branch", "--depth", "1", input.repoUrl, input.dir],
      { env, signal: input.signal }
    );
  } catch (error) {
    throw gitError(error);
  }
  if (input.commit) {
    const head = (await runGit(["rev-parse", "HEAD"], { cwd: input.dir, env, signal: input.signal })).trim();
    if (!commitsMatch(head, input.commit)) {
      try {
        await runGit(["fetch", "--depth", "1", "origin", input.commit], {
          cwd: input.dir,
          env,
          signal: input.signal
        });
        await runGit(["checkout", "--detach", input.commit], { cwd: input.dir, env, signal: input.signal });
      } catch (error) {
        throw gitError(error);
      }
    }
  }
  const publicUrl = stripGitCredentials(input.repoUrl);
  try {
    await runGit(["remote", "set-url", "origin", publicUrl], { cwd: input.dir, env, signal: input.signal });
  } catch (error) {
    throw gitError(error);
  }
}

function safeRemoveWorkspace(ctx: AppContext, dir: string): void {
  const root = path.resolve(workRoot(ctx));
  const target = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function isCancelled(ctx: AppContext, runId: string): boolean {
  const row = ctx.db.prepare("SELECT cancel_requested FROM ci_runs WHERE id = ?").get(runId) as
    | { cancel_requested: number }
    | undefined;
  return !row || row.cancel_requested === 1;
}

function hasNewerActiveRun(ctx: AppContext, run: RunRow): boolean {
  const newer = ctx.db
    .prepare(
      `SELECT id FROM ci_runs
       WHERE service_id = ? AND id != ? AND created_at > ? AND status IN ('queued', 'running')
       LIMIT 1`
    )
    .get(run.service_id, run.id, run.created_at) as { id: string } | undefined;
  return Boolean(newer);
}

async function defaultSandbox(ctx: AppContext): Promise<DockerSandbox> {
  const { dockerCiSandbox } = await import("./ciDocker.js");
  return dockerCiSandbox(ctx.docker);
}

async function defaultDeploy(ctx: AppContext, input: CiDeployInput): Promise<{ status: string }> {
  const { deployFromGit, applyPostDeployServiceState } = await import("./deploy.js");
  const trigger = input.trigger === "manual" ? "gitops-poller" : input.trigger;
  const deployment = await deployFromGit(ctx, input.serviceId, input.repoUrl, input.branch, trigger, {
    commit: input.commit
  });
  await applyPostDeployServiceState(ctx, input.serviceId, deployment, { startAfterDeploy: true });
  if (deployment.status !== "success") {
    const log = deployment.build_log?.trim() ?? "";
    const tail = log ? log.split("\n").slice(-5).join("\n") : "Deploy failed";
    throw new Error(tail.slice(0, 1500));
  }
  return deployment;
}

function serviceLog(
  ctx: AppContext,
  serviceId: string,
  level: "info" | "warn" | "error",
  message: string
): void {
  try {
    insertLog(ctx, serviceId, level, message);
  } catch {
    /* a missing logs table must not fail the CI result */
  }
}

function notify(
  ctx: AppContext,
  input: { severity: "success" | "error" | "warning"; title: string; body: string; serviceId: string }
): void {
  try {
    createNotification(ctx, { kind: "deployment", ...input });
  } catch {
    /* notifications are best-effort */
  }
}

export async function executeCiRun(ctx: AppContext, runId: string, deps: CiRunDeps = {}): Promise<void> {
  const run = ctx.db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run || run.status !== "running") return;
  const pipeline = ctx.db.prepare("SELECT * FROM ci_pipelines WHERE id = ?").get(run.pipeline_id) as
    | PipelineRow
    | undefined;
  const service = ctx.db
    .prepare("SELECT id, name, project_id, github_repo_url, github_branch FROM services WHERE id = ?")
    .get(run.service_id) as
    | {
        id: string;
        name: string;
        project_id?: string | null;
        github_repo_url?: string | null;
        github_branch?: string | null;
      }
    | undefined;

  const workspace = path.join(workRoot(ctx), runId);
  const fail = (message: string, failureStep: string | null = null) => {
    const now = nowIso();
    ctx.db
      .prepare(
        `UPDATE ci_run_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running')`
      )
      .run(now, runId);
    ctx.db
      .prepare(
        `UPDATE ci_runs SET status = 'failed', error = ?, failure_step = ?, finished_at = ? WHERE id = ? AND status = 'running'`
      )
      .run(message.slice(0, 2000), failureStep, now, runId);
    emitRun(ctx, runId, "failed", run.service_id);
    serviceLog(ctx, run.service_id, "error", `CI failed: ${message}`);
    notify(ctx, {
      severity: "error",
      title: `CI failed${service?.name ? `: ${service.name}` : ""}`,
      body: message,
      serviceId: run.service_id
    });
  };

  const started = Date.now();
  const abort = new AbortController();
  let timeoutMinutes = pipeline?.timeout_minutes || DEFAULT_CI_TIMEOUT_MINUTES;
  let stopWatch: ReturnType<typeof setInterval> | undefined;
  let finishLogs = (): void => undefined;

  try {
    if (!pipeline || !service?.github_repo_url) {
      fail("The pipeline or its repository is gone.");
      return;
    }
    if (isCancelled(ctx, runId)) {
      markCancelled(ctx, run);
      return;
    }

    stopWatch = setInterval(() => {
      if (abort.signal.aborted) return;
      if (isCancelled(ctx, runId)) abort.abort();
      else if (Date.now() - started >= timeoutMinutes * 60_000) abort.abort();
    }, 250);
    stopWatch.unref();

    const branch = run.branch || service.github_branch || "main";
    const pat = githubPat(ctx);
    const authedUrl = injectGitCredentials(ctx, service.github_repo_url);
    const redactions = [pat, authedUrl].filter((value): value is string => Boolean(value));
    serviceLog(
      ctx,
      service.id,
      "info",
      `CI: checking out ${branch}${run.commit_hash ? ` @ ${run.commit_hash.slice(0, 7)}` : ""}.`
    );
    const checkout = deps.checkout ?? checkoutCiWorkspace;
    await checkout({
      dir: workspace,
      repoUrl: authedUrl,
      branch,
      commit: run.commit_hash,
      gitEnv: buildGitEnv(ctx),
      redactions,
      signal: abort.signal
    });

    let source = pipeline.inline_config ?? "";
    if (pipeline.config_source !== "inline") {
      const filePath = path.join(workspace, CI_CONFIG_PATH);
      if (!fs.existsSync(filePath)) {
        fail(`No ${CI_CONFIG_PATH} in this commit. Add that file, or switch the pipeline to inline config.`);
        return;
      }
      source = fs.readFileSync(filePath, "utf8");
    }
    const config = parseCiConfig(source, defaultsOf(pipeline));
    timeoutMinutes = config.timeoutMinutes;
    if (isCancelled(ctx, runId)) {
      markCancelled(ctx, run);
      return;
    }
    if (abort.signal.aborted || Date.now() - started >= timeoutMinutes * 60_000) {
      fail(`Timed out after ${timeoutMinutes} minutes.`, "timeout");
      return;
    }
    ctx.db.prepare("UPDATE ci_runs SET config_snapshot = ? WHERE id = ?").run(
      JSON.stringify({
        image: config.image,
        timeoutMinutes: config.timeoutMinutes,
        memoryMb: config.memoryMb,
        cpus: config.cpus,
        steps: config.steps.map((step) => step.name),
        secrets: config.secrets
      }),
      runId
    );

    config.steps.forEach((step, position) => {
      ctx.db
        .prepare(
          `INSERT INTO ci_run_steps (id, run_id, position, name, status, log, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'pending', '', NULL, NULL)`
        )
        .run(nanoid(), runId, position, step.name);
    });

    const available = secretBag(ctx, service.id, service.project_id ?? null);
    const built = buildCiEnv(config, available, {
      commit: run.commit_hash,
      branch,
      serviceName: service.name
    });
    const hide = [...redactions, ...built.redactions];
    const logs = new Map<number, string>();
    let lastFlush = 0;
    const stepId = (position: number): string | undefined => {
      const row = ctx.db
        .prepare("SELECT id FROM ci_run_steps WHERE run_id = ? AND position = ?")
        .get(runId, position) as { id: string } | undefined;
      return row?.id;
    };
    const flush = (force: boolean) => {
      const at = Date.now();
      if (!force && at - lastFlush < 1000) return;
      lastFlush = at;
      const setup = logs.get(-1);
      if (setup !== undefined)
        ctx.db.prepare("UPDATE ci_runs SET setup_log = ? WHERE id = ?").run(setup, runId);
      for (const [position, text] of logs) {
        if (position < 0) continue;
        ctx.db
          .prepare("UPDATE ci_run_steps SET log = ? WHERE run_id = ? AND position = ?")
          .run(text, runId, position);
      }
    };
    const redactors = new Map<number, ReturnType<typeof createLogRedactor>>();
    const publish = (position: number, clean: string) => {
      if (!clean) return;
      logs.set(position, capLog(logs.get(position) ?? "", clean));
      broadcast(ctx, {
        type: "ci_log",
        runId,
        stepId: position < 0 ? null : stepId(position),
        stepIndex: position,
        line: clean,
        timestamp: Date.now()
      });
      flush(false);
    };
    const write = (position: number, chunk: string) => {
      let redactor = redactors.get(position);
      if (!redactor) {
        redactor = createLogRedactor(hide);
        redactors.set(position, redactor);
      }
      publish(position, redactor.push(sanitizeLogChunk(chunk)));
    };
    finishLogs = () => {
      for (const [position, redactor] of redactors) publish(position, redactor.flush());
      flush(true);
    };

    const sandbox = deps.sandbox ?? (await defaultSandbox(ctx));
    const remaining = Math.max(1_000, timeoutMinutes * 60_000 - (Date.now() - started));
    const result = await sandbox.run({
      runId,
      image: config.image,
      workspace,
      env: built.env,
      timeoutMs: remaining,
      signal: abort.signal,
      memoryMb: config.memoryMb,
      cpus: config.cpus,
      steps: config.steps,
      onSetupLog: (chunk) => write(-1, chunk),
      onLog: (index, chunk) => write(index, chunk),
      onStep: (index, status, exitCode) => {
        const stamp = nowIso();
        ctx.db
          .prepare(
            `UPDATE ci_run_steps SET status = ?, exit_code = ?,
               started_at = COALESCE(started_at, ?),
               finished_at = CASE WHEN ? IN ('passed', 'failed', 'skipped') THEN ? ELSE finished_at END
             WHERE run_id = ? AND position = ?`
          )
          .run(status, exitCode, stamp, status, stamp, runId, index);
      },
      isCancelled: () => isCancelled(ctx, runId)
    });
    finishLogs();

    if (result.cancelled || isCancelled(ctx, runId)) {
      markCancelled(ctx, run);
      return;
    }
    if (result.timedOut) {
      fail(`Timed out after ${config.timeoutMinutes} minutes.`, "timeout");
      return;
    }
    if (result.failedStep !== null) {
      const name = config.steps[result.failedStep]?.name ?? "step";
      fail(`Step "${name}" failed.`, name);
      return;
    }

    ctx.db
      .prepare(`UPDATE ci_runs SET status = 'passed', finished_at = ?, error = NULL WHERE id = ?`)
      .run(nowIso(), runId);
    emitRun(ctx, runId, "passed", run.service_id);
    serviceLog(
      ctx,
      service.id,
      "info",
      `CI passed${run.commit_hash ? ` for ${run.commit_hash.slice(0, 7)}` : ""}.`
    );
    notify(ctx, {
      severity: "success",
      title: `CI passed: ${service.name}`,
      body: run.commit_hash ? `Commit ${run.commit_hash.slice(0, 7)} on ${branch}.` : `Branch ${branch}.`,
      serviceId: service.id
    });

    const fresh = ctx.db.prepare("SELECT deploy_after FROM ci_runs WHERE id = ?").get(runId) as
      | { deploy_after: number }
      | undefined;
    if (fresh?.deploy_after) {
      ctx.db.prepare("UPDATE ci_runs SET deploy_status = 'pending' WHERE id = ?").run(runId);
      await deployIfCurrent(
        ctx,
        { ...run, branch, deploy_after: fresh.deploy_after },
        service.github_repo_url,
        deps
      );
    }
  } catch (error) {
    if (isCancelled(ctx, runId)) markCancelled(ctx, run);
    else if (abort.signal.aborted || error instanceof CiAbortError) {
      fail(`Timed out after ${timeoutMinutes} minutes.`, "timeout");
    } else {
      fail(redactSecrets(serializeError(error), [githubPat(ctx)]));
    }
  } finally {
    if (stopWatch) clearInterval(stopWatch);
    finishLogs();
    safeRemoveWorkspace(ctx, workspace);
  }
}

function markCancelled(ctx: AppContext, run: RunRow): void {
  ctx.db
    .prepare(
      `UPDATE ci_runs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, error = 'Cancelled'
       WHERE id = ? AND status IN ('queued', 'running')`
    )
    .run(nowIso(), run.id);
  emitRun(ctx, run.id, "cancelled", run.service_id);
  serviceLog(ctx, run.service_id, "warn", "CI run cancelled.");
}

async function deployIfCurrent(
  ctx: AppContext,
  run: RunRow,
  repoUrl: string,
  deps: CiRunDeps
): Promise<void> {
  const branch = run.branch || "main";
  if (draining) {
    ctx.db.prepare("UPDATE ci_runs SET deploy_status = 'skipped' WHERE id = ?").run(run.id);
    serviceLog(ctx, run.service_id, "warn", "CI passed while ServerHoster is shutting down — not deploying.");
    return;
  }
  if (hasNewerActiveRun(ctx, run)) {
    ctx.db.prepare("UPDATE ci_runs SET deploy_status = 'skipped' WHERE id = ?").run(run.id);
    serviceLog(
      ctx,
      run.service_id,
      "info",
      "CI passed, but a newer commit is already queued — not deploying this one."
    );
    return;
  }
  try {
    const head = deps.remoteHead
      ? await deps.remoteHead(repoUrl, branch)
      : await remoteHead(ctx, repoUrl, branch);
    if (run.commit_hash && !commitsMatch(head, run.commit_hash)) {
      ctx.db.prepare("UPDATE ci_runs SET deploy_status = 'skipped' WHERE id = ?").run(run.id);
      serviceLog(
        ctx,
        run.service_id,
        "info",
        `CI passed for ${run.commit_hash.slice(0, 7)}, but ${branch} has moved. Waiting for the newer commit.`
      );
      return;
    }
    const deploy = deps.deploy ?? ((input) => defaultDeploy(ctx, input));
    const deployed = await deploy({
      serviceId: run.service_id,
      repoUrl,
      branch,
      trigger: (run.trigger_source as CiTrigger) || "gitops-poller",
      commit: run.commit_hash
    });
    if (deployed && deployed.status !== "success") {
      throw new Error("Deploy failed");
    }
    ctx.db.prepare("UPDATE ci_runs SET deploy_status = 'success' WHERE id = ?").run(run.id);
    serviceLog(ctx, run.service_id, "info", "CI passed — deploying this commit.");
  } catch (error) {
    const message = redactSecrets(serializeError(error), [githubPat(ctx)]);
    ctx.db
      .prepare("UPDATE ci_runs SET deploy_status = 'failed', error = ? WHERE id = ?")
      .run(message.slice(0, 2000), run.id);
    serviceLog(ctx, run.service_id, "error", `CI passed but deploy failed: ${message}`);
    notify(ctx, {
      severity: "error",
      title: "CI passed, deploy failed",
      body: message,
      serviceId: run.service_id
    });
  }
}

const inflight = new Set<string>();
const inflightJobs = new Map<string, Promise<void>>();
let filling = false;
let autostart = true;
let draining = false;

/** Tests disable this so queueing a run does not clone a repository. */
export function setCiAutostart(enabled: boolean): void {
  autostart = enabled;
  draining = false;
}

function claimNext(ctx: AppContext): string | null {
  for (;;) {
    const row = ctx.db
      .prepare(
        "SELECT id, service_id, cancel_requested FROM ci_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
      )
      .get() as { id: string; service_id: string; cancel_requested: number } | undefined;
    if (!row) return null;
    if (row.cancel_requested) {
      ctx.db
        .prepare(
          `UPDATE ci_runs SET status = 'cancelled', finished_at = ?, error = 'Cancelled' WHERE id = ? AND status = 'queued'`
        )
        .run(nowIso(), row.id);
      emitRun(ctx, row.id, "cancelled", row.service_id);
      continue;
    }
    const info = ctx.db
      .prepare(`UPDATE ci_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(nowIso(), row.id) as { changes?: number };
    if (!info.changes) continue;
    emitRun(ctx, row.id, "running", row.service_id);
    return row.id;
  }
}

function kickCi(ctx: AppContext): void {
  if (!autostart || draining || filling) return;
  filling = true;
  try {
    while (!draining && autostart && inflight.size < CI_MAX_CONCURRENT) {
      const id = claimNext(ctx);
      if (!id) return;
      inflight.add(id);
      const job = executeCiRun(ctx, id)
        .catch((error) => {
          try {
            ctx.app.log.error({ err: error }, "CI run failed");
          } catch {
            /* test contexts may not have a logger */
          }
        })
        .finally(() => {
          inflight.delete(id);
          inflightJobs.delete(id);
          kickCi(ctx);
        });
      inflightJobs.set(id, job);
    }
  } finally {
    filling = false;
  }
}

export function recoverCi(ctx: AppContext): void {
  ctx.db
    .prepare(`DELETE FROM ci_run_steps WHERE run_id IN (SELECT id FROM ci_runs WHERE status = 'running')`)
    .run();
  ctx.db
    .prepare(
      `UPDATE ci_runs SET status = 'queued', started_at = NULL, setup_log = '' WHERE status = 'running'`
    )
    .run();
}

export function startCiLoop(ctx: AppContext): () => Promise<void> {
  draining = false;
  autostart = true;
  ensureCiSchema(ctx.db);
  recoverCi(ctx);
  void import("./ciDocker.js")
    .then(({ removeCiContainers }) => removeCiContainers(ctx.docker))
    .catch(() => {
      /* Docker may be down; the run will say so when it starts */
    });
  const pending = ctx.db
    .prepare(
      `SELECT id FROM ci_runs WHERE status = 'passed' AND deploy_after = 1 AND deploy_status = 'pending'`
    )
    .all() as Array<{ id: string }>;
  for (const row of pending) {
    const run = ctx.db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(row.id) as RunRow;
    const service = ctx.db
      .prepare("SELECT github_repo_url FROM services WHERE id = ?")
      .get(run.service_id) as { github_repo_url?: string | null } | undefined;
    if (service?.github_repo_url) {
      void deployIfCurrent(ctx, run, service.github_repo_url, {}).catch(() => undefined);
    }
  }
  const timer = setInterval(() => kickCi(ctx), 2000);
  kickCi(ctx);
  return async () => {
    draining = true;
    autostart = false;
    clearInterval(timer);
    for (const id of inflight) {
      try {
        requestCancelCiRun(ctx, id);
      } catch {
        /* the run already finished */
      }
    }
    await Promise.allSettled([...inflightJobs.values()]);
    try {
      const { removeCiContainers } = await import("./ciDocker.js");
      await removeCiContainers(ctx.docker);
    } catch {
      /* Docker may already be down */
    }
  };
}
