import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types.js";

/**
 * Persistent uploads.
 *
 * Apps that save user uploads *inside* their own source tree (e.g. a Flask app
 * writing to app/static/images/) lose those files whenever a deploy hard-resets
 * the git clone to remote state (deploy.ts: `git checkout -f` + `reset --hard`).
 * The fix: back those directories with the service's persistent DATA_DIR volume
 * (~/.survhub/service-data/<id>), which lives OUTSIDE the disposable clone.
 *
 * For process/static services we replace the in-clone directory with a symlink
 * into `<service-data>/<id>/persisted/<path>`; the symlink is re-established on
 * every deploy (after the reset, before the build) and on service start.
 * For docker services we bind-mount the same host dir at a container path.
 *
 * Conflict rule — PERSISTENT WINS: committed files only *seed* the volume when
 * absent; a deploy never overwrites a file the app/admin wrote at runtime. This
 * guarantees an incoming git update can't revert an image changed in the admin UI.
 */

/**
 * Conventional upload directories auto-persisted when present in a clone.
 * Deliberately narrow — dirs whose whole purpose is user uploads — so we never
 * symlink a directory that also holds code or framework assets. Non-standard
 * dirs (e.g. HighendEvent's app/static/images, which mixes shipped images and
 * uploads) are opted in per service via persisted_paths_config.paths.
 */
export const DEFAULT_UPLOAD_DIRS = [
  "uploads",
  "media",
  "static/uploads",
  "public/uploads",
  "app/static/uploads"
];

export interface PersistedConfig {
  /** Auto-detect the conventional upload dirs above. Default true. */
  auto: boolean;
  /** Extra paths to persist. Repo-relative for process/static; absolute container paths for docker. */
  paths: string[];
  /** Paths to exclude from the effective set (matched against normalized values). */
  exclude: string[];
}

const DEFAULT_CONFIG: PersistedConfig = { auto: true, paths: [], exclude: [] };

/** Read + normalize a service's persisted-uploads config (NULL → defaults). */
export function readPersistedConfig(ctx: AppContext, serviceId: string): PersistedConfig {
  const row = ctx.db
    .prepare("SELECT persisted_paths_config FROM services WHERE id = ?")
    .get(serviceId) as { persisted_paths_config?: string | null } | undefined;
  const raw = row?.persisted_paths_config;
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    return {
      auto: parsed.auto !== false,
      paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p) => typeof p === "string") : [],
      exclude: Array.isArray(parsed.exclude) ? parsed.exclude.filter((p) => typeof p === "string") : []
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Normalize a repo-relative path: trim, drop leading/trailing slashes, collapse
 * "./". Returns null for absolute paths or any with a ".." segment (would escape
 * the clone). Keeps us from symlinking outside the working tree.
 */
function normalizeRel(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || path.isAbsolute(trimmed)) return null;
  const parts = trimmed.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.length ? parts.join("/") : null;
}

/** Host directory backing a persisted repo-relative path. */
function persistedHostDir(ctx: AppContext, serviceId: string, relPath: string): string {
  return path.join(ctx.config.serviceDataDir, serviceId, "persisted", relPath);
}

/**
 * Effective relative paths to persist for a process/static service: auto-detected
 * conventional dirs that exist in the clone (when auto is on) ∪ configured relative
 * paths, minus exclusions. Deduped, stable order.
 */
export function resolvePersistedRelPaths(ctx: AppContext, serviceId: string, cloneDir: string): string[] {
  const cfg = readPersistedConfig(ctx, serviceId);
  const exclude = new Set(cfg.exclude.map(normalizeRel).filter((p): p is string => !!p));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string | null) => {
    if (!rel || seen.has(rel) || exclude.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  if (cfg.auto) {
    for (const dir of DEFAULT_UPLOAD_DIRS) {
      const full = path.join(cloneDir, dir);
      // lstat: a symlink we created on a prior deploy still counts as present.
      let exists = false;
      try {
        exists = fs.lstatSync(full).isDirectory() || fs.lstatSync(full).isSymbolicLink();
      } catch {
        exists = false;
      }
      if (exists) add(dir);
    }
  }
  // Configured relative paths persist whether or not they exist yet (the app may
  // create them at runtime); only absolute paths are skipped (those are docker).
  for (const p of cfg.paths) add(normalizeRel(p));
  return out;
}

/**
 * Candidate relative paths whose in-clone symlink must be removed BEFORE git
 * fetch/reset, so `git reset --hard` can restore tracked files without tripping
 * on a leftover symlink. Broader than the resolved set: includes every default
 * dir (the path may currently be a symlink, not a real dir) plus configured ones.
 */
function symlinkCandidateRelPaths(ctx: AppContext, serviceId: string): string[] {
  const cfg = readPersistedConfig(ctx, serviceId);
  const set = new Set<string>();
  if (cfg.auto) for (const d of DEFAULT_UPLOAD_DIRS) set.add(d);
  for (const p of cfg.paths) {
    const rel = normalizeRel(p);
    if (rel) set.add(rel);
  }
  return [...set];
}

/** Remove any leftover persisted symlinks in the clone before git ops. */
export function unlinkPersistedSymlinks(ctx: AppContext, serviceId: string, cloneDir: string): void {
  for (const rel of symlinkCandidateRelPaths(ctx, serviceId)) {
    const full = path.join(cloneDir, rel);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full);
    } catch {
      /* not present — nothing to undo */
    }
  }
}

/** Recursively copy files from src into dest, skipping any dest file that already exists (persistent wins). */
function seedCopyIfAbsent(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      seedCopyIfAbsent(from, to);
    } else if (entry.isFile()) {
      if (!fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  }
}

/**
 * For each persisted path: seed committed files into the volume (copy-if-absent),
 * then replace the in-clone path with a symlink to the volume. Idempotent across
 * deploys. Returns the relative paths that were linked (for logging). Best-effort:
 * a failure on one path is logged via onError and does not abort the others.
 */
export function ensurePersistedPaths(
  ctx: AppContext,
  serviceId: string,
  cloneDir: string,
  onError?: (rel: string, err: unknown) => void
): string[] {
  const linked: string[] = [];
  for (const rel of resolvePersistedRelPaths(ctx, serviceId, cloneDir)) {
    const host = persistedHostDir(ctx, serviceId, rel);
    const inClone = path.join(cloneDir, rel);
    try {
      fs.mkdirSync(host, { recursive: true });
      // Seed from whatever git restored in the clone (a real dir/file), never
      // overwriting an existing volume file. A symlink left over from a prior
      // deploy is skipped — its target is the volume itself.
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(inClone);
      } catch {
        stat = null;
      }
      if (stat && !stat.isSymbolicLink()) {
        if (stat.isDirectory()) {
          seedCopyIfAbsent(inClone, host);
        } else if (stat.isFile()) {
          const dest = path.join(host, path.basename(inClone));
          if (!fs.existsSync(dest)) fs.copyFileSync(inClone, dest);
        }
        fs.rmSync(inClone, { recursive: true, force: true });
      } else if (stat && stat.isSymbolicLink()) {
        fs.unlinkSync(inClone);
      }
      fs.mkdirSync(path.dirname(inClone), { recursive: true });
      fs.symlinkSync(host, inClone);
      linked.push(rel);
    } catch (err) {
      onError?.(rel, err);
    }
  }
  return linked;
}

export interface DockerPersistBind {
  hostDir: string;
  containerPath: string;
  bind: string;
}

/**
 * Docker bind mounts for a service's persisted paths. Docker paths are stored as
 * ABSOLUTE container paths (e.g. /app/static/images); each maps to a host dir
 * under the volume. Best-effort seed from the build clone's matching relative
 * path. NOTE: a bind mount shadows files baked into the image at that path — for
 * docker, writing to $DATA_DIR (/data) is preferred; this is for apps that can't
 * be reconfigured.
 */
export function resolvePersistedDockerBinds(
  ctx: AppContext,
  serviceId: string,
  cloneDir: string
): DockerPersistBind[] {
  const cfg = readPersistedConfig(ctx, serviceId);
  const exclude = new Set(cfg.exclude);
  const binds: DockerPersistBind[] = [];
  const seen = new Set<string>();
  for (const raw of cfg.paths) {
    const containerPath = raw.trim();
    if (!path.posix.isAbsolute(containerPath) || exclude.has(raw) || seen.has(containerPath)) continue;
    if (containerPath.split("/").some((s) => s === "..")) continue;
    seen.add(containerPath);
    const sub = containerPath.replace(/^\/+/, "");
    const hostDir = path.join(ctx.config.serviceDataDir, serviceId, "persisted", sub);
    try {
      fs.mkdirSync(hostDir, { recursive: true });
      // Seed from the clone's matching relative path if the volume is still empty.
      if (fs.readdirSync(hostDir).length === 0) {
        const fromClone = path.join(cloneDir, sub);
        try {
          if (fs.statSync(fromClone).isDirectory()) seedCopyIfAbsent(fromClone, hostDir);
        } catch {
          /* nothing to seed */
        }
      }
    } catch {
      continue;
    }
    binds.push({ hostDir, containerPath, bind: `${hostDir}:${containerPath}` });
  }
  return binds;
}
