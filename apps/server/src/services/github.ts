import type { AppContext } from "../types.js";
import { getSecretSetting } from "./settings.js";

type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  updated_at: string;
};

function requirePat(ctx: AppContext): string {
  const pat = getSecretSetting(ctx, "github_pat");
  if (!pat) throw new Error("No GitHub PAT configured. Save one under Settings → GitHub.");
  return pat;
}

async function gh<T>(pat: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "User-Agent": "survhub",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${endpoint}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function listUserRepos(ctx: AppContext): Promise<GithubRepo[]> {
  const pat = requirePat(ctx);
  const all: GithubRepo[] = [];
  // Paginate. GitHub caps at 100/page.
  for (let page = 1; page <= 10; page++) {
    const batch = await gh<GithubRepo[]>(
      pat,
      `/user/repos?per_page=100&sort=updated&page=${page}&affiliation=owner,collaborator,organization_member`
    );
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * Ensure a GitHub push-event webhook exists pointing at webhookUrl.
 * Idempotent: if a webhook with the same URL is already registered, does nothing.
 * Returns the hook id and whether it was newly created.
 */
export async function ensureRepoWebhook(
  ctx: AppContext,
  repoFullName: string,
  webhookUrl: string,
  secret?: string
): Promise<{ id: number; created: boolean }> {
  const pat = requirePat(ctx);
  const existing = await gh<Array<{ id: number; config?: { url?: string } }>>(
    pat,
    `/repos/${repoFullName}/hooks?per_page=100`
  );
  const already = existing.find((h) => h.config?.url === webhookUrl);
  if (already) return { id: already.id, created: false };
  const created = await gh<{ id: number }>(pat, `/repos/${repoFullName}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: webhookUrl,
        content_type: "json",
        insecure_ssl: "0",
        ...(secret ? { secret } : {})
      }
    })
  });
  return { id: created.id, created: true };
}

/** Parse "https://github.com/org/repo.git" or similar into "org/repo". */
export function parseRepoFullName(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    if (!/github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}
