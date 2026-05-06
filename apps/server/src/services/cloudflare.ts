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
import { getSecretSetting, getSetting, setSetting } from "./settings.js";

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
  const candidates = [configured, "cloudflared"].filter(Boolean) as string[];
  for (const bin of candidates) {
    try {
      const out = execSync(`${bin} --version`, {
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
