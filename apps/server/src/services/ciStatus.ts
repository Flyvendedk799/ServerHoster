/**
 * Report CI results to GitHub as commit statuses (Statuses API), so a pull
 * request or commit shows "survhub-ci/<pipeline>" next to its checks.
 *
 * Reporting is best effort: it never throws, never fails or delays a run, and
 * never puts the token in a log line.
 */
import type { AppContext } from "../types.js";
import { parseRepoFullName } from "./github.js";
import { getSecretSetting } from "./settings.js";
import { redactSecrets } from "./ciConfig.js";

export type CommitState = "pending" | "success" | "failure" | "error";

export type StatusTarget = {
  runId: string;
  repoUrl: string | null | undefined;
  commit: string | null | undefined;
  pipelineName: string;
};

export type StatusResult =
  | { ok: true }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; warning: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Tests swap in a fake GitHub. Pass null to restore the real fetch. */
export function setStatusFetchForTests(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function statusContext(pipelineName: string): string {
  const clean =
    pipelineName
      .replace(/[^\w .:/-]+/g, "")
      .trim()
      .slice(0, 80) || "ci";
  return `survhub-ci/${clean}`;
}

export function runTargetUrl(publicUrl: string | null | undefined, runId: string): string | undefined {
  const base = (publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return undefined;
  return `${base}/ci?run=${encodeURIComponent(runId)}`;
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 140 ? single : `${single.slice(0, 139)}…`;
}

/** Per-run promise chain so "pending" can never land after the final state. */
const chains = new Map<string, Promise<unknown>>();

export function reportCommitStatus(
  ctx: AppContext,
  target: StatusTarget,
  state: CommitState,
  description: string
): Promise<StatusResult> {
  const previous = chains.get(target.runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => postStatus(ctx, target, state, description))
    .catch((error: unknown): StatusResult => ({ ok: false, warning: String(error) }));
  chains.set(target.runId, next);
  void next.finally(() => {
    if (chains.get(target.runId) === next) chains.delete(target.runId);
  });
  return next;
}

/** Wait for every queued status post (tests and shutdown). */
export async function flushCommitStatuses(): Promise<void> {
  await Promise.allSettled([...chains.values()]);
}

async function postStatus(
  ctx: AppContext,
  target: StatusTarget,
  state: CommitState,
  description: string
): Promise<StatusResult> {
  const fullName = target.repoUrl ? parseRepoFullName(target.repoUrl) : null;
  if (!fullName) return { ok: false, skipped: true, reason: "not a github.com repository" };
  if (!target.commit || !FULL_SHA_RE.test(target.commit)) {
    return { ok: false, skipped: true, reason: "commit is not known yet" };
  }
  const token = getSecretSetting(ctx, "github_pat");
  if (!token) return { ok: false, skipped: true, reason: "no GitHub token saved" };

  const body: Record<string, string> = {
    state,
    context: statusContext(target.pipelineName),
    description: clip(description)
  };
  const targetUrl = runTargetUrl(ctx.config.publicUrl, target.runId);
  if (targetUrl) body.target_url = targetUrl;

  const [owner, repo] = fullName.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${target.commit}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "survhub",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    if (res.ok) return { ok: true };
    let message = "";
    try {
      const parsed = JSON.parse(await res.text()) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message.slice(0, 200);
    } catch {
      /* not JSON */
    }
    const hint =
      res.status === 403 || res.status === 404
        ? " The token needs commit status write access (classic PAT: repo:status or repo; fine-grained: Commit statuses: write)."
        : "";
    return {
      ok: false,
      warning: redactSecrets(
        `GitHub refused the commit status (${res.status}${message ? `: ${message}` : ""}).${hint}`,
        [token]
      )
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      warning: redactSecrets(`Could not reach GitHub to post the commit status: ${text}`, [token])
    };
  }
}
