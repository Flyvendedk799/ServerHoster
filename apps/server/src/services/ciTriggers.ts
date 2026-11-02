/**
 * Which GitHub events start a CI run, and in which "lane".
 *
 * A lane is the unit of supersede: a newer commit in the same lane cancels the
 * older queued run. Pushes to a branch share `push:<branch>`; every commit on
 * a pull request shares `pr:<number>`. Only the deploy branch's push lane may
 * feed the deploy gate.
 */

export type CiEvent = "push" | "pull_request" | "manual";

export type TriggerSettings = {
  /** Raw pipeline setting: blank = deploy branch only, "*" = every branch, else a comma/newline list. */
  trigger_branches?: string | null;
  /** 1 = run on pull requests whose base branch matches (default), 0 = never. */
  trigger_pull_requests?: number | null;
};

const MAX_BRANCH_LENGTH = 255;

/**
 * Only accept branch names git itself would accept, and nothing that could be
 * read as an option. These names come from webhook payloads and end up as
 * arguments to git.
 */
export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_BRANCH_LENGTH) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.endsWith(".lock") || name.includes("..") || name.includes("//") || name.includes("@{"))
    return false;
  // Control chars, space, and the characters git forbids in ref names.
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return !/[~^:?*[\\]/.test(name);
}

/**
 * "refs/heads/feature/main" -> "feature/main". Tags and other refs return null,
 * so a tag called "main" is never mistaken for the main branch.
 */
export function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null;
  const branch = ref.slice("refs/heads/".length);
  return isSafeBranchName(branch) ? branch : null;
}

export function pullRequestRef(prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("Invalid pull request number");
  return `refs/pull/${prNumber}/head`;
}

export function isPullRequestRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^refs\/pull\/[1-9][0-9]{0,9}\/head$/.test(ref);
}

export function laneForPush(branch: string): string {
  return `push:${branch}`;
}

export function laneForPullRequest(prNumber: number): string {
  return `pr:${prNumber}`;
}

/** Parse the pipeline's branch filter. Empty list = deploy branch only. */
export function parseBranchPatterns(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const pattern = part.trim();
    if (!pattern) continue;
    if (pattern.length > MAX_BRANCH_LENGTH)
      throw new Error(`Branch pattern is too long: ${pattern.slice(0, 40)}…`);
    if (!/^[A-Za-z0-9._/*-]+$/.test(pattern) || pattern.startsWith("-")) {
      throw new Error(`Branch pattern "${pattern}" may only use letters, digits, . _ / - and *.`);
    }
    if (!out.includes(pattern)) out.push(pattern);
  }
  if (out.length > 50) throw new Error("At most 50 branch patterns.");
  return out;
}

function patternToRegExp(pattern: string): RegExp {
  // "**" matches across "/", "*" stays within one path segment.
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Full-name branch matching. "feature/main" never matches "main"; the lone
 * pattern "*" means every branch.
 */
export function branchMatches(patterns: string[], branch: string, deployBranch: string): boolean {
  if (!isSafeBranchName(branch)) return false;
  if (branch === deployBranch) return true;
  return patterns.some((pattern) => pattern === "*" || patternToRegExp(pattern).test(branch));
}

export function shouldRunPush(settings: TriggerSettings, branch: string, deployBranch: string): boolean {
  let patterns: string[];
  try {
    patterns = parseBranchPatterns(settings.trigger_branches);
  } catch {
    patterns = [];
  }
  return branchMatches(patterns, branch, deployBranch);
}

export type PullRequestDecision =
  | { run: true }
  | { run: false; reason: "disabled" | "fork" | "base-branch" | "action" | "branch-name" };

export const PR_RUN_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * Fork pull requests never run: the job (and its .survhub/ci.yml) would come
 * from someone without push access, on this host's CPU and network.
 */
export function shouldRunPullRequest(
  settings: TriggerSettings,
  pr: { action: string; baseBranch: string; headBranch: string; isFork: boolean },
  deployBranch: string
): PullRequestDecision {
  if (!PR_RUN_ACTIONS.has(pr.action)) return { run: false, reason: "action" };
  if ((settings.trigger_pull_requests ?? 1) === 0) return { run: false, reason: "disabled" };
  if (pr.isFork) return { run: false, reason: "fork" };
  if (!isSafeBranchName(pr.headBranch)) return { run: false, reason: "branch-name" };
  if (!shouldRunPush(settings, pr.baseBranch, deployBranch)) return { run: false, reason: "base-branch" };
  return { run: true };
}

/** A PR is a fork PR unless its head repository is the base repository. */
export function isForkPullRequest(
  headRepoFullName: string | null | undefined,
  baseRepoFullName: string | null | undefined
): boolean {
  if (!headRepoFullName || !baseRepoFullName) return true;
  return headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase();
}
