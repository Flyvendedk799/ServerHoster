import { z } from "zod";
import type { AppContext } from "../types.js";
import { applyPostDeployServiceState, deployFromGit, rollbackDeployment } from "../services/deploy.js";
import { getGithubSyncStatus, getGithubSyncStatuses } from "../services/poller.js";

const deploySchema = z.object({
  serviceId: z.string(),
  // .trim() BEFORE .url(): zod's .url() delegates to the WHATWG URL parser,
  // which tolerates surrounding whitespace and then hands back the ORIGINAL
  // string. A pasted " https://github.com/..." therefore validated fine and was
  // stored verbatim, and every git call on it died with
  // `fatal: protocol ' https' is not supported` -- forever, since the GitOps
  // poller just retries the same stored value.
  repoUrl: z.string().trim().url().optional(),
  branch: z.string().trim().optional()
});
const rollbackSchema = z.object({ serviceId: z.string(), deploymentId: z.string() });
const deploymentsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  serviceId: z.string().trim().min(1).optional(),
  summary: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true")
});
const syncStatusBatchSchema = z.object({
  serviceIds: z.array(z.string()).max(50).default([])
});

export function registerDeploymentRoutes(ctx: AppContext): void {
  ctx.app.post("/deployments/from-git", async (req) => {
    const p = deploySchema.parse(req.body);
    const service = ctx.db
      .prepare("SELECT github_repo_url, github_branch FROM services WHERE id = ?")
      .get(p.serviceId) as { github_repo_url?: string; github_branch?: string } | undefined;
    const repoUrl = p.repoUrl || service?.github_repo_url;
    const branch = p.branch || service?.github_branch || "main";

    if (!repoUrl) throw new Error("repoUrl is required, and service has no github_repo_url");

    const deployment = await deployFromGit(ctx, p.serviceId, repoUrl, branch, "manual");
    await applyPostDeployServiceState(ctx, p.serviceId, deployment, { startAfterDeploy: true });
    return deployment;
  });

  ctx.app.post("/services/github-sync-statuses", async (req) => {
    const p = syncStatusBatchSchema.parse(req.body ?? {});
    return { items: await getGithubSyncStatuses(ctx, p.serviceIds) };
  });

  ctx.app.get("/services/:id/github-sync-status", async (req) => {
    const { id } = req.params as { id: string };
    return getGithubSyncStatus(ctx, id);
  });

  // Redeploy current branch HEAD for a service that already has a git repo.
  ctx.app.post("/services/:id/redeploy", async (req) => {
    const { id } = req.params as { id: string };
    const service = ctx.db
      .prepare("SELECT github_repo_url, github_branch FROM services WHERE id = ?")
      .get(id) as { github_repo_url?: string; github_branch?: string } | undefined;
    if (!service?.github_repo_url) throw new Error("Service has no github_repo_url — cannot redeploy");
    const branch = service.github_branch || "main";
    const deployment = await deployFromGit(ctx, id, service.github_repo_url, branch, "manual");
    await applyPostDeployServiceState(ctx, id, deployment, { startAfterDeploy: true });
    return deployment;
  });

  ctx.app.post("/deployments/rollback", async (req) => {
    const p = rollbackSchema.parse(req.body);
    return rollbackDeployment(ctx, p.serviceId, p.deploymentId);
  });

  // Optional query params keep this cheap for pollers: the full table with
  // every build_log was ~35 MB, and the dashboard re-fetched it on each
  // metrics sample (multiple TB/month of egress with one tab left open).
  //   ?limit=N      newest N rows (1..1000)
  //   ?serviceId=X  only deployments of one service
  //   ?summary=1    omit build_log
  // With no params the response is unchanged for existing API clients.
  ctx.app.get("/deployments", async (req) => {
    const q = deploymentsListQuery.parse(req.query ?? {});
    const where = q.serviceId ? "WHERE service_id = ?" : "";
    const limit = q.limit ? "LIMIT ?" : "";
    const params: Array<string | number> = [];
    if (q.serviceId) params.push(q.serviceId);
    if (q.limit) params.push(q.limit);
    const rows = ctx.db
      .prepare(`SELECT * FROM deployments ${where} ORDER BY created_at DESC ${limit}`)
      .all(...params) as Array<Record<string, unknown>>;
    if (!q.summary) return rows;
    return rows.map(({ build_log: _omit, ...rest }) => rest);
  });

  /**
   * Sequence 6 — service deployment timeline. Returns the last N
   * deployments for a service in chronological order with the canonical
   * state machine fields included so the dashboard can render a timeline
   * with root-cause hints (failure_stage), provenance (git_sha,
   * trigger_source) and timing (duration_ms).
   */
  ctx.app.get("/services/:id/deployments/timeline", async (req) => {
    const { id } = req.params as { id: string };
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    const rows = ctx.db
      .prepare(
        `SELECT id, service_id, commit_hash, git_sha, status, branch, trigger_source,
                started_at, finished_at, duration_ms, failure_stage, build_log
         FROM deployments
         WHERE service_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(id, Math.min(Math.max(limit, 1), 200)) as Array<{
      id: string;
      service_id: string;
      commit_hash: string | null;
      git_sha: string | null;
      status: string;
      branch: string | null;
      trigger_source: string | null;
      started_at: string | null;
      finished_at: string | null;
      duration_ms: number | null;
      failure_stage: string | null;
      build_log: string | null;
    }>;
    return {
      serviceId: id,
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        branch: r.branch,
        gitSha: r.git_sha ?? r.commit_hash,
        trigger: r.trigger_source ?? "manual",
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationMs: r.duration_ms,
        failureStage: r.failure_stage,
        rootCauseHint: rootCauseFor(r.failure_stage, r.build_log)
      }))
    };
  });
}

function rootCauseFor(stage: string | null, buildLog: string | null): string | null {
  if (!stage) return null;
  const tail = (buildLog ?? "").split("\n").slice(-6).join("\n").trim();
  switch (stage) {
    case "cloning":
      return `Git clone/fetch failed. Likely causes: bad PAT, missing branch, network timeout. Tail:\n${tail}`;
    case "building":
      return `Build step failed. Likely causes: missing dependency, failing test, Dockerfile error. Tail:\n${tail}`;
    case "starting":
      return `Service failed to start after build. Likely causes: port conflict, healthcheck timeout, runtime crash. Tail:\n${tail}`;
    default:
      return tail || null;
  }
}
