/**
 * Per-repository dependency caches for CI jobs (npm, pnpm, yarn, pip, …).
 *
 * Each repository gets its own host directory, mounted at /cache only into
 * that repository's jobs. Host directories are used instead of named Docker
 * volumes because a fresh named volume is owned by root, and jobs run as a
 * non-root user with every capability dropped.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types.js";
import { stripGitCredentials } from "./ciConfig.js";

export const CACHE_IDLE_DAYS = 14;

export function cacheRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataRoot, "ci-cache");
}

/** Stable per-repo key; credentials and ".git" do not change it. */
export function repoCacheKey(repoUrl: string): string {
  const normalized = stripGitCredentials(repoUrl)
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function repoCacheDir(ctx: AppContext, repoUrl: string): string {
  return path.join(cacheRoot(ctx), repoCacheKey(repoUrl));
}

/**
 * Size of a directory tree in bytes, without following symlinks. Stops early
 * once `stopAt` is passed, so a size check on a huge tree stays cheap.
 */
export async function dirSize(dir: string, stopAt = Number.POSITIVE_INFINITY): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.lstat(full)).size;
        } catch {
          /* vanished */
        }
        if (total > stopAt) return total;
      }
    }
  }
  return total;
}

/** chown a whole tree (no symlink following). Used when ServerHoster runs as root. */
export async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    try {
      await fs.promises.lchown(current, uid, gid);
    } catch {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else await fs.promises.lchown(full, uid, gid).catch(() => undefined);
    }
  }
}

export async function ensureRepoCacheDir(ctx: AppContext, repoUrl: string): Promise<string> {
  const dir = repoCacheDir(ctx, repoUrl);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  await fs.promises.utimes(dir, now, now).catch(() => undefined);
  return dir;
}

export async function clearRepoCache(ctx: AppContext, repoUrl: string): Promise<void> {
  await fs.promises.rm(repoCacheDir(ctx, repoUrl), { recursive: true, force: true });
}

/**
 * Drop a repo's cache when it has grown past `maxMb` (0 disables caching
 * entirely), and drop caches nobody used for CACHE_IDLE_DAYS. `busy` keys are
 * left alone so a running job never loses its cache mid-install.
 */
export async function pruneCaches(
  ctx: AppContext,
  opts: { maxMb: number; busy: Set<string>; onlyKey?: string }
): Promise<string[]> {
  const root = cacheRoot(ctx);
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const idleBefore = Date.now() - CACHE_IDLE_DAYS * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name) || opts.busy.has(name)) continue;
    if (opts.onlyKey && name !== opts.onlyKey) continue;
    const dir = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      continue;
    }
    const tooOld = stat.mtimeMs < idleBefore;
    const limit = opts.maxMb * 1024 * 1024;
    const tooBig = !tooOld && (opts.maxMb === 0 || (await dirSize(dir, limit)) > limit);
    if (tooOld || tooBig) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      removed.push(name);
    }
  }
  return removed;
}
