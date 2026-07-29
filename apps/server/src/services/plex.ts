import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Plex Media Server integration.
 *
 * Plex is installed as a host package (`plexmediaserver`), not as a SURVHub
 * service, so it is managed through systemd rather than the runtime process
 * table. Everything here talks to two places: `systemctl` for lifecycle and
 * the local Plex HTTP API on 127.0.0.1:32400 for library/session state.
 *
 * The server's `PlexOnlineToken` lives in Preferences.xml and is read on
 * demand. It is a credential for the owner's Plex account — it authenticates
 * the calls made here and is never included in any route response.
 */

const UNIT = "plexmediaserver";
const PREFS_PATH =
  "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml";
const ORIGIN = "http://127.0.0.1:32400";
const HTTP_TIMEOUT_MS = 6000;

export type PlexPowerAction = "start" | "stop" | "restart";

export type PlexStatus = {
  installed: boolean;
  version: string | null;
  /** systemd `is-active` — "active", "inactive", "failed", … */
  state: string;
  running: boolean;
  /** Starts with the host, i.e. survives a reboot. */
  enabled: boolean;
  /** The API answered on 127.0.0.1:32400. */
  reachable: boolean;
  claimed: boolean;
  account: string | null;
  friendlyName: string | null;
  machineIdentifier: string | null;
  port: number;
  updatedAt: string;
};

export type PlexLibrary = {
  key: string;
  title: string;
  type: string;
  agent: string | null;
  scanning: boolean;
  itemCount: number | null;
  locations: string[];
  updatedAt: string | null;
};

export type PlexSession = {
  sessionKey: string;
  title: string;
  /** Show name for episodes, artist for tracks; null for movies. */
  parentTitle: string | null;
  type: string;
  user: string | null;
  player: string | null;
  playerState: string | null;
  /** Playback position and length in ms — null when Plex omits them. */
  viewOffset: number | null;
  duration: number | null;
  transcoding: boolean;
  videoDecision: string | null;
};

/** Plex answers JSON when asked; avoids pulling in an XML parser. */
const JSON_HEADERS = { Accept: "application/json" };

class PlexUnavailableError extends Error {
  statusCode = 503;
  code = "PLEX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "PlexUnavailableError";
  }
}

/** Attribute soup from Preferences.xml — a single self-closing element. */
async function readPreferences(): Promise<Record<string, string>> {
  let xml: string;
  try {
    xml = await readFile(PREFS_PATH, "utf8");
  } catch {
    return {};
  }
  const attrs: Record<string, string> = {};
  for (const match of xml.matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

async function systemctl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("systemctl", args, { timeout: 20000 });
    return stdout.trim();
  } catch (error) {
    // `is-active`/`is-enabled` exit non-zero for inactive/disabled units and
    // still print the state on stdout — that's an answer, not a failure.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return stdout.trim();
    throw error;
  }
}

async function installedVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("dpkg-query", ["-W", "-f=${Version}", "plexmediaserver"], {
      timeout: 10000
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function plexToken(): Promise<string | null> {
  const prefs = await readPreferences();
  return prefs.PlexOnlineToken || null;
}

/** GET against the local Plex API. Returns null when Plex isn't answering. */
async function plexGet<T>(path: string, token: string | null): Promise<T | null> {
  const url = new URL(path, ORIGIN);
  if (token) url.searchParams.set("X-Plex-Token", token);
  try {
    const res = await fetch(url, {
      headers: JSON_HEADERS,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getPlexStatus(): Promise<PlexStatus> {
  const [version, active, enabled, prefs] = await Promise.all([
    installedVersion(),
    systemctl("is-active", UNIT).catch(() => "unknown"),
    systemctl("is-enabled", UNIT).catch(() => "disabled"),
    readPreferences()
  ]);

  const running = active === "active";
  const identity = running
    ? await plexGet<{ MediaContainer?: { machineIdentifier?: string; version?: string } }>(
        "/identity",
        null
      )
    : null;

  return {
    installed: version !== null,
    version: identity?.MediaContainer?.version ?? version,
    state: active,
    running,
    enabled: enabled === "enabled",
    reachable: identity !== null,
    claimed: Boolean(prefs.PlexOnlineToken),
    account: prefs.PlexOnlineUsername || prefs.PlexOnlineMail || null,
    friendlyName: prefs.FriendlyName || null,
    machineIdentifier: identity?.MediaContainer?.machineIdentifier ?? prefs.MachineIdentifier ?? null,
    port: 32400,
    updatedAt: new Date().toISOString()
  };
}

export async function setPlexPower(action: PlexPowerAction): Promise<PlexStatus> {
  await systemctl(action, UNIT);
  // systemd returns as soon as the unit is handed off; give Plex a moment to
  // bind (or release) 32400 so the status we hand back isn't a stale snapshot.
  if (action !== "stop") await new Promise((resolve) => setTimeout(resolve, 2500));
  return getPlexStatus();
}

export async function setPlexAutostart(enabled: boolean): Promise<PlexStatus> {
  await systemctl(enabled ? "enable" : "disable", UNIT);
  return getPlexStatus();
}

type SectionDirectory = {
  key: string;
  title: string;
  type: string;
  agent?: string;
  refreshing?: boolean;
  updatedAt?: number;
  Location?: Array<{ path?: string }>;
};

export async function listPlexLibraries(): Promise<PlexLibrary[]> {
  const token = await plexToken();
  const res = await plexGet<{ MediaContainer?: { Directory?: SectionDirectory[] } }>(
    "/library/sections",
    token
  );
  if (!res) throw new PlexUnavailableError("Plex is not responding on 127.0.0.1:32400");
  const sections = res.MediaContainer?.Directory ?? [];

  // `X-Plex-Container-Size=0` asks for the count only, not the items.
  return Promise.all(
    sections.map(async (section) => {
      const counted = await plexGet<{ MediaContainer?: { totalSize?: number; size?: number } }>(
        `/library/sections/${encodeURIComponent(section.key)}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
        token
      );
      const container = counted?.MediaContainer;
      return {
        key: section.key,
        title: section.title,
        type: section.type,
        agent: section.agent ?? null,
        scanning: Boolean(section.refreshing),
        itemCount: container?.totalSize ?? container?.size ?? null,
        locations: (section.Location ?? []).map((l) => l.path ?? "").filter(Boolean),
        updatedAt: section.updatedAt ? new Date(section.updatedAt * 1000).toISOString() : null
      };
    })
  );
}

/** Kick off a scan. Plex acknowledges immediately and scans in the background. */
export async function refreshPlexLibrary(key: string): Promise<void> {
  const token = await plexToken();
  const url = new URL(`/library/sections/${encodeURIComponent(key)}/refresh`, ORIGIN);
  if (token) url.searchParams.set("X-Plex-Token", token);
  const res = await fetch(url, {
    headers: JSON_HEADERS,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  }).catch(() => null);
  if (!res || !res.ok) {
    throw new PlexUnavailableError(`Could not start a scan for library ${key}`);
  }
}

// --- Media files ---------------------------------------------------------
//
// Uploads land in the on-disk tree Plex scans. The control plane runs as root,
// so every path derived from client input is validated twice: each segment is
// sanitized, then the resolved absolute path is re-checked against the library
// root before anything is opened for writing.

export const MEDIA_ROOT = "/srv/media";
export const MEDIA_LIBRARIES = ["movies", "tv", "music"] as const;
export type MediaLibrary = (typeof MEDIA_LIBRARIES)[number];

/**
 * Extensions Plex can actually make use of. This keeps the endpoint from
 * doubling as a general-purpose file drop onto the host.
 */
const ALLOWED_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m2ts",
  ".mpg", ".mpeg", ".iso", ".m4b", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus",
  ".wav", ".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".nfo", ".jpg", ".jpeg", ".png"
]);

/** Leave this much headroom on the filesystem rather than filling it. */
const DISK_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

class UploadRejectedError extends Error {
  statusCode = 400;
  code = "PLEX_UPLOAD_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

class InsufficientSpaceError extends Error {
  statusCode = 507;
  code = "PLEX_DISK_FULL";
  constructor(message: string) {
    super(message);
    this.name = "InsufficientSpaceError";
  }
}

/**
 * Reduce arbitrary client text to a single safe path segment: no directory
 * separators, no traversal, no control characters, no leading dots.
 */
function safeSegment(input: string, label: string): string {
  const flattened = input.replace(/\\/g, "/");
  const base = path.posix.basename(flattened);
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new UploadRejectedError(`Invalid ${label}`);
  }
  if (cleaned.length > 255) {
    throw new UploadRejectedError(`${label} is too long`);
  }
  return cleaned;
}

export function isMediaLibrary(value: string): value is MediaLibrary {
  return (MEDIA_LIBRARIES as readonly string[]).includes(value);
}

/**
 * Build the destination path and prove it stays inside the library root even
 * after symlink-free normalisation.
 */
function resolveTarget(library: MediaLibrary, filename: string, folder?: string): {
  dir: string;
  file: string;
} {
  const safeFile = safeSegment(filename, "file name");
  const ext = path.extname(safeFile).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new UploadRejectedError(
      `Unsupported file type "${ext || "(none)"}" — Plex accepts video, audio, subtitle and artwork files`
    );
  }
  const libraryRoot = path.join(MEDIA_ROOT, library);
  const dir = folder ? path.join(libraryRoot, safeSegment(folder, "folder name")) : libraryRoot;
  const file = path.join(dir, safeFile);
  const withSep = libraryRoot.endsWith(path.sep) ? libraryRoot : `${libraryRoot}${path.sep}`;
  if (!file.startsWith(withSep)) {
    throw new UploadRejectedError("Resolved path escapes the media library");
  }
  return { dir, file };
}

async function assertSpaceFor(bytes: number | null): Promise<void> {
  if (!bytes || bytes <= 0) return;
  try {
    const fsStat = await statfs(MEDIA_ROOT);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    if (bytes + DISK_HEADROOM_BYTES > free) {
      throw new InsufficientSpaceError(
        `Not enough disk space: need ${Math.ceil(bytes / 1e9)} GB, ${Math.floor(free / 1e9)} GB free`
      );
    }
  } catch (error) {
    // Only the deliberate rejection propagates; a platform without statfs
    // shouldn't block uploads entirely.
    if (error instanceof InsufficientSpaceError) throw error;
  }
}

export type UploadResult = {
  library: MediaLibrary;
  path: string;
  bytes: number;
  scanStarted: boolean;
};

/**
 * Stream an upload straight to disk. Writes to a `.part` sidecar first so a
 * half-finished file is never visible to a Plex scan, then renames into place.
 */
export async function saveMediaUpload(opts: {
  library: MediaLibrary;
  filename: string;
  folder?: string;
  source: Readable;
  declaredBytes: number | null;
}): Promise<UploadResult> {
  const { dir, file } = resolveTarget(opts.library, opts.filename, opts.folder);
  await assertSpaceFor(opts.declaredBytes);

  await mkdir(dir, { recursive: true, mode: 0o2775 });
  const partial = `${file}.part`;

  try {
    await pipeline(opts.source, createWriteStream(partial, { flags: "w", mode: 0o664 }));
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }

  // Size is read back off the finished file rather than counted from a `data`
  // listener — attaching one would flip the request into flowing mode before
  // pipeline() takes over.
  const written = await stat(partial);
  const bytes = written.size;

  if (bytes === 0) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new UploadRejectedError("Upload was empty");
  }

  await rename(partial, file);
  // The setgid bit on the tree gives group=plex; make sure the mode lets the
  // plex user actually read what root just wrote.
  await chmod(file, 0o664).catch(() => undefined);

  const scanStarted = await refreshLibraryForDir(path.join(MEDIA_ROOT, opts.library));

  return { library: opts.library, path: file, bytes, scanStarted };
}

/** Ask Plex to rescan whichever section owns `dir`. Best effort. */
async function refreshLibraryForDir(dir: string): Promise<boolean> {
  try {
    const libraries = await listPlexLibraries();
    const match = libraries.find((lib) =>
      lib.locations.some((loc) => loc === dir || dir.startsWith(`${loc}/`) || loc.startsWith(`${dir}/`))
    );
    if (!match) return false;
    await refreshPlexLibrary(match.key);
    return true;
  } catch {
    return false;
  }
}

const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m2ts", ".mpg", ".mpeg", ".iso"
]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt"]);

export type MediaSubtitle = {
  name: string;
  relativePath: string;
  /** Language code parsed out of the filename, e.g. "da" in Movie.da.srt. */
  language: string | null;
  bytes: number;
};

export type MediaFile = {
  name: string;
  /** Relative to the library root, so the UI can show one-movie-per-folder. */
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  partial: boolean;
  kind: "video" | "subtitle" | "other";
  /** Sidecar subtitles Plex will pair with this video. Videos only. */
  subtitles: MediaSubtitle[];
};

function classify(name: string): MediaFile["kind"] {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  return "other";
}

/**
 * Plex pairs a sidecar subtitle with a video when it lives in the same folder
 * and its name begins with the video's basename. Everything between that
 * basename and the extension is Plex's language/flag suffix.
 */
function subtitleLanguage(videoBase: string, subtitleName: string): string | null {
  const withoutExt = subtitleName.slice(0, -path.extname(subtitleName).length);
  const suffix = withoutExt.slice(videoBase.length).replace(/^\./, "");
  if (!suffix) return null;
  const parts = suffix.split(".").filter(Boolean);
  const code = parts.find((p) => /^[A-Za-z]{2,3}$/.test(p));
  return code ? code.toLowerCase() : (parts[0] ?? null);
}

/**
 * Listing of a library directory, one level of nesting deep. Sidecar subtitles
 * are folded into the video they belong to rather than listed on their own, so
 * the UI can show "this movie has Danish and English subs" at a glance. A
 * subtitle matching no video stays top-level so it isn't silently hidden.
 */
export async function listMediaFiles(library: MediaLibrary): Promise<MediaFile[]> {
  const root = path.join(MEDIA_ROOT, library);
  const out: MediaFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 500) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      out.push({
        name: entry.name,
        relativePath: path.relative(root, full),
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        partial: entry.name.endsWith(".part"),
        kind: classify(entry.name),
        subtitles: []
      });
    }
  }

  await walk(root, 0);

  const videos = out.filter((f) => f.kind === "video");
  const claimed = new Set<string>();
  for (const video of videos) {
    const dir = path.posix.dirname(video.relativePath.split(path.sep).join("/"));
    const base = video.name.slice(0, -path.extname(video.name).length);
    for (const candidate of out) {
      if (candidate.kind !== "subtitle") continue;
      const candidateDir = path.posix.dirname(candidate.relativePath.split(path.sep).join("/"));
      if (candidateDir !== dir) continue;
      if (!candidate.name.startsWith(base)) continue;
      video.subtitles.push({
        name: candidate.name,
        relativePath: candidate.relativePath,
        language: subtitleLanguage(base, candidate.name),
        bytes: candidate.bytes
      });
      claimed.add(candidate.relativePath);
    }
    video.subtitles.sort((a, b) => (a.language ?? "").localeCompare(b.language ?? ""));
  }

  return out
    .filter((f) => !claimed.has(f.relativePath))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Store a subtitle beside its video under the name Plex expects, so the user
 * never has to get `<video basename>.<lang>.<ext>` right by hand.
 */
export async function saveMediaSubtitle(opts: {
  library: MediaLibrary;
  /** relativePath of the video this subtitle belongs to. */
  target: string;
  language: string;
  filename: string;
  source: Readable;
}): Promise<{ path: string; name: string; language: string; scanStarted: boolean }> {
  const root = path.join(MEDIA_ROOT, opts.library);
  const segments = opts.target.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.length > 3) {
    throw new UploadRejectedError("Invalid target path");
  }
  const videoPath = path.join(root, ...segments.map((s) => safeSegment(s, "target path")));
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!videoPath.startsWith(withSep)) {
    throw new UploadRejectedError("Target escapes the media library");
  }

  const videoInfo = await stat(videoPath).catch(() => null);
  if (!videoInfo?.isFile()) throw new UploadRejectedError("Target video does not exist");
  if (classify(path.basename(videoPath)) !== "video") {
    throw new UploadRejectedError("Target is not a video file");
  }

  const ext = path.extname(safeSegment(opts.filename, "file name")).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(ext)) {
    throw new UploadRejectedError(`"${ext || "(none)"}" is not a subtitle file`);
  }
  const language = opts.language.toLowerCase();
  if (!/^[a-z]{2,3}$/.test(language)) {
    throw new UploadRejectedError("Language must be a 2- or 3-letter code");
  }

  const videoBase = path.basename(videoPath, path.extname(videoPath));
  const name = `${videoBase}.${language}${ext}`;
  const destination = path.join(path.dirname(videoPath), name);
  const partial = `${destination}.part`;

  try {
    await pipeline(opts.source, createWriteStream(partial, { flags: "w", mode: 0o664 }));
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }

  const written = await stat(partial);
  if (written.size === 0) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new UploadRejectedError("Subtitle file was empty");
  }

  await rename(partial, destination);
  await chmod(destination, 0o664).catch(() => undefined);

  const scanStarted = await refreshLibraryForDir(root);
  return { path: destination, name, language, scanStarted };
}

export async function deleteMediaFile(library: MediaLibrary, relativePath: string): Promise<void> {
  const root = path.join(MEDIA_ROOT, library);
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 3) {
    throw new UploadRejectedError("Invalid path");
  }
  const resolved = path.join(root, ...segments.map((s) => safeSegment(s, "path")));
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(withSep)) throw new UploadRejectedError("Path escapes the media library");
  await rm(resolved, { force: true });
}

type SessionMetadata = {
  sessionKey?: string;
  title?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  type?: string;
  viewOffset?: number;
  duration?: number;
  User?: { title?: string };
  Player?: { title?: string; product?: string; state?: string };
  TranscodeSession?: { videoDecision?: string; audioDecision?: string };
};

export async function listPlexSessions(): Promise<PlexSession[]> {
  const token = await plexToken();
  const res = await plexGet<{ MediaContainer?: { Metadata?: SessionMetadata[] } }>(
    "/status/sessions",
    token
  );
  if (!res) throw new PlexUnavailableError("Plex is not responding on 127.0.0.1:32400");
  const items = res.MediaContainer?.Metadata ?? [];
  return items.map((item, index) => ({
    sessionKey: item.sessionKey ?? String(index),
    title: item.title ?? "Unknown",
    parentTitle: item.grandparentTitle ?? item.parentTitle ?? null,
    type: item.type ?? "unknown",
    user: item.User?.title ?? null,
    player: item.Player?.title ?? item.Player?.product ?? null,
    playerState: item.Player?.state ?? null,
    viewOffset: typeof item.viewOffset === "number" ? item.viewOffset : null,
    duration: typeof item.duration === "number" ? item.duration : null,
    transcoding: Boolean(item.TranscodeSession),
    videoDecision: item.TranscodeSession?.videoDecision ?? null
  }));
}

/** Tail of the Plex Media Server log, for the tab's diagnostics panel. */
export async function readPlexLog(lines: number): Promise<string> {
  const capped = Math.min(Math.max(lines, 1), 2000);
  try {
    const { stdout } = await run(
      "tail",
      [
        "-n",
        String(capped),
        "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Logs/Plex Media Server.log"
      ],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    // Before the first start the log file doesn't exist yet — fall back to
    // journald so the panel still shows why the unit isn't coming up.
    const journal = await run("journalctl", ["-u", UNIT, "-n", String(capped), "--no-pager"], {
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024
    }).catch(() => ({ stdout: "" }));
    return journal.stdout;
  }
}
