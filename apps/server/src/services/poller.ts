import simpleGit from "simple-git";
import type { AppContext } from "../types.js";
import { deployFromGit, applyPostDeployServiceState, stopServiceIfRunning } from "./deploy.js";
import { insertLog, serializeError } from "../lib/core.js";
import { buildGitEnv, injectGitCredentials } from "./settings.js";

export function startGitPollerLoop(ctx: AppContext): () => void {
  let isRunning = false;

  const interval = setInterval(async () => {
    if (isRunning) return; // prevent overlap if polling takes longer than interval
    isRunning = true;
    try {
      // Find all services opted into auto-pull that have a repo set
      const rows = ctx.db.prepare(
        "SELECT id, github_repo_url, github_branch FROM services WHERE github_repo_url IS NOT NULL AND status != 'building' AND (github_auto_pull = 1 OR github_auto_pull IS NULL)"
      ).all() as Array<{ id: string; github_repo_url: string; github_branch: string | null }>;

      const git = simpleGit().env(buildGitEnv(ctx) as Record<string, string>);

      for (const row of rows) {
        try {
          const branch = row.github_branch || "main";
          // Use injected PAT when present so private repos are pollable.
          const authedUrl = injectGitCredentials(ctx, row.github_repo_url);
          // Lightweight remote check
          const remotes = await git.listRemote(["--heads", authedUrl, branch]);
          if (!remotes) continue;
          
          const remoteHash = remotes.split("\t")[0]?.trim();
          if (!remoteHash) continue;

          // Get latest deployment hash locally
          const latestDeploy = ctx.db.prepare(
            "SELECT commit_hash FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1"
          ).get(row.id) as { commit_hash?: string } | undefined;

          if (latestDeploy?.commit_hash && latestDeploy.commit_hash !== remoteHash) {
            insertLog(ctx, row.id, "info", `GitOps: Detected new commit on remote (${latestDeploy.commit_hash.slice(0,7)} -> ${remoteHash.slice(0,7)}). Triggering redeploy.`);
            await stopServiceIfRunning(ctx, row.id);
            const deployment = await deployFromGit(ctx, row.id, row.github_repo_url, branch, "gitops-poller");
            await applyPostDeployServiceState(ctx, row.id, deployment, { startAfterDeploy: true });
          }
        } catch (error) {
          insertLog(ctx, row.id, "error", `GitOps poller failed for service: ${serializeError(error)}`);
        }
      }
    } catch (e) {
      // Global loop error catch to prevent crash
    } finally {
      isRunning = false;
    }
  }, ctx.config.gitPollIntervalMs);

  return () => clearInterval(interval);
}
