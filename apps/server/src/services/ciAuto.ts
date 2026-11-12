/**
 * "CI for every repository": one switch that gives every service linked to a
 * GitHub repo a CI pipeline and a webhook, including services added later.
 *
 * Automatic pipelines read `.survhub/ci.yml` from the repo and run only when
 * the commit has that file, so a repo without it costs one GitHub API call per
 * push and gets no commit status. They never hold a deploy. Editing one turns
 * it into a normal pipeline; deleting one opts that service out.
 */
import type { AppContext } from "../types.js";
import { CI_CONFIG_PATH } from "./ciConfig.js";
import { ensureRepoWebhook, parseRepoFullName } from "./github.js";
import { deleteSetting, getSecretSetting, getSetting, setSetting } from "./settings.js";

const ENABLED_KEY = "ci_auto_all";
const OPT_OUT_KEY = "ci_auto_optout";
/** JSON map of "owner/repo" -> webhook URL the hook was last ensured for. */
const WEBHOOKS_KEY = "ci_auto_webhooks";

export function isAutoCiEnabled(ctx: AppContext): boolean {
  return getSetting(ctx, ENABLED_KEY) === "1";
}

export function setAutoCiEnabled(ctx: AppContext, enabled: boolean): void {
  if (enabled) setSetting(ctx, ENABLED_KEY, "1");
  else deleteSetting(ctx, ENABLED_KEY);
}

function readJson<T>(ctx: AppContext, key: string, fallback: T): T {
  const raw = getSetting(ctx, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function optOuts(ctx: AppContext): Set<string> {
  const list = readJson<unknown>(ctx, OPT_OUT_KEY, []);
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
}

/** A removed pipeline stays removed, even with "CI for every repository" on. */
export function addAutoCiOptOut(ctx: AppContext, serviceId: string): void {
  const set = optOuts(ctx);
  if (set.has(serviceId)) return;
  set.add(serviceId);
  setSetting(ctx, OPT_OUT_KEY, JSON.stringify([...set]));
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);

export function setAutoCiFetchForTests(impl: Fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

/**
 * Does `ref` (a commit, branch or pull request ref) contain ci.yml?
 * true / false from GitHub, or null when that cannot be told (no token, not a
 * GitHub repo, network or API error). Callers queue the run on null.
 */
export async function repoHasCiConfig(
  ctx: AppContext,
  repoUrl: string,
  ref: string
): Promise<boolean | null> {
  const fullName = parseRepoFullName(repoUrl);
  let token: string | null = null;
  try {
    token = getSecretSetting(ctx, "github_pat");
  } catch {
    token = null;
  }
  if (!fullName || !token) return null;
  const pathPart = CI_CONFIG_PATH.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${fullName}/contents/${pathPart}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github.object",
        Authorization: `Bearer ${token}`,
        "User-Agent": "survhub",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { type?: string } | null;
    return body?.type === "file";
  } catch {
    return null;
  }
}

/**
 * One automatic pipeline per repository and deploy branch. Several services
 * often deploy from the same repo (web, API, worker); one pipeline per service
 * would run the same job several times for every push.
 */
function repoBranchKey(repoUrl: string, branch: string | null | undefined): string {
  const name = parseRepoFullName(repoUrl.trim()) ?? repoUrl.trim();
  return `${name.toLowerCase()}#${branch || "main"}`;
}

/**
 * Remove automatic pipelines that repeat another pipeline for the same repo
 * and branch. A pipeline someone edited is never removed; otherwise the
 * oldest one stays. Returns how many were removed.
 */
async function dropDuplicateAutoPipelines(ctx: AppContext): Promise<number> {
  const { deleteCiPipeline } = await import("./ci.js");
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.auto_created, s.github_repo_url AS repoUrl, s.github_branch AS branch
       FROM ci_pipelines p JOIN services s ON s.id = p.service_id
       WHERE s.github_repo_url IS NOT NULL AND s.github_repo_url != ''
       ORDER BY p.auto_created ASC, p.created_at ASC, p.id ASC`
    )
    .all() as Array<{ id: string; auto_created: number; repoUrl: string; branch: string | null }>;
  const kept = new Set<string>();
  let removed = 0;
  for (const row of rows) {
    const key = repoBranchKey(row.repoUrl, row.branch);
    if (!kept.has(key)) {
      kept.add(key);
      continue;
    }
    if (!row.auto_created) continue;
    try {
      deleteCiPipeline(ctx, row.id);
      removed += 1;
    } catch {
      /* a run is active; try again on the next sync */
    }
  }
  if (removed) ctx.app.log.info(`CI: removed ${removed} duplicate automatic pipeline(s)`);
  return removed;
}

/** Give every GitHub-linked repo and branch a pipeline. Returns how many were created. */
export async function syncAutoCiPipelines(ctx: AppContext): Promise<number> {
  if (!isAutoCiEnabled(ctx)) return 0;
  await dropDuplicateAutoPipelines(ctx);
  const { createCiPipeline } = await import("./ci.js");
  const skip = optOuts(ctx);
  const services = ctx.db
    .prepare(
      `SELECT s.id, s.github_repo_url AS repoUrl, s.github_branch AS branch,
              EXISTS (SELECT 1 FROM ci_pipelines p WHERE p.service_id = s.id) AS hasPipeline
       FROM services s
       WHERE s.github_repo_url IS NOT NULL AND s.github_repo_url != ''
       ORDER BY s.rowid`
    )
    .all() as Array<{ id: string; repoUrl: string; branch: string | null; hasPipeline: number }>;
  // A removed pipeline also keeps its repo's other services from getting one.
  const covered = new Set(
    services
      .filter((row) => row.hasPipeline || skip.has(row.id))
      .map((row) => repoBranchKey(row.repoUrl, row.branch))
  );
  let created = 0;
  for (const row of services) {
    const key = repoBranchKey(row.repoUrl, row.branch);
    if (covered.has(key)) continue;
    try {
      createCiPipeline(ctx, { serviceId: row.id, configSource: "repo", gateDeploy: false, auto: true });
      covered.add(key);
      created += 1;
    } catch (error) {
      ctx.app.log.warn({ err: error, serviceId: row.id }, "CI: could not create the automatic pipeline");
    }
  }
  if (created) ctx.app.log.info(`CI: created ${created} automatic pipeline(s)`);
  return created;
}

export type AutoWebhookReadiness = { ready: true; url: string } | { ready: false; reason: string };

export function autoWebhookReadiness(ctx: AppContext): AutoWebhookReadiness {
  let token: string | null = null;
  try {
    token = getSecretSetting(ctx, "github_pat");
  } catch {
    token = null;
  }
  if (!token) return { ready: false, reason: "Save a GitHub token under Settings → GitHub." };
  if (ctx.config.webhookInsecure || !ctx.config.webhookSecret) {
    return { ready: false, reason: "Set SURVHUB_WEBHOOK_SECRET so GitHub deliveries are signed." };
  }
  const configured = getSetting(ctx, "github_webhook_url");
  const url = configured || (ctx.config.publicUrl ? `${ctx.config.publicUrl}/webhooks/github` : "");
  if (!url) {
    return {
      ready: false,
      reason:
        "Set SURVHUB_PUBLIC_URL (or a webhook URL under Settings → GitHub) so GitHub can reach this server."
    };
  }
  return { ready: true, url };
}

/**
 * Make sure each repo with a pipeline has a push + pull_request webhook.
 * A repo is only contacted again when the webhook URL changed, or with
 * `force` (e.g. after the secret was rotated).
 */
export async function syncAutoCiWebhooks(
  ctx: AppContext,
  options: { force?: boolean } = {}
): Promise<{ ensured: string[]; failed: Array<{ repo: string; error: string }>; skipped?: string }> {
  if (!isAutoCiEnabled(ctx)) return { ensured: [], failed: [], skipped: "CI for every repository is off" };
  const readiness = autoWebhookReadiness(ctx);
  if (!readiness.ready) return { ensured: [], failed: [], skipped: readiness.reason };
  const done = readJson<Record<string, string>>(ctx, WEBHOOKS_KEY, {});
  const repos = ctx.db
    .prepare(
      `SELECT DISTINCT s.github_repo_url AS repoUrl FROM ci_pipelines p
       JOIN services s ON s.id = p.service_id
       WHERE p.enabled = 1 AND s.github_repo_url IS NOT NULL AND s.github_repo_url != ''`
    )
    .all() as Array<{ repoUrl: string }>;
  const names = [...new Set(repos.map((row) => parseRepoFullName(row.repoUrl)).filter(Boolean))] as string[];
  const ensured: string[] = [];
  const failed: Array<{ repo: string; error: string }> = [];
  for (const name of names) {
    if (!options.force && done[name] === readiness.url) continue;
    try {
      await ensureRepoWebhook(ctx, name, readiness.url, ctx.config.webhookSecret);
      done[name] = readiness.url;
      ensured.push(name);
    } catch (error) {
      failed.push({ repo: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (ensured.length) setSetting(ctx, WEBHOOKS_KEY, JSON.stringify(done));
  if (failed.length) ctx.app.log.warn({ failed }, "CI: could not set up some GitHub webhooks");
  return { ensured, failed };
}

/** Run both syncs now. Pipelines first, so new repos also get their webhook. */
export async function syncAutoCi(ctx: AppContext, options: { force?: boolean } = {}) {
  const created = await syncAutoCiPipelines(ctx);
  const webhooks = await syncAutoCiWebhooks(ctx, options);
  return { created, webhooks };
}

/**
 * Pick up new services every minute (a cheap database query). Webhooks are
 * only re-checked when a pipeline was added, and otherwise every 30 minutes.
 */
export function startAutoCi(ctx: AppContext): () => void {
  let busy = false;
  let lastWebhookSync = 0;
  const tick = async () => {
    if (busy || !isAutoCiEnabled(ctx)) return;
    busy = true;
    try {
      const created = await syncAutoCiPipelines(ctx);
      if (created || Date.now() - lastWebhookSync > 30 * 60_000) {
        lastWebhookSync = Date.now();
        await syncAutoCiWebhooks(ctx);
      }
    } catch (error) {
      ctx.app.log.warn({ err: error }, "CI: automatic pipeline sync failed");
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
