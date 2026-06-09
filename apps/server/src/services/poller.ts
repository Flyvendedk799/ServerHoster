import path from "node:path";
import fs from "node:fs";
import simpleGit from "simple-git";
import type { AppContext } from "../types.js";
import { deployFromGit, applyPostDeployServiceState, stopServiceIfRunning } from "./deploy.js";
import { insertLog, serializeError } from "../lib/core.js";
import { buildGitEnv, injectGitCredentials } from "./settings.js";

/** Two commit refs are "the same" if either is a prefix of the other (tolerates a
 * short SHA stored on an old deployment row vs. a full SHA from the remote). */
function commitsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export async function getGithubSyncStatus(ctx: AppContext, serviceId: string) {
  const service = ctx.db
    .prepare("SELECT id, status, github_repo_url, github_branch, github_auto_pull FROM services WHERE id = ?")
    .get(serviceId) as
    | {
        id: string;
        status?: string | null;
        github_repo_url?: string | null;
        github_branch?: string | null;
        github_auto_pull?: number | null;
      }
    | undefined;
  if (!service) throw new Error("Service not found");
  const repoUrl = service.github_repo_url ?? "";
  const branch = service.github_branch || "main";
  const autoPull = service.github_auto_pull !== 0;
  if (!repoUrl) {
    return {
      serviceId,
      linked: false,
      autoPull,
      branch,
      latestCommitHash: null,
      remoteHash: null,
      updateAvailable: false,
      requiresRestart: false,
      canCheck: false,
      reason: "Service is not linked to a GitHub repository."
    };
  }

  const latestDeploy = ctx.db
    .prepare(
      `SELECT commit_hash FROM deployments
       WHERE service_id = ?
         AND status = 'success'
         AND commit_hash IS NOT NULL
         AND commit_hash != ''
         AND (trigger_source IN ('manual', 'webhook', 'gitops-poller') OR trigger_source IS NULL)
       ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 1`
    )
    .get(serviceId) as { commit_hash?: string } | undefined;
  let latestCommitHash = latestDeploy?.commit_hash ?? null;

  // No recorded successful-deploy commit (e.g. an adopted/already-running service,
  // or a deploy that never persisted one) would otherwise make every poll report
  // "update available" forever — comparing the remote against "none". The clone's
  // checked-out HEAD is the code that's actually running, so use it as the
  // deployed commit when no deployment row gives us one.
  if (!latestCommitHash) {
    try {
      const cloneDir = path.join(ctx.config.projectsDir, serviceId);
      if (fs.existsSync(path.join(cloneDir, ".git"))) {
        latestCommitHash =
          (await simpleGit(cloneDir).env(buildGitEnv(ctx) as Record<string, string>).revparse(["HEAD"])).trim() ||
          null;
      }
    } catch {
      /* no readable clone — fall through to the previous "update available" behavior */
    }
  }

  try {
    const git = simpleGit().env(buildGitEnv(ctx) as Record<string, string>);
    const authedUrl = injectGitCredentials(ctx, repoUrl);
    const remotes = await git.listRemote(["--heads", authedUrl, branch]);
    const remoteHash = remotes.split("\t")[0]?.trim() || null;
    return {
      serviceId,
      linked: true,
      autoPull,
      branch,
      repoUrl,
      latestCommitHash,
      remoteHash,
      updateAvailable: Boolean(remoteHash && !commitsMatch(latestCommitHash, remoteHash)),
      requiresRestart: Boolean(
        remoteHash && !commitsMatch(latestCommitHash, remoteHash) && service.status === "running"
      ),
      canCheck: Boolean(remoteHash),
      reason: remoteHash ? null : `Branch ${branch} was not found on the remote.`
    };
  } catch (error) {
    return {
      serviceId,
      linked: true,
      autoPull,
      branch,
      repoUrl,
      latestCommitHash,
      remoteHash: null,
      updateAvailable: false,
      requiresRestart: false,
      canCheck: false,
      reason: serializeError(error)
    };
  }
}

export async function getGithubSyncStatuses(
  ctx: AppContext,
  serviceIds: string[]
): Promise<Array<Awaited<ReturnType<typeof getGithubSyncStatus>>>> {
  const uniqueIds = [...new Set(serviceIds.filter(Boolean))].slice(0, 50);
  const statuses: Array<Awaited<ReturnType<typeof getGithubSyncStatus>>> = [];
  for (const serviceId of uniqueIds) {
    statuses.push(await getGithubSyncStatus(ctx, serviceId));
  }
  return statuses;
}

export async function pollGitUpdatesOnce(ctx: AppContext): Promise<void> {
  const rows = ctx.db
    .prepare(
      "SELECT id, github_repo_url, github_branch, last_attempted_commit FROM services WHERE github_repo_url IS NOT NULL AND status != 'building' AND (github_auto_pull = 1 OR github_auto_pull IS NULL)"
    )
    .all() as Array<{
    id: string;
    github_repo_url: string;
    github_branch: string | null;
    last_attempted_commit: string | null;
  }>;

  const git = simpleGit().env(buildGitEnv(ctx) as Record<string, string>);

  for (const row of rows) {
    try {
      // Skip if a deploy/start/stop is already in progress for this service —
      // otherwise we'd race a git pull / install against it.
      if (ctx.actionLocks.has(row.id)) continue;

      const branch = row.github_branch || "main";
      const authedUrl = injectGitCredentials(ctx, row.github_repo_url);
      const remotes = await git.listRemote(["--heads", authedUrl, branch]);
      if (!remotes) continue;

      const remoteHash = remotes.split("\t")[0]?.trim();
      if (!remoteHash) continue;

      const latestDeploy = ctx.db
        .prepare(
          `SELECT commit_hash FROM deployments
           WHERE service_id = ?
             AND status = 'success'
             AND commit_hash IS NOT NULL
             AND commit_hash != ''
             AND (trigger_source IN ('manual', 'webhook', 'gitops-poller') OR trigger_source IS NULL)
           ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 1`
        )
        .get(row.id) as { commit_hash?: string } | undefined;

      // Trigger only when the remote moved to a commit we have not already tried
      // (success OR failure) and have not already deployed successfully. Keying
      // off last_attempted_commit is what stops a commit that keeps failing to
      // build from being redeployed on every single tick, forever.
      if (remoteHash === row.last_attempted_commit) continue;
      if (latestDeploy?.commit_hash === remoteHash) continue;

      const previous = row.last_attempted_commit
        ? row.last_attempted_commit.slice(0, 7)
        : latestDeploy?.commit_hash
          ? latestDeploy.commit_hash.slice(0, 7)
          : "no baseline";
      // Record the attempt BEFORE deploying so a failed build doesn't re-trigger
      // next tick even if deployFromGit throws.
      ctx.db
        .prepare("UPDATE services SET last_attempted_commit = ? WHERE id = ?")
        .run(remoteHash, row.id);
      insertLog(
        ctx,
        row.id,
        "info",
        `GitOps: Detected remote commit change (${previous} -> ${remoteHash.slice(0, 7)}). Triggering redeploy.`
      );
      await stopServiceIfRunning(ctx, row.id);
      const deployment = await deployFromGit(ctx, row.id, row.github_repo_url, branch, "gitops-poller");
      await applyPostDeployServiceState(ctx, row.id, deployment, { startAfterDeploy: true });
    } catch (error) {
      insertLog(ctx, row.id, "error", `GitOps poller failed for service: ${serializeError(error)}`);
    }
  }
}

export function startGitPollerLoop(ctx: AppContext): () => void {
  let isRunning = false;

  const interval = setInterval(async () => {
    if (isRunning) return; // prevent overlap if polling takes longer than interval
    isRunning = true;
    try {
      await pollGitUpdatesOnce(ctx);
    } catch {
      // Global loop error catch to prevent crash
    } finally {
      isRunning = false;
    }
  }, ctx.config.gitPollIntervalMs);

  return () => clearInterval(interval);
}
