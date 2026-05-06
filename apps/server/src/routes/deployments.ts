import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  applyPostDeployServiceState,
  deployFromGit,
  rollbackDeployment,
  stopServiceIfRunning
} from "../services/deploy.js";

const deploySchema = z.object({
  serviceId: z.string(),
  repoUrl: z.string().url().optional(),
  branch: z.string().optional()
});
const rollbackSchema = z.object({ serviceId: z.string(), deploymentId: z.string() });

export function registerDeploymentRoutes(ctx: AppContext): void {
  ctx.app.post("/deployments/from-git", async (req) => {
    const p = deploySchema.parse(req.body);
    const service = ctx.db
      .prepare("SELECT github_repo_url, github_branch FROM services WHERE id = ?")
      .get(p.serviceId) as { github_repo_url?: string; github_branch?: string } | undefined;
    const repoUrl = p.repoUrl || service?.github_repo_url;
    const branch = p.branch || service?.github_branch || "main";

    if (!repoUrl) throw new Error("repoUrl is required, and service has no github_repo_url");

    await stopServiceIfRunning(ctx, p.serviceId);
    const deployment = await deployFromGit(ctx, p.serviceId, repoUrl, branch, "manual");
    await applyPostDeployServiceState(ctx, p.serviceId, deployment, { startAfterDeploy: true });
    return deployment;
  });

  // Redeploy current branch HEAD for a service that already has a git repo.
  ctx.app.post("/services/:id/redeploy", async (req) => {
    const { id } = req.params as { id: string };
    const service = ctx.db
      .prepare("SELECT github_repo_url, github_branch FROM services WHERE id = ?")
      .get(id) as { github_repo_url?: string; github_branch?: string } | undefined;
    if (!service?.github_repo_url) throw new Error("Service has no github_repo_url — cannot redeploy");
    const branch = service.github_branch || "main";
    await stopServiceIfRunning(ctx, id);
    const deployment = await deployFromGit(ctx, id, service.github_repo_url, branch, "manual");
    await applyPostDeployServiceState(ctx, id, deployment, { startAfterDeploy: true });
    return deployment;
  });

  ctx.app.post("/deployments/rollback", async (req) => {
    const p = rollbackSchema.parse(req.body);
    return rollbackDeployment(ctx, p.serviceId, p.deploymentId);
  });

  ctx.app.get("/deployments", async () =>
    ctx.db.prepare("SELECT * FROM deployments ORDER BY created_at DESC").all()
  );

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
