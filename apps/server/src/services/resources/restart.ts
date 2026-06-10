import type { AppContext } from "../../types.js";
import { applyPostDeployServiceState, deployFromGit, stopServiceIfRunning } from "../deploy.js";
import { restartService } from "../runtime.js";

/**
 * Restart-or-redeploy after resource provisioning (Database-Tracker Phase 3).
 *
 * Vite bakes VITE_* values into the bundle at build time, so a static service
 * must be REBUILT (full git redeploy) to pick up freshly injected resource env
 * — a plain restart would keep serving the old bundle pointed at the old (or
 * missing) backend. Process/docker services read env at boot, so a restart is
 * enough. A static service without a git repo (deploy-from-local) falls back
 * to restart: we can't rebuild what we can't re-fetch, and serving the
 * existing bundle beats downtime.
 *
 * The actual restart/redeploy executors are injectable (`setRestartActions`)
 * so provisioning flows stay unit-testable without spawning processes or
 * cloning repos.
 */

export type RestartOutcome = { action: "restarted" | "redeployed" };

export type RestartActions = {
  restart(ctx: AppContext, serviceId: string): Promise<void>;
  redeploy(
    ctx: AppContext,
    serviceId: string,
    repoUrl: string,
    branch: string,
    startAfterDeploy: boolean
  ): Promise<{ status: string }>;
};

const defaultActions: RestartActions = {
  async restart(ctx, serviceId) {
    await restartService(ctx, serviceId);
  },
  async redeploy(ctx, serviceId, repoUrl, branch, startAfterDeploy) {
    await stopServiceIfRunning(ctx, serviceId);
    const deployment = await deployFromGit(ctx, serviceId, repoUrl, branch, "manual");
    await applyPostDeployServiceState(ctx, serviceId, deployment, { startAfterDeploy });
    return deployment;
  }
};

let activeActions: RestartActions = defaultActions;

/** Test seam: replace the restart/redeploy executors (pass null to restore). */
export function setRestartActions(actions: RestartActions | null): void {
  activeActions = actions ?? defaultActions;
}

/**
 * Apply freshly injected resource env to a service: rebuild static/Vite
 * services from git, restart everything else. Throws when the rebuild fails so
 * callers can surface it (provisioning treats that as non-fatal — the resource
 * itself is healthy).
 */
export async function restartOrRedeployService(ctx: AppContext, serviceId: string): Promise<RestartOutcome> {
  const service = ctx.db
    .prepare("SELECT id, type, status, github_repo_url, github_branch FROM services WHERE id = ?")
    .get(serviceId) as
    | {
        id: string;
        type: string;
        status: string;
        github_repo_url: string | null;
        github_branch: string | null;
      }
    | undefined;
  if (!service) throw new Error("Service not found");

  if (service.type === "static" && service.github_repo_url) {
    const wasRunning = service.status === "running";
    const deployment = await activeActions.redeploy(
      ctx,
      serviceId,
      service.github_repo_url,
      service.github_branch || "main",
      wasRunning
    );
    if (deployment.status !== "success") {
      throw new Error("Rebuild after resource provisioning failed — see the service's deployment logs");
    }
    return { action: "redeployed" };
  }

  await activeActions.restart(ctx, serviceId);
  return { action: "restarted" };
}
