import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { execSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, insertLog, nowIso } from "../lib/core.js";
import { deleteSetting, getSecretSetting, getSetting, setSetting } from "./settings.js";

/**
 * Upsert a system-managed env var on a service. System rows are write-locked
 * from the manual env CRUD endpoints in routes/services.ts.
 */
export function setSystemEnv(ctx: AppContext, serviceId: string, key: string, value: string | null): void {
  if (value === null) {
    ctx.db
      .prepare("DELETE FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 1")
      .run(serviceId, key);
    return;
  }
  const existing = ctx.db
    .prepare("SELECT id FROM env_vars WHERE service_id = ? AND key = ? AND COALESCE(system, 0) = 1")
    .get(serviceId, key) as { id?: string } | undefined;
  if (existing?.id) {
    ctx.db.prepare("UPDATE env_vars SET value = ? WHERE id = ?").run(value, existing.id);
  } else {
    ctx.db
      .prepare(
        "INSERT INTO env_vars (id, service_id, key, value, is_secret, system) VALUES (?, ?, ?, ?, 0, 1)"
      )
      .run(nanoid(), serviceId, key, value);
  }
}

/**
 * Runtime state for a single managed `cloudflared tunnel run` child process.
 */
type TunnelRuntime = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: string;
  lastLines: string[];
  restartCount: number;
};

const STATE: { tunnel: TunnelRuntime | null } = { tunnel: null };

// ===== Per-service quick tunnel state =======================================

type QuickTunnelRuntime = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  serviceId: string;
  tunnelUrl: string | null;
  startedAt: string;
  lastLines: string[];
  stopRequested: boolean;
};

const QUICK_TUNNELS = new Map<string, QuickTunnelRuntime>();

// ===== Browser-login ("Connect Cloudflare") tunnel state ====================
// A self-managed, login-based named tunnel that lives alongside the existing
// token-based path. The login child is transient (mirrors QuickTunnelRuntime's
// line-buffer + regex capture); the run child is long-lived and supervised
// (mirrors STATE.tunnel's auto-restart). All cloudflared files live under
// dataRoot/cloudflared (never ~/.cloudflared), via TUNNEL_ORIGIN_CERT + --config.

const LOGIN_TUNNEL_NAME = "serverhoster";
/** The browser-auth URL cloudflared prints during `tunnel login`. */
export const CF_LOGIN_URL_RE = /https:\/\/dash\.cloudflare\.com\/argotunnel\S*/i;

type LoginRuntime = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  authUrl: string | null;
  startedAt: string;
  lastLines: string[];
  done: boolean;
};

type ManagedRuntime = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: string;
  lastLines: string[];
  restartCount: number;
  stopRequested: boolean;
};

const LOGIN_STATE: { login: LoginRuntime | null; managed: ManagedRuntime | null } = {
  login: null,
  managed: null
};

// Set after a successful FORCED re-auth: the new authorization may be a different
// Cloudflare account, so the persisted tunnel id must be revalidated once before
// it's trusted again. Checked (and cleared) by ensureNamedTunnel — kept to a
// single `tunnel info` call rather than validating on every status poll.
let pendingTunnelRevalidation = false;

/** Directory holding cert.pem / <name>.json / config.yml — under dataRoot. */
function cfDir(ctx: AppContext): string {
  const dir = path.join(ctx.config.dataRoot, "cloudflared");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/**
 * Where the login cert lives. `cloudflared tunnel login` IGNORES
 * TUNNEL_ORIGIN_CERT and writes cert.pem to its default ~/.cloudflared/cert.pem,
 * so we must accept it there: prefer our data-dir copy if present, otherwise
 * fall back to the home default the login actually produced. (Without this the
 * "Connect Cloudflare" poll spins forever even after a successful authorize.)
 */
function certPath(ctx: AppContext): string {
  const dataCert = path.join(cfDir(ctx), "cert.pem");
  if (fs.existsSync(dataCert)) return dataCert;
  const homeCert = path.join(os.homedir(), ".cloudflared", "cert.pem");
  if (fs.existsSync(homeCert)) return homeCert;
  return dataCert;
}

/** The cert locations a forced re-auth moves aside (and may need to reclaim). */
function certBackupCandidates(ctx: AppContext): string[] {
  return [path.join(cfDir(ctx), "cert.pem"), path.join(os.homedir(), ".cloudflared", "cert.pem")];
}

/**
 * Recover a cert that a crashed/interrupted forced re-auth left as
 * "<path>.survhub-bak": if the real cert is gone but its backup survives, move
 * the backup back. Without this, a crash mid-re-auth would strand the user's
 * only cert in a .bak forever and they'd appear disconnected. Idempotent.
 */
function reclaimOrphanedCert(p: string): void {
  const bak = `${p}.survhub-bak`;
  try {
    if (!fs.existsSync(p) && fs.existsSync(bak)) fs.renameSync(bak, p);
  } catch {
    /* best effort */
  }
}
function configPath(ctx: AppContext): string {
  return path.join(cfDir(ctx), "config.yml");
}
/** Shared env so the management/run cloudflared commands read the resolved origincert. */
function cfEnv(ctx: AppContext): NodeJS.ProcessEnv {
  return { ...process.env, TUNNEL_ORIGIN_CERT: certPath(ctx) };
}
function pushLoginLine(line: string): void {
  const r = LOGIN_STATE.login;
  if (!r) return;
  r.lastLines.push(line);
  if (r.lastLines.length > 200) r.lastLines.shift();
}
function pushManagedLine(line: string): void {
  const r = LOGIN_STATE.managed;
  if (!r) return;
  r.lastLines.push(line);
  if (r.lastLines.length > 200) r.lastLines.shift();
}

/**
 * Parse a tunnel UUID out of `cloudflared tunnel list -o json` (an array) or
 * `cloudflared tunnel create -o json` (an object). Tolerant of `id` vs `ID`
 * casing across cloudflared versions. Pure — unit-testable without spawning.
 */
export function parseTunnelId(output: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse((output || "").trim() || "null");
  } catch {
    return null;
  }
  const pick = (o: unknown): string | null => {
    if (!o || typeof o !== "object") return null;
    const rec = o as Record<string, unknown>;
    const v = rec.id ?? rec.ID;
    return typeof v === "string" && v ? v : null;
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const id = pick(item);
      if (id) return id;
    }
    return null;
  }
  return pick(parsed);
}

/** Build the cloudflared config.yml body for a set of (domain, port) ingress rules. */
export function buildIngressConfig(
  tunnelId: string,
  credsPath: string,
  routes: Array<{ domain: string; port: number }>
): string {
  const ingressLines = routes
    .map((r) => `  - hostname: ${r.domain}\n    service: http://localhost:${r.port}`)
    .join("\n");
  return (
    `tunnel: ${tunnelId}\n` +
    `credentials-file: ${credsPath}\n` +
    `ingress:\n` +
    (ingressLines ? `${ingressLines}\n` : "") +
    `  - service: http_status:404\n`
  );
}

// Pin to a known-good cloudflared version. Floating "latest" means a Cloudflare
// release can silently change behaviour in users' installs. Bump deliberately
// when verifying a new tunnel-side change. Override per-host with the env var
// SURVHUB_CLOUDFLARED_VERSION (e.g. "2025.5.0") to test a different release.
const CLOUDFLARED_VERSION = process.env.SURVHUB_CLOUDFLARED_VERSION ?? "2025.5.0";
const CLOUDFLARED_RELEASES = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

function getCloudflaredDownloadUrl(): string {
  const platform = os.platform();
  const arch = os.arch();
  const platformMap: Record<string, Record<string, string>> = {
    linux: { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64" },
    darwin: { x64: "cloudflared-darwin-amd64", arm64: "cloudflared-darwin-arm64" },
    win32: { x64: "cloudflared-windows-amd64.exe", arm64: "cloudflared-windows-arm64.exe" }
  };
  const filename = platformMap[platform]?.[arch];
  if (!filename) throw new Error(`Unsupported platform for auto-install: ${platform}/${arch}`);
  return `${CLOUDFLARED_RELEASES}/${filename}`;
}

export async function ensureCloudflared(ctx: AppContext): Promise<string> {
  const existing = detectCloudflared(ctx);
  if (existing.binary) return existing.binary;

  const binDir = path.join(ctx.config.dataRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binaryName = os.platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const binaryPath = path.join(binDir, binaryName);

  if (fs.existsSync(binaryPath)) {
    setSetting(ctx, "cloudflared_binary_path", binaryPath);
    return binaryPath;
  }

  const url = getCloudflaredDownloadUrl();
  broadcast(ctx, { type: "cloudflared_install", status: "downloading", url });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download cloudflared: HTTP ${response.status}`);
  if (!response.body) throw new Error("No response body from cloudflared download");

  const tmpPath = `${binaryPath}.tmp`;
  await pipeline(response.body as any, createWriteStream(tmpPath));
  if (os.platform() !== "win32") fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, binaryPath);

  setSetting(ctx, "cloudflared_binary_path", binaryPath);
  broadcast(ctx, { type: "cloudflared_install", status: "done", binaryPath });
  return binaryPath;
}

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function startQuickTunnel(ctx: AppContext, serviceId: string, port: number): void {
  if (QUICK_TUNNELS.has(serviceId)) return;

  const detected = detectCloudflared(ctx);
  if (!detected.binary) {
    throw new Error(
      "cloudflared binary not found. Use POST /cloudflare/install-cloudflared to auto-install."
    );
  }

  const child = spawn(detected.binary, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const runtime: QuickTunnelRuntime = {
    child,
    serviceId,
    tunnelUrl: null,
    startedAt: nowIso(),
    lastLines: [],
    stopRequested: false
  };
  QUICK_TUNNELS.set(serviceId, runtime);

  const onData = (data: Buffer): void => {
    const chunk = data.toString();
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      runtime.lastLines.push(line);
      if (runtime.lastLines.length > 200) runtime.lastLines.shift();
      broadcast(ctx, { type: "quick_tunnel_log", serviceId, line, timestamp: nowIso() });
      if (!runtime.tunnelUrl) {
        const match = QUICK_TUNNEL_URL_RE.exec(line);
        if (match) {
          runtime.tunnelUrl = match[0];
          ctx.db.transaction(() => {
            ctx.db
              .prepare("UPDATE services SET tunnel_url = ?, updated_at = ? WHERE id = ?")
              .run(runtime.tunnelUrl, nowIso(), serviceId);
            setSystemEnv(ctx, serviceId, "PUBLIC_URL", runtime.tunnelUrl!);
          })();
          broadcast(ctx, { type: "tunnel_url", serviceId, tunnelUrl: runtime.tunnelUrl });
          broadcast(ctx, { type: "exposure_changed", serviceId });
          insertLog(ctx, serviceId, "info", `Quick tunnel active: ${runtime.tunnelUrl}`);
        }
      }
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("exit", (code, signal) => {
    const wasStop = runtime.stopRequested;
    QUICK_TUNNELS.delete(serviceId);
    ctx.db.transaction(() => {
      ctx.db
        .prepare("UPDATE services SET tunnel_url = NULL, updated_at = ? WHERE id = ?")
        .run(nowIso(), serviceId);
      setSystemEnv(ctx, serviceId, "PUBLIC_URL", null);
    })();
    broadcast(ctx, { type: "tunnel_url", serviceId, tunnelUrl: null });
    broadcast(ctx, { type: "exposure_changed", serviceId });
    if (!wasStop) {
      broadcast(ctx, { type: "quick_tunnel_exited", serviceId, code, signal });
      insertLog(ctx, serviceId, "warn", `Quick tunnel exited (code=${code})`);
    }
  });

  broadcast(ctx, { type: "quick_tunnel_started", serviceId, pid: child.pid });
}

export function stopQuickTunnel(ctx: AppContext, serviceId: string): void {
  const runtime = QUICK_TUNNELS.get(serviceId);
  if (!runtime) return;
  runtime.stopRequested = true;
  try {
    runtime.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

export function stopAllQuickTunnels(): void {
  for (const [, runtime] of QUICK_TUNNELS.entries()) {
    runtime.stopRequested = true;
    try {
      runtime.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  QUICK_TUNNELS.clear();
}

export function getQuickTunnelStatus(serviceId: string): {
  running: boolean;
  tunnelUrl: string | null;
  pid: number | null;
  startedAt: string | null;
} {
  const runtime = QUICK_TUNNELS.get(serviceId);
  return {
    running: Boolean(runtime && !runtime.child.killed),
    tunnelUrl: runtime?.tunnelUrl ?? null,
    pid: runtime?.child.pid ?? null,
    startedAt: runtime?.startedAt ?? null
  };
}

export type TunnelStatus = {
  cloudflaredInstalled: boolean;
  binaryPath: string | null;
  version: string | null;
  tokenConfigured: boolean;
  apiTokenConfigured: boolean;
  accountId: string | null;
  tunnelId: string | null;
  zoneId: string | null;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  recentOutput: string[];
};

export function detectCloudflared(ctx: AppContext): { binary: string | null; version: string | null } {
  const configured = getSetting(ctx, "cloudflared_binary_path");
  const exe = os.platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  // Probe, in order: the configured path, the survhub-managed install, then the
  // bare name (PATH lookup), then well-known absolute install locations. The
  // absolute fallbacks matter because a server launched outside an interactive
  // shell (Finder/launchd/double-clicked .command) often has a minimal PATH that
  // omits /opt/homebrew/bin, so a Homebrew-installed cloudflared is invisible to
  // a bare `cloudflared` lookup — which made "Go Public" fail despite it being
  // installed.
  const absoluteFallbacks =
    os.platform() === "win32"
      ? [
          path.join(process.env.ProgramFiles ?? "C:/Program Files", "cloudflared", exe),
          path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", exe)
        ]
      : [
          "/opt/homebrew/bin/cloudflared", // Homebrew (Apple Silicon)
          "/usr/local/bin/cloudflared", // Homebrew (Intel) / manual installs
          "/usr/bin/cloudflared",
          "/snap/bin/cloudflared",
          "/run/current-system/sw/bin/cloudflared" // NixOS
        ];
  const candidates = [
    configured,
    path.join(ctx.config.dataRoot, "bin", exe),
    "cloudflared",
    ...absoluteFallbacks
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    // For absolute paths, skip the spawn entirely if the file isn't there.
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    try {
      const out = execSync(`${JSON.stringify(bin)} --version`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      return { binary: bin, version: out };
    } catch {
      continue;
    }
  }
  return { binary: null, version: null };
}

export function getTunnelStatus(ctx: AppContext): TunnelStatus {
  const detected = detectCloudflared(ctx);
  const runtime = STATE.tunnel;
  return {
    cloudflaredInstalled: Boolean(detected.binary),
    binaryPath: detected.binary,
    version: detected.version,
    tokenConfigured: Boolean(getSecretSetting(ctx, "cloudflare_tunnel_token")),
    apiTokenConfigured: Boolean(getSecretSetting(ctx, "cloudflare_api_token")),
    accountId: getSetting(ctx, "cloudflare_account_id"),
    tunnelId: getSetting(ctx, "cloudflare_tunnel_id"),
    zoneId: getSetting(ctx, "cloudflare_zone_id"),
    running: Boolean(runtime && !runtime.child.killed),
    pid: runtime?.child.pid ?? null,
    startedAt: runtime?.startedAt ?? null,
    restartCount: runtime?.restartCount ?? 0,
    recentOutput: runtime?.lastLines ?? []
  };
}

function pushLine(line: string): void {
  const runtime = STATE.tunnel;
  if (!runtime) return;
  runtime.lastLines.push(line);
  if (runtime.lastLines.length > 200) runtime.lastLines.shift();
}

export function startTunnel(ctx: AppContext): TunnelStatus {
  if (STATE.tunnel && !STATE.tunnel.child.killed) return getTunnelStatus(ctx);
  const detected = detectCloudflared(ctx);
  if (!detected.binary) {
    throw new Error(
      "cloudflared binary not found on PATH. Install from https://github.com/cloudflare/cloudflared/releases or set `cloudflared_binary_path` in settings."
    );
  }
  const token = getSecretSetting(ctx, "cloudflare_tunnel_token");
  if (!token)
    throw new Error("Cloudflare tunnel token is not configured. Save it under Settings → Cloudflare.");

  const child = spawn(detected.binary, ["tunnel", "--no-autoupdate", "run", "--token", token], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  STATE.tunnel = {
    child,
    startedAt: nowIso(),
    lastLines: [`[${nowIso()}] Spawned ${detected.binary} tunnel run (pid ${child.pid})`],
    restartCount: 0
  };

  // Reset the lifetime restart budget once this child proves stable, so the cap
  // counts CONSECUTIVE failures — otherwise 10 transient restarts spread over
  // days permanently disable auto-restart.
  const stabilityTimer = setTimeout(() => {
    if (STATE.tunnel?.child === child) {
      (STATE as unknown as { prevRestarts?: number }).prevRestarts = 0;
    }
  }, 30_000);
  stabilityTimer.unref();

  const onData = (data: Buffer): void => {
    const chunk = data.toString();
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      pushLine(line);
      broadcast(ctx, { type: "tunnel_log", line, timestamp: nowIso() });
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("exit", (code, signal) => {
    clearTimeout(stabilityTimer);
    const msg = `[${nowIso()}] cloudflared exited (code=${code} signal=${signal})`;
    pushLine(msg);
    broadcast(ctx, { type: "tunnel_status", running: false, reason: msg });
    const wasExplicitStop = (STATE as unknown as { stopRequested?: boolean }).stopRequested;
    STATE.tunnel = null;
    if (wasExplicitStop) {
      (STATE as unknown as { stopRequested?: boolean }).stopRequested = false;
      return;
    }
    const prevRestarts = (STATE as unknown as { prevRestarts?: number }).prevRestarts ?? 0;
    if (prevRestarts >= 10) {
      broadcast(ctx, { type: "tunnel_status", running: false, reason: "restart limit reached" });
      return;
    }
    (STATE as unknown as { prevRestarts?: number }).prevRestarts = prevRestarts + 1;
    setTimeout(
      () => {
        try {
          startTunnel(ctx);
        } catch {
          /* swallow — surfaces via status endpoint */
        }
      },
      Math.min(30000, 2000 * (prevRestarts + 1))
    );
  });

  broadcast(ctx, { type: "tunnel_status", running: true, pid: child.pid, startedAt: STATE.tunnel.startedAt });
  return getTunnelStatus(ctx);
}

export function stopTunnel(ctx: AppContext): TunnelStatus {
  if (!STATE.tunnel) return getTunnelStatus(ctx);
  (STATE as unknown as { stopRequested?: boolean }).stopRequested = true;
  try {
    STATE.tunnel.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  return getTunnelStatus(ctx);
}

export function saveTunnelConfig(
  ctx: AppContext,
  updates: {
    accountId?: string;
    tunnelId?: string;
    zoneId?: string;
    cloudflaredBinaryPath?: string;
  }
): void {
  if (updates.accountId !== undefined) setSetting(ctx, "cloudflare_account_id", updates.accountId);
  if (updates.tunnelId !== undefined) setSetting(ctx, "cloudflare_tunnel_id", updates.tunnelId);
  if (updates.zoneId !== undefined) setSetting(ctx, "cloudflare_zone_id", updates.zoneId);
  if (updates.cloudflaredBinaryPath !== undefined) {
    setSetting(ctx, "cloudflared_binary_path", updates.cloudflaredBinaryPath);
  }
}

// ===== Cloudflare REST API helpers ==========================================

function requireApiToken(ctx: AppContext): string {
  const t = getSecretSetting(ctx, "cloudflare_api_token");
  if (!t)
    throw new Error("Cloudflare API token is not configured (needed for DNS + tunnel route registration).");
  return t;
}

async function cf<T>(ctx: AppContext, endpoint: string, init: RequestInit = {}): Promise<T> {
  const token = requireApiToken(ctx);
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const body = (await res.json()) as { success: boolean; errors?: Array<{ message: string }>; result: T };
  if (!res.ok || !body.success) {
    const err = body.errors?.map((e) => e.message).join(", ") ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${endpoint}: ${err}`);
  }
  return body.result;
}

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
};

export async function upsertDnsCname(
  ctx: AppContext,
  domain: string
): Promise<{ id: string; created: boolean }> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  const tunnelId = getSetting(ctx, "cloudflare_tunnel_id");
  if (!zoneId) throw new Error("cloudflare_zone_id not configured");
  if (!tunnelId) throw new Error("cloudflare_tunnel_id not configured");
  const cnameTarget = `${tunnelId}.cfargotunnel.com`;
  const records = await cf<DnsRecord[]>(
    ctx,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}`
  );
  const existing = records.find((r) => r.name === domain);
  if (existing) {
    if (existing.type === "CNAME" && existing.content === cnameTarget)
      return { id: existing.id, created: false };
    await cf<DnsRecord>(ctx, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ type: "CNAME", name: domain, content: cnameTarget, proxied: true })
    });
    return { id: existing.id, created: false };
  }
  const created = await cf<DnsRecord>(ctx, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "CNAME", name: domain, content: cnameTarget, proxied: true })
  });
  return { id: created.id, created: true };
}

type TunnelConfig = {
  config: {
    ingress: Array<{ hostname?: string; service: string; path?: string }>;
    warp_routing?: { enabled: boolean };
  };
};

/**
 * Serialize ingress mutations across the single named-tunnel daemon. Cloudflare's
 * configurations endpoint reads the current array, mutates it, then writes it
 * back — concurrent calls would clobber each other.
 */
let ingressMutex: Promise<unknown> = Promise.resolve();
function withIngressLock<T>(task: () => Promise<T>): Promise<T> {
  const next = ingressMutex.then(task, task);
  // Don't let a rejected task poison the chain for subsequent callers.
  ingressMutex = next.catch(() => undefined);
  return next;
}

/**
 * Add (or replace) an ingress rule in the tunnel configuration so traffic
 * for `domain` is forwarded to `http://localhost:<port>`. The catch-all rule
 * is always preserved at the end.
 */
export async function upsertTunnelIngress(
  ctx: AppContext,
  domain: string,
  targetPort: number
): Promise<void> {
  return withIngressLock(async () => {
    const accountId = getSetting(ctx, "cloudflare_account_id");
    const tunnelId = getSetting(ctx, "cloudflare_tunnel_id");
    if (!accountId) throw new Error("cloudflare_account_id not configured");
    if (!tunnelId) throw new Error("cloudflare_tunnel_id not configured");
    const current = await cf<TunnelConfig>(
      ctx,
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`
    );
    const existingIngress = current?.config?.ingress ?? [];
    const filtered = existingIngress.filter((r) => r.hostname !== domain && r.service !== "http_status:404");
    filtered.push({ hostname: domain, service: `http://localhost:${targetPort}` });
    filtered.push({ service: "http_status:404" });
    await cf(ctx, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress: filtered } })
    });
  });
}

/**
 * Remove a Cloudflare DNS record matching the given domain. Idempotent — silently
 * returns if the zone has no matching record. Used during service deletion and
 * domain change to prevent orphan records in the user's Cloudflare zone.
 */
export async function deleteDnsRecord(ctx: AppContext, domain: string): Promise<void> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId) return;
  const records = await cf<DnsRecord[]>(
    ctx,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}`
  );
  for (const record of records.filter((r) => r.name === domain)) {
    await cf<DnsRecord>(ctx, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
  }
}

export async function removeTunnelIngress(ctx: AppContext, domain: string): Promise<void> {
  return withIngressLock(async () => {
    const accountId = getSetting(ctx, "cloudflare_account_id");
    const tunnelId = getSetting(ctx, "cloudflare_tunnel_id");
    if (!accountId || !tunnelId) return;
    const current = await cf<TunnelConfig>(
      ctx,
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`
    );
    const existingIngress = current?.config?.ingress ?? [];
    const filtered = existingIngress.filter((r) => r.hostname !== domain);
    if (!filtered.some((r) => r.service === "http_status:404")) filtered.push({ service: "http_status:404" });
    await cf(ctx, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress: filtered } })
    });
  });
}

// ===== DNS-01 ACME helpers for Phase 4.4 ====================================

export async function createAcmeDnsRecord(ctx: AppContext, name: string, content: string): Promise<string> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId) throw new Error("cloudflare_zone_id not configured");
  const created = await cf<DnsRecord>(ctx, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "TXT", name, content, ttl: 60, proxied: false })
  });
  return created.id;
}

export async function deleteAcmeDnsRecord(ctx: AppContext, recordId: string): Promise<void> {
  const zoneId = getSetting(ctx, "cloudflare_zone_id");
  if (!zoneId) return;
  try {
    await cf(ctx, `/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
  } catch {
    /* best effort */
  }
}

// ===== Connect Cloudflare (browser login) ===================================

/**
 * Spawn `cloudflared tunnel login`, capture the dash.cloudflare.com/argotunnel
 * auth URL it prints, and hold the child in module state. The child blocks
 * until the user authorizes in the browser, then writes cert.pem into our
 * origincert dir and exits. Returns the URL as soon as it's parsed (≤8s).
 */
export async function startCloudflareLogin(
  ctx: AppContext,
  opts: { force?: boolean } = {}
): Promise<{ authUrl: string | null }> {
  // `force` re-runs the browser login even when already connected — needed to
  // authorize a DIFFERENT Cloudflare zone (the cert is single-zone).
  if (!opts.force && fs.existsSync(certPath(ctx))) return { authUrl: null };
  if (LOGIN_STATE.login && !LOGIN_STATE.login.child.killed) {
    return { authUrl: LOGIN_STATE.login.authUrl };
  }
  const detected = detectCloudflared(ctx);
  if (!detected.binary) {
    throw new Error(
      "cloudflared binary not found. Use POST /cloudflare/install-cloudflared to auto-install."
    );
  }

  // cloudflared refuses to overwrite an existing cert.pem, so a forced re-auth
  // moves the current one(s) aside. If the new login doesn't complete (user
  // cancels / times out) the exit handler restores them, so re-auth can never
  // leave the user disconnected.
  const backups: Array<{ from: string; to: string }> = [];
  if (opts.force) {
    for (const from of certBackupCandidates(ctx)) {
      // First recover any backup a prior crashed re-auth orphaned, so we never
      // clobber a real backup with the current cert and never lose the original.
      reclaimOrphanedCert(from);
      if (fs.existsSync(from)) {
        const to = `${from}.survhub-bak`;
        try {
          fs.renameSync(from, to);
          backups.push({ from, to });
        } catch {
          /* ignore — best effort */
        }
      }
    }
  }

  const child = spawn(detected.binary, ["tunnel", "login"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: cfEnv(ctx)
  });
  const runtime: LoginRuntime = { child, authUrl: null, startedAt: nowIso(), lastLines: [], done: false };
  LOGIN_STATE.login = runtime;

  const onData = (data: Buffer): void => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      pushLoginLine(line);
      broadcast(ctx, { type: "cf_login_log", line, timestamp: nowIso() });
      if (!runtime.authUrl) {
        const m = CF_LOGIN_URL_RE.exec(line);
        if (m) {
          runtime.authUrl = m[0];
          broadcast(ctx, { type: "cf_login_url", authUrl: runtime.authUrl });
        }
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    runtime.done = true;
    const connected = fs.existsSync(certPath(ctx));
    // A forced re-login that produced no new cert → restore the prior one(s).
    // Success → drop the backups (the new cert supersedes).
    for (const b of backups) {
      try {
        if (!connected && !fs.existsSync(b.from)) fs.renameSync(b.to, b.from);
        else fs.rmSync(b.to, { force: true });
      } catch {
        /* ignore */
      }
    }
    // A fresh forced authorization may be a different account → the cached tunnel
    // id could be stale. Flag a one-shot revalidation for the next ensure.
    if (opts.force && connected) pendingTunnelRevalidation = true;
    if (LOGIN_STATE.login === runtime) LOGIN_STATE.login = null;
    broadcast(ctx, { type: "cf_login_status", connected, code });
    broadcast(ctx, { type: "exposure_changed" });
  });

  const deadline = Date.now() + 8000;
  while (!runtime.authUrl && Date.now() < deadline && !runtime.done) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return { authUrl: runtime.authUrl };
}

export function getCloudflareLoginStatus(ctx: AppContext): {
  connected: boolean;
  loginInProgress: boolean;
  authUrl: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  managedRunning: boolean;
  recentOutput: string[];
} {
  const login = LOGIN_STATE.login;
  return {
    connected: isCloudflareConnected(ctx),
    loginInProgress: Boolean(login && !login.child.killed && !login.done),
    authUrl: login?.authUrl ?? null,
    tunnelId: getSetting(ctx, "cloudflare_login_tunnel_id"),
    tunnelName: getSetting(ctx, "cloudflare_login_tunnel_name"),
    managedRunning: Boolean(LOGIN_STATE.managed && !LOGIN_STATE.managed.child.killed),
    recentOutput: LOGIN_STATE.managed?.lastLines ?? login?.lastLines ?? []
  };
}

/** True when cert.pem exists AND a login tunnel id is persisted. */
export function isCloudflareConnected(ctx: AppContext): boolean {
  return fs.existsSync(certPath(ctx)) && Boolean(getSetting(ctx, "cloudflare_login_tunnel_id"));
}

/**
 * Create or reuse the "serverhoster" named tunnel. Requires cert.pem (login).
 * Idempotent: reuses a persisted id, else lists by name, else creates. Persists
 * {id, name, credsPath} and returns the UUID.
 */
export function ensureNamedTunnel(ctx: AppContext): { tunnelId: string; credsPath: string } {
  const detected = detectCloudflared(ctx);
  if (!detected.binary) throw new Error("cloudflared binary not found.");
  if (!fs.existsSync(certPath(ctx))) {
    throw new Error("Not connected to Cloudflare. Run the browser login first.");
  }
  const credsPath = path.join(cfDir(ctx), `${LOGIN_TUNNEL_NAME}.json`);
  const env = cfEnv(ctx);
  const bin = JSON.stringify(detected.binary);

  let tunnelId: string | null = getSetting(ctx, "cloudflare_login_tunnel_id");
  // After a forced re-auth, confirm the cached id still belongs to the now-active
  // account exactly once; if not, drop it and rediscover/recreate by name below.
  if (tunnelId && pendingTunnelRevalidation) {
    pendingTunnelRevalidation = false;
    try {
      execSync(`${bin} tunnel info -o json ${tunnelId}`, {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      deleteSetting(ctx, "cloudflare_login_tunnel_id");
      deleteSetting(ctx, "cloudflare_login_tunnel_name");
      tunnelId = null;
    }
  }
  if (!tunnelId) {
    try {
      const listed = execSync(`${bin} tunnel list -o json --name ${LOGIN_TUNNEL_NAME}`, {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"]
      });
      tunnelId = parseTunnelId(listed);
    } catch {
      /* fall through to create */
    }
  }
  if (!tunnelId) {
    const out = execSync(
      `${bin} tunnel create -o json --credentials-file ${JSON.stringify(credsPath)} ${LOGIN_TUNNEL_NAME}`,
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }
    );
    tunnelId = parseTunnelId(out);
    if (!tunnelId) throw new Error("Could not parse tunnel id from `cloudflared tunnel create` output");
  }
  // Recover a local creds file if the tunnel was reused but the JSON is missing.
  if (!fs.existsSync(credsPath)) {
    try {
      execSync(`${bin} tunnel token --cred-file ${JSON.stringify(credsPath)} ${LOGIN_TUNNEL_NAME}`, {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      /* the run child will surface a clear creds error if this fails */
    }
  }
  if (fs.existsSync(credsPath) && os.platform() !== "win32") {
    try {
      fs.chmodSync(credsPath, 0o600);
    } catch {
      /* best effort */
    }
  }
  setSetting(ctx, "cloudflare_login_tunnel_id", tunnelId);
  setSetting(ctx, "cloudflare_login_tunnel_name", LOGIN_TUNNEL_NAME);
  setSetting(ctx, "cloudflare_login_creds_path", credsPath);
  return { tunnelId, credsPath };
}

/** Read all bound (domain → port) routes and write config.yml; returns the path. */
export function writeIngressConfig(ctx: AppContext): string {
  const tunnelId = getSetting(ctx, "cloudflare_login_tunnel_id");
  const credsPath = getSetting(ctx, "cloudflare_login_creds_path");
  if (!tunnelId || !credsPath) throw new Error("Login tunnel not provisioned.");
  const routes = ctx.db
    .prepare(
      `SELECT pr.domain AS domain, COALESCE(pr.target_port, s.port) AS port
       FROM proxy_routes pr
       JOIN services s ON s.id = pr.service_id
       WHERE pr.domain IS NOT NULL AND COALESCE(pr.target_port, s.port) IS NOT NULL`
    )
    .all() as Array<{ domain: string; port: number }>;
  const file = configPath(ctx);
  fs.writeFileSync(file, buildIngressConfig(tunnelId, credsPath, routes), { encoding: "utf8" });
  return file;
}

/**
 * (Re)start the single managed `cloudflared tunnel --config <file> run <uuid>`
 * child. Supervised like STATE.tunnel (auto-restart, backoff, cap 10). Called
 * after every ingress change to pick up the rewritten config.yml.
 */
export function runManagedTunnel(ctx: AppContext): void {
  const detected = detectCloudflared(ctx);
  if (!detected.binary) throw new Error("cloudflared binary not found.");
  const tunnelId = getSetting(ctx, "cloudflare_login_tunnel_id");
  if (!tunnelId) throw new Error("Login tunnel not provisioned.");
  writeIngressConfig(ctx);

  const existing = LOGIN_STATE.managed;
  if (existing && !existing.child.killed) {
    existing.stopRequested = true;
    try {
      existing.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    LOGIN_STATE.managed = null;
  }

  const child = spawn(
    detected.binary,
    ["tunnel", "--no-autoupdate", "--config", configPath(ctx), "run", tunnelId],
    { stdio: ["ignore", "pipe", "pipe"], env: cfEnv(ctx) }
  );
  const runtime: ManagedRuntime = {
    child,
    startedAt: nowIso(),
    lastLines: [`[${nowIso()}] Spawned managed tunnel run ${tunnelId} (pid ${child.pid})`],
    restartCount: existing?.restartCount ?? 0,
    stopRequested: false
  };
  LOGIN_STATE.managed = runtime;

  const onData = (data: Buffer): void => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      pushManagedLine(line);
      broadcast(ctx, { type: "cf_managed_log", line, timestamp: nowIso() });
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, signal) => {
    const wasStop = runtime.stopRequested;
    if (LOGIN_STATE.managed === runtime) LOGIN_STATE.managed = null;
    broadcast(ctx, {
      type: "cf_managed_status",
      running: false,
      reason: `exit code=${code} signal=${signal}`
    });
    if (wasStop || runtime.restartCount >= 10) return;
    const next = runtime.restartCount + 1;
    setTimeout(() => {
      try {
        runManagedTunnel(ctx);
        if (LOGIN_STATE.managed) LOGIN_STATE.managed.restartCount = next;
      } catch {
        /* surfaces via status broadcast */
      }
    }, Math.min(30000, 2000 * next));
  });
  broadcast(ctx, { type: "cf_managed_status", running: true, pid: child.pid, startedAt: runtime.startedAt });
}

export function stopManagedTunnel(): void {
  const r = LOGIN_STATE.managed;
  if (!r) return;
  r.stopRequested = true;
  try {
    r.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  LOGIN_STATE.managed = null;
}

/**
 * Bind a domain to a service via the login tunnel: route DNS → upsert
 * proxy_routes/services → rewrite config + restart the shared child.
 */
/**
 * Pull the hostname cloudflared actually configured out of a `tunnel route dns`
 * log line ("Added CNAME <fqdn> …" or "<fqdn> is already configured to route …").
 * Returns it lowercased without a trailing dot, or null if no line matched. Used
 * to catch a wrong-zone bind (cloudflared appends the authorized zone when the
 * cert doesn't cover the domain's own zone).
 */
export function parseRoutedFqdn(routeOutput: string): string | null {
  // cloudflared phrases this several ways across versions and with --overwrite-dns:
  //   "Added CNAME <fqdn> which will route to this tunnel"
  //   "Updated CNAME <fqdn> ..."  (overwrite)
  //   "<fqdn> is already configured to route to your tunnel"
  //   "<fqdn> updated to route to your tunnel"  (overwrite)
  // Missing the overwrite phrasing here would let a wrong-zone overwrite bind
  // slip the only guard, so match all of them.
  const m = routeOutput.match(
    /(?:Added|Updated)\s+CNAME\s+(\S+)|(\S+)\s+(?:is already configured to route|updated to route)/i
  );
  const fqdn = (m?.[1] ?? m?.[2])?.replace(/\.$/, "").toLowerCase();
  return fqdn ?? null;
}

export function bindDomainViaLogin(
  ctx: AppContext,
  serviceId: string,
  domain: string,
  opts: { overwriteDns?: boolean } = {}
): { ok: true; domain: string; public_url: string } {
  const detected = detectCloudflared(ctx);
  if (!detected.binary) throw new Error("cloudflared binary not found.");
  const tunnelId = getSetting(ctx, "cloudflare_login_tunnel_id");
  if (!tunnelId) throw new Error("Not connected to Cloudflare.");
  const service = ctx.db.prepare("SELECT id, port FROM services WHERE id = ?").get(serviceId) as
    | { id: string; port?: number }
    | undefined;
  if (!service) throw new Error("Service not found");
  if (!service.port) throw new Error("Service has no port assigned");

  const flag = opts.overwriteDns ? " --overwrite-dns" : "";
  let routeOutput = "";
  try {
    // 2>&1 so cloudflared's "Added CNAME <fqdn>" / "<fqdn> is already configured"
    // log line (it writes to stderr even on success) is captured for the
    // wrong-zone check below.
    routeOutput = execSync(
      `${JSON.stringify(detected.binary)} tunnel route dns${flag} ${tunnelId} ${domain} 2>&1`,
      { encoding: "utf8", env: cfEnv(ctx), stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    const out =
      ((e as { stdout?: Buffer }).stdout?.toString() ?? "") +
      ((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    if (/already exists/i.test(out) && !opts.overwriteDns) {
      const err = new Error(
        `A DNS record for ${domain} already exists. Re-bind with "Overwrite existing DNS record" to replace it.`
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 409;
      err.code = "DNS_CONFLICT";
      throw err;
    }
    const err = new Error(
      `Could not create DNS for ${domain}. Make sure the domain is added to your Cloudflare account, then retry. (${out.trim() || (e as Error).message})`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = "ZONE_MISSING";
    throw err;
  }

  // When the login cert is authorized for a DIFFERENT zone than the domain's own
  // zone, cloudflared silently appends the authorized zone (binding fastprice.dk
  // with a cert scoped to mast3kmedia.dk → "fastprice.dk.mast3kmedia.dk") and
  // exits 0. That record is useless and the real zone never points at the tunnel
  // (the domain then 1000s). Detect the FQDN cloudflared actually configured and
  // refuse rather than record a route that will never resolve.
  const configuredFqdn = parseRoutedFqdn(routeOutput);
  if (configuredFqdn && configuredFqdn !== domain.toLowerCase()) {
    // The authorized zone is the suffix cloudflared appended:
    // "fastprice.dk.mast3kmedia.dk" minus "fastprice.dk." → "mast3kmedia.dk".
    const authorizedZone = configuredFqdn.startsWith(domain.toLowerCase() + ".")
      ? configuredFqdn.slice(domain.length + 1)
      : null;
    const err = new Error(
      `Cloudflare is authorized for the ${authorizedZone ? `"${authorizedZone}"` : "wrong"} zone, but "${domain}" is a separate Cloudflare zone — so its DNS won't resolve to your tunnel. Re-authorize Cloudflare and pick "${domain}" (or use an API token with DNS access to both zones).`
    ) as Error & { statusCode?: number; code?: string; meta?: Record<string, unknown> };
    err.statusCode = 409;
    err.code = "CF_WRONG_ZONE";
    err.meta = { authorizedZone, requestedDomain: domain };
    throw err;
  }

  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(serviceId);
    ctx.db
      .prepare(
        "INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(nanoid(), serviceId, domain, service.port, nowIso());
    ctx.db
      .prepare("UPDATE services SET ssl_status = 'cloudflare', updated_at = ? WHERE id = ?")
      .run(nowIso(), serviceId);
    setSystemEnv(ctx, serviceId, "PUBLIC_URL", `https://${domain}`);
  })();

  runManagedTunnel(ctx);
  broadcast(ctx, { type: "exposure_changed", serviceId });
  return { ok: true, domain, public_url: `https://${domain}` };
}

/**
 * Unbind via the login path: clear DB rows, rewrite config (dropping this
 * hostname), restart-or-stop the child. The CNAME is left to dead-end at the
 * 404 catch-all (deleting it needs the API token, intentionally avoided here).
 */
export function unbindDomainViaLogin(ctx: AppContext, serviceId: string): { ok: true } {
  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(serviceId);
    ctx.db.prepare("UPDATE services SET ssl_status = 'none', updated_at = ? WHERE id = ?").run(nowIso(), serviceId);
    setSystemEnv(ctx, serviceId, "PUBLIC_URL", null);
  })();
  const remaining = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM proxy_routes WHERE domain IS NOT NULL")
    .get() as { n: number };
  if (remaining.n > 0) runManagedTunnel(ctx);
  else stopManagedTunnel();
  broadcast(ctx, { type: "exposure_changed", serviceId });
  return { ok: true };
}

/**
 * Disconnect: stop the managed child and forget the persisted tunnel pointers.
 * cert.pem + creds JSON are left on disk so reconnecting is instant (no second
 * browser round-trip). Full revocation is a Cloudflare-dashboard action.
 */
export function disconnectCloudflare(ctx: AppContext): { ok: true } {
  stopManagedTunnel();
  deleteSetting(ctx, "cloudflare_login_tunnel_id");
  deleteSetting(ctx, "cloudflare_login_tunnel_name");
  broadcast(ctx, { type: "exposure_changed" });
  return { ok: true };
}

/**
 * Rewrite config.yml from the current proxy_routes and restart-or-stop the
 * managed connector accordingly. Call this after ANY change to the set of bound
 * domains (a service delete, a domain edit) so a removed route's hostname stops
 * being served — otherwise stale ingress lingers and can shadow/hijack another
 * service's domain. Safe no-op when not login-connected.
 */
export function refreshLoginIngress(ctx: AppContext): void {
  if (!isCloudflareConnected(ctx)) return;
  const remaining = (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM proxy_routes WHERE domain IS NOT NULL").get() as {
      n: number;
    }
  ).n;
  if (remaining > 0) {
    writeIngressConfig(ctx);
    runManagedTunnel(ctx);
  } else {
    stopManagedTunnel();
  }
}

/**
 * On boot, bring the managed login tunnel back up if we're connected and have
 * bound domains. The `cloudflared ... run` connector is a non-detached child, so
 * it dies with a ServerHoster restart — without re-running it here, every bound
 * custom domain returns Cloudflare 530 ("tunnel has no connector") until the
 * next bind.
 */
export function reconcileLoginTunnelOnBoot(ctx: AppContext): void {
  // Recover a cert stranded as .survhub-bak by a forced re-auth that crashed
  // before it could restore (otherwise the user boots up "disconnected").
  for (const p of certBackupCandidates(ctx)) reclaimOrphanedCert(p);
  if (!isCloudflareConnected(ctx)) return;
  const routes = (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM proxy_routes WHERE domain IS NOT NULL").get() as {
      n: number;
    }
  ).n;
  if (routes <= 0) return;
  try {
    runManagedTunnel(ctx);
    insertLog(ctx, "system", "info", "Re-started the Cloudflare login tunnel connector on boot.");
  } catch {
    /* surfaces via cf_managed_status broadcast */
  }
}
