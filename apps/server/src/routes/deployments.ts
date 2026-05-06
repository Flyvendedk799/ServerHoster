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
}
