/**
 * Managed n8n add-on.
 *
 * n8n runs as a Docker container (`serverhoster-n8n`), not a SURVHub service
 * row. Lifecycle mirrors the Plex tab (status, power, logs), plus what you need
 * to actually *use* n8n day to day:
 *
 *   - configuration that matters on a self-hosted box (timezone, execution
 *     pruning, secure-cookie handling, task runners, SMTP for invites, extra
 *     env, image channel) applied by recreating the container;
 *   - image updates (pull + recreate, data volume untouched);
 *   - the n8n Public API — workflows (activate / deactivate / import / export /
 *     delete) and executions (list / retry / delete). n8n has no env var for a
 *     Public API key: the owner creates one in Settings → n8n API and pastes it
 *     here, and we verify it against the API before storing it;
 *   - AI Gateway one-click wiring (OPENAI_API_KEY / OPENAI_BASE_URL);
 *   - LocalSURV → n8n event webhooks, installable in one click (we create and
 *     activate the receiving workflow through the API and register its URL).
 */

import crypto from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { getSetting, setSetting, getSecretSetting, setSecretSetting, deleteSetting } from "./settings.js";
import {
  getGatewayConfig,
  mintConsumerToken,
  listConsumerTokens,
  revokeConsumerToken,
  setGatewayConfig
} from "./aiGateway.js";
import { inferenceServerPort, inferenceServerRunning, startInferenceServer } from "./aiGatewayServer.js";
import { isExternalMode, getExternalTarget, externalMintToken } from "./aiGatewayExternal.js";
import { writeAuditLog } from "./audit.js";
import { nowIso } from "../lib/core.js";

type ContainerInspectInfo = {
  State: { Running: boolean; Status: string; StartedAt?: string; Health?: { Status?: string } };
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
  Image?: string;
};

const N8N_IMAGE_REPO = "docker.n8n.io/n8nio/n8n";
const N8N_CONTAINER = "serverhoster-n8n";
const N8N_PORT = 5678;
const LOCAL_BASE = `http://127.0.0.1:${N8N_PORT}`;

const SETTING_PUBLIC_URL = "n8n_public_url";
const SETTING_AUTOSTART = "n8n_autostart";
const SETTING_ENCRYPTION = "n8n_encryption_key";
const SETTING_API_KEY = "n8n_api_key";
const SETTING_AI_TOKEN = "n8n_ai_gateway_token";
const SETTING_AI_TOKEN_ID = "n8n_ai_gateway_token_id";
const SETTING_WEBHOOKS = "n8n_event_webhooks";
const SETTING_CONFIG = "n8n_config";
const SETTING_APPLIED_ENV = "n8n_applied_env_hash";

type HttpError = Error & { statusCode?: number };

function httpError(message: string, statusCode: number): HttpError {
  const e = new Error(message) as HttpError;
  e.statusCode = statusCode;
  return e;
}

export type N8nPowerAction = "start" | "stop" | "restart";

export type N8nConfig = {
  /** Docker tag: "latest", "next", "beta" or a pinned version like "1.80.3". */
  imageTag: string;
  timezone: string;
  pruneEnabled: boolean;
  /** Hours of execution history to keep. */
  pruneMaxAgeHours: number;
  runnersEnabled: boolean;
  /** Feed the shared SMTP credentials to n8n for user invites / password reset. */
  useSharedSmtp: boolean;
  /** Operator-supplied extra env (KEY → value). */
  extraEnv: Record<string, string>;
};

const DEFAULT_CONFIG: N8nConfig = {
  imageTag: "latest",
  timezone: "",
  pruneEnabled: true,
  pruneMaxAgeHours: 336,
  runnersEnabled: true,
  useSharedSmtp: false,
  extraEnv: {}
};

/** Env keys LocalSURV manages — operators can't override them via extraEnv. */
const MANAGED_ENV = new Set([
  "N8N_ENCRYPTION_KEY",
  "N8N_PORT",
  "N8N_LISTEN_ADDRESS",
  "N8N_HOST",
  "N8N_PROTOCOL",
  "WEBHOOK_URL",
  "N8N_EDITOR_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL"
]);

export type N8nStatus = {
  installed: boolean;
  running: boolean;
  state: string;
  reachable: boolean;
  ready: boolean;
  version: string | null;
  image: string;
  startedAt: string | null;
  port: number;
  dataDir: string;
  publicUrl: string | null;
  openUrl: string | null;
  webhookUrl: string | null;
  autostart: boolean;
  encryptionKeySet: boolean;
  api: {
    keySet: boolean;
    ok: boolean;
    error: string | null;
    settingsUrl: string | null;
  };
  /** Back-compat alias for api.keySet. */
  apiKeySet: boolean;
  config: N8nConfig;
  /** Settings saved since the container was created — restart to apply. */
  pendingRestart: boolean;
  aiGateway: {
    wired: boolean;
    baseUrl: string | null;
    tokenPreview: string | null;
    gatewayEnabled: boolean;
  };
  updatedAt: string;
};

export type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  tags: string[];
  nodeCount: number;
  triggers: string[];
  webhooks: Array<{ method: string; path: string; productionUrl: string }>;
  editorUrl: string | null;
};

export type N8nExecution = {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  status: string;
  mode: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  retryOf: string | null;
};

export type N8nEventStarter = {
  event: string;
  label: string;
  description: string;
  group: string;
  installed: boolean;
  webhookUrl: string | null;
};

/** LocalSURV events that can fan out into n8n webhook workflows. */
export const N8N_EVENT_STARTERS: Array<{ event: string; label: string; description: string; group: string }> = [
  {
    event: "deployment.succeeded",
    label: "Deployment succeeded",
    description: "Fires when a service deploy finishes successfully.",
    group: "Deployments"
  },
  {
    event: "deployment.failed",
    label: "Deployment failed",
    description: "Fires when a service deploy fails.",
    group: "Deployments"
  },
  {
    event: "service.crashed",
    label: "Service crashed",
    description: "Fires when a watched service exits unexpectedly.",
    group: "Services"
  },
  {
    event: "email.received",
    label: "Email received",
    description: "Fires when the Emailer receives an inbound message (includes thread + body).",
    group: "Emailer"
  },
  {
    event: "email.sent",
    label: "Email sent",
    description: "Fires when the Emailer successfully sends a message.",
    group: "Emailer"
  },
  {
    event: "license.issued",
    label: "License issued",
    description: "Fires when a new license key is generated.",
    group: "License"
  },
  {
    event: "license.revoked",
    label: "License revoked",
    description: "Fires when a license key is revoked.",
    group: "License"
  },
  {
    event: "license.extended",
    label: "License extended",
    description: "Fires when a license expiry is extended.",
    group: "License"
  },
  {
    event: "license.validated",
    label: "License validated",
    description: "Fires on each successful public license validation.",
    group: "License"
  },
  {
    event: "license.activation",
    label: "License activation",
    description: "Fires when a new device fingerprint activates a key.",
    group: "License"
  }
];

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function dataDirOf(ctx: AppContext): string {
  return path.join(ctx.config.serviceDataDir, "n8n_data");
}

function autostartEnabled(ctx: AppContext): boolean {
  return getSetting(ctx, SETTING_AUTOSTART) === "1";
}

function publicUrlOf(ctx: AppContext): string | null {
  const raw = (getSetting(ctx, SETTING_PUBLIC_URL) ?? "").trim().replace(/\/+$/, "");
  return raw || null;
}

function openUrlOf(ctx: AppContext, running: boolean): string | null {
  if (!running) return null;
  return publicUrlOf(ctx) ?? LOCAL_BASE;
}

function webhookUrlOf(ctx: AppContext): string {
  const publicUrl = publicUrlOf(ctx);
  return `${(publicUrl ?? LOCAL_BASE).replace(/\/+$/, "")}/`;
}

export function getN8nConfig(ctx: AppContext): N8nConfig {
  const raw = getSetting(ctx, SETTING_CONFIG);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<N8nConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      extraEnv: parsed.extraEnv && typeof parsed.extraEnv === "object" ? parsed.extraEnv : {}
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function imageOf(config: N8nConfig): string {
  return `${N8N_IMAGE_REPO}:${config.imageTag || "latest"}`;
}

function readWebhookMap(ctx: AppContext): Record<string, string> {
  const raw = getSetting(ctx, SETTING_WEBHOOKS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeWebhookMap(ctx: AppContext, map: Record<string, string>): void {
  setSetting(ctx, SETTING_WEBHOOKS, JSON.stringify(map));
}

function ensureEncryptionKey(ctx: AppContext): string {
  const existing = getSecretSetting(ctx, SETTING_ENCRYPTION);
  if (existing) return existing;
  const key = crypto.randomBytes(32).toString("base64url");
  setSecretSetting(ctx, SETTING_ENCRYPTION, key);
  return key;
}

/** Resolve the OpenAI-compatible base URL n8n should call for AI Gateway. */
function resolveAiBaseUrl(ctx: AppContext): string | null {
  if (isExternalMode(ctx)) {
    const target = getExternalTarget(ctx);
    if (!target?.url) return null;
    return `${target.url.replace(/\/+$/, "")}/v1`;
  }
  const config = getGatewayConfig(ctx);
  if (config.publicUrl) {
    return `${config.publicUrl.replace(/\/+$/, "")}/v1`;
  }
  if (config.enabled || inferenceServerRunning()) {
    const port = inferenceServerPort() ?? config.port;
    // Container → host loopback via host-gateway alias.
    return `http://host.docker.internal:${port}/v1`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Container env
// ---------------------------------------------------------------------------

/**
 * Container env for the current settings. Pure apart from reading settings,
 * exported so the env contract can be tested without Docker.
 */
export function buildN8nEnv(ctx: AppContext): string[] {
  const encryptionKey = ensureEncryptionKey(ctx);
  const config = getN8nConfig(ctx);
  const publicUrl = publicUrlOf(ctx);
  const env: string[] = [
    `N8N_ENCRYPTION_KEY=${encryptionKey}`,
    `N8N_PORT=${N8N_PORT}`,
    `N8N_LISTEN_ADDRESS=0.0.0.0`,
    // Disable personal-data telemetry for self-hosted operators.
    `N8N_DIAGNOSTICS_ENABLED=false`,
    `N8N_PERSONALIZATION_ENABLED=false`,
    `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true`
  ];

  let secure = false;
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      const slashed = `${publicUrl}/`;
      env.push(`N8N_HOST=${u.hostname}`);
      env.push(`N8N_PROTOCOL=${u.protocol.replace(":", "")}`);
      env.push(`WEBHOOK_URL=${slashed}`);
      env.push(`N8N_EDITOR_BASE_URL=${slashed}`);
      // Behind Edge Ingress / a tunnel there is exactly one proxy hop; n8n
      // needs this to read the real client IP for rate limiting.
      env.push(`N8N_PROXY_HOPS=1`);
      secure = u.protocol === "https:";
    } catch {
      env.push(`WEBHOOK_URL=${webhookUrlOf(ctx)}`);
    }
  } else {
    env.push(`WEBHOOK_URL=${webhookUrlOf(ctx)}`);
  }
  // Without https n8n's secure session cookie is never sent back, so login
  // over plain http (LAN IP, 127.0.0.1 via SSH tunnel) silently fails.
  if (!secure) env.push(`N8N_SECURE_COOKIE=false`);

  if (config.timezone) {
    env.push(`GENERIC_TIMEZONE=${config.timezone}`);
    env.push(`TZ=${config.timezone}`);
  }
  env.push(`EXECUTIONS_DATA_PRUNE=${config.pruneEnabled ? "true" : "false"}`);
  if (config.pruneEnabled) env.push(`EXECUTIONS_DATA_MAX_AGE=${Math.max(1, Math.round(config.pruneMaxAgeHours))}`);
  if (config.runnersEnabled) env.push(`N8N_RUNNERS_ENABLED=true`);

  if (config.useSharedSmtp) {
    const host = getSetting(ctx, "smtp_host");
    const pass = getSecretSetting(ctx, "smtp_password");
    if (host && pass) {
      const port = getSetting(ctx, "smtp_port") ?? "465";
      const from = getSetting(ctx, "smtp_from") ?? "";
      const fromName = getSetting(ctx, "smtp_from_name") ?? "";
      env.push(`N8N_EMAIL_MODE=smtp`);
      env.push(`N8N_SMTP_HOST=${host}`);
      env.push(`N8N_SMTP_PORT=${port}`);
      env.push(`N8N_SMTP_USER=${getSetting(ctx, "smtp_user") ?? "api_token"}`);
      env.push(`N8N_SMTP_PASS=${pass}`);
      env.push(`N8N_SMTP_SENDER=${fromName ? `${fromName} <${from}>` : from}`);
      env.push(`N8N_SMTP_SSL=${port === "465" ? "true" : "false"}`);
    }
  }

  const aiToken = getSecretSetting(ctx, SETTING_AI_TOKEN);
  const aiBase = resolveAiBaseUrl(ctx);
  if (aiToken && aiBase) {
    env.push(`OPENAI_API_KEY=${aiToken}`);
    env.push(`OPENAI_BASE_URL=${aiBase}`);
  }

  for (const [key, value] of Object.entries(config.extraEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || MANAGED_ENV.has(key)) continue;
    // Operator values win over our defaults for everything not managed.
    const idx = env.findIndex((line) => line.startsWith(`${key}=`));
    if (idx !== -1) env.splice(idx, 1);
    env.push(`${key}=${value}`);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

async function containerInspect(ctx: AppContext): Promise<ContainerInspectInfo | null> {
  try {
    return (await ctx.docker.getContainer(N8N_CONTAINER).inspect()) as ContainerInspectInfo;
  } catch {
    return null;
  }
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

function envOf(info: ContainerInspectInfo | null, key: string): string | null {
  const line = info?.Config?.Env?.find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

function envHash(env: string[]): string {
  return crypto.createHash("sha256").update([...env].sort().join("\n")).digest("hex");
}

/**
 * Would a recreate change the container's env? Compared by the hash recorded
 * at create time — the image adds its own env (PATH, N8N_VERSION, …), so the
 * inspected env can't be compared directly. Containers created before the hash
 * existed fall back to "is anything we want missing".
 */
function envDrift(ctx: AppContext, info: ContainerInspectInfo | null): boolean {
  if (!info?.Config?.Env) return false;
  const wanted = buildN8nEnv(ctx);
  const applied = getSetting(ctx, SETTING_APPLIED_ENV);
  if (applied) return applied !== envHash(wanted);
  const have = new Set(info.Config.Env);
  return wanted.some((line) => !have.has(line));
}

async function checkApi(ctx: AppContext, running: boolean): Promise<{ ok: boolean; error: string | null }> {
  if (!getSecretSetting(ctx, SETTING_API_KEY)) return { ok: false, error: "No API key" };
  if (!running) return { ok: false, error: "n8n is stopped" };
  const res = await n8nApiFetch(ctx, "/api/v1/workflows?limit=1");
  if (!res) return { ok: false, error: "n8n API unreachable" };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "API key rejected by n8n" };
  if (!res.ok) return { ok: false, error: `n8n API returned ${res.status}` };
  return { ok: true, error: null };
}

export async function getN8nStatus(ctx: AppContext): Promise<N8nStatus> {
  const info = await containerInspect(ctx);
  const running = Boolean(info?.State?.Running);
  const state = info?.State?.Status ?? (info ? "created" : "absent");
  const config = getN8nConfig(ctx);
  const version =
    envOf(info, "N8N_VERSION") ??
    (info?.Config?.Labels?.["org.opencontainers.image.version"] as string | undefined) ??
    null;
  const openUrl = openUrlOf(ctx, running);
  const [reachable, ready] = running
    ? await Promise.all([probe(`${LOCAL_BASE}/healthz`), probe(`${LOCAL_BASE}/healthz/readiness`)])
    : [false, false];
  const api = reachable ? await checkApi(ctx, running) : { ok: false, error: running ? "n8n is starting" : "n8n is stopped" };
  const aiToken = getSecretSetting(ctx, SETTING_AI_TOKEN);
  const aiBase = resolveAiBaseUrl(ctx);
  const gw = getGatewayConfig(ctx);
  const keySet = Boolean(getSecretSetting(ctx, SETTING_API_KEY));
  const configuredImage = imageOf(config);

  return {
    installed: info !== null,
    running,
    state,
    reachable,
    ready: ready || reachable,
    version,
    image: info?.Config?.Image ?? configuredImage,
    startedAt: running ? info?.State?.StartedAt ?? null : null,
    port: N8N_PORT,
    dataDir: dataDirOf(ctx),
    publicUrl: publicUrlOf(ctx),
    openUrl,
    webhookUrl: webhookUrlOf(ctx),
    autostart: autostartEnabled(ctx),
    encryptionKeySet: Boolean(getSecretSetting(ctx, SETTING_ENCRYPTION)),
    api: {
      keySet,
      ok: api.ok,
      error: keySet ? api.error : null,
      settingsUrl: openUrl ? `${openUrl.replace(/\/+$/, "")}/settings/api` : null
    },
    apiKeySet: keySet,
    config,
    pendingRestart:
      info !== null && ((info.Config?.Image ?? configuredImage) !== configuredImage || envDrift(ctx, info)),
    aiGateway: {
      wired: Boolean(aiToken),
      baseUrl: aiToken ? aiBase : null,
      tokenPreview: aiToken ? `${aiToken.slice(0, 10)}…` : null,
      gatewayEnabled: isExternalMode(ctx) || gw.enabled || inferenceServerRunning()
    },
    updatedAt: nowIso()
  };
}

export type N8nMetrics = {
  available: boolean;
  cpuPercent: number | null;
  memoryMb: number | null;
  memoryLimitMb: number | null;
};

export async function getN8nMetrics(ctx: AppContext): Promise<N8nMetrics> {
  const empty = { available: false, cpuPercent: null, memoryMb: null, memoryLimitMb: null };
  const info = await containerInspect(ctx);
  if (!info?.State?.Running) return empty;
  try {
    const s = (await ctx.docker.getContainer(N8N_CONTAINER).stats({ stream: false })) as any;
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats?.online_cpus ?? s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
    const used = Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
    return {
      available: true,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMb: Math.round(used / 1024 / 1024),
      memoryLimitMb: s.memory_stats?.limit ? Math.round(s.memory_stats.limit / 1024 / 1024) : null
    };
  } catch {
    return empty;
  }
}

async function pullImage(ctx: AppContext, image: string, force = false): Promise<void> {
  if (!force) {
    try {
      await ctx.docker.getImage(image).inspect();
      return;
    } catch {
      /* not present — pull */
    }
  }
  await new Promise<void>((resolve, reject) => {
    ctx.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      ctx.docker.modem.followProgress(stream, (followErr: Error | null) =>
        followErr ? reject(followErr) : resolve()
      );
    });
  });
}

async function removeContainerIfExists(ctx: AppContext): Promise<void> {
  const info = await containerInspect(ctx);
  if (!info) return;
  const container = ctx.docker.getContainer(N8N_CONTAINER);
  try {
    if (info.State.Running) await container.stop({ t: 15 });
  } catch {
    /* already stopped */
  }
  try {
    await container.remove({ force: true });
  } catch {
    /* gone */
  }
}

async function createAndStartN8n(ctx: AppContext): Promise<void> {
  const image = imageOf(getN8nConfig(ctx));
  await pullImage(ctx, image);
  const dataDir = dataDirOf(ctx);
  await mkdir(dataDir, { recursive: true, mode: 0o777 });

  const restart = autostartEnabled(ctx)
    ? { Name: "unless-stopped" as const }
    : { Name: "no" as const };

  const env = buildN8nEnv(ctx);
  const container = await ctx.docker.createContainer({
    Image: image,
    name: N8N_CONTAINER,
    Env: env,
    Labels: { "localsurv.addon": "n8n" },
    HostConfig: {
      Binds: [`${dataDir}:/home/node/.n8n`],
      PortBindings: {
        "5678/tcp": [{ HostPort: String(N8N_PORT) }]
      },
      ExtraHosts: ["host.docker.internal:host-gateway"],
      RestartPolicy: restart
    },
    ExposedPorts: {
      "5678/tcp": {}
    }
  });

  setSetting(ctx, SETTING_APPLIED_ENV, envHash(env));
  await container.start();
}

/** Recreate the container so env / image / restart policy changes take effect. */
async function recreateN8n(ctx: AppContext, startAfter = true): Promise<void> {
  const wasRunning = (await containerInspect(ctx))?.State?.Running ?? false;
  await removeContainerIfExists(ctx);
  if (startAfter || wasRunning) {
    await createAndStartN8n(ctx);
  }
}

async function waitForReady(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(`${LOCAL_BASE}/healthz`)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function setN8nPower(ctx: AppContext, action: N8nPowerAction): Promise<N8nStatus> {
  try {
    const info = await containerInspect(ctx);

    if (action === "stop") {
      if (info?.State.Running) {
        await ctx.docker.getContainer(N8N_CONTAINER).stop({ t: 15 });
      }
    } else if (action === "restart") {
      // Always recreate on restart: it's the only way saved settings apply,
      // and the data directory is a bind mount so nothing is lost.
      await recreateN8n(ctx, true);
    } else if (action === "start") {
      if (!info) {
        await createAndStartN8n(ctx);
      } else if (!info.State.Running) {
        await recreateN8n(ctx, true);
      }
    }
  } catch (err) {
    throw new Error(`Failed to ${action} n8n: ${(err as Error).message}`);
  }
  if (action !== "stop") await waitForReady(15000);
  return getN8nStatus(ctx);
}

/** Pull the configured image tag again and recreate if anything changed. */
export async function updateN8nImage(ctx: AppContext, actor = "system"): Promise<N8nStatus & { updated: boolean }> {
  const image = imageOf(getN8nConfig(ctx));
  const before = await ctx.docker
    .getImage(image)
    .inspect()
    .then((i: { Id?: string }) => i.Id ?? null)
    .catch(() => null);
  try {
    await pullImage(ctx, image, true);
  } catch (err) {
    throw httpError(`Could not pull ${image}: ${(err as Error).message}`, 502);
  }
  const after = await ctx.docker
    .getImage(image)
    .inspect()
    .then((i: { Id?: string }) => i.Id ?? null)
    .catch(() => null);
  const info = await containerInspect(ctx);
  const updated = before !== after || (info?.Config?.Image ?? image) !== image;
  if (info && updated) {
    await recreateN8n(ctx, Boolean(info.State.Running));
    if (info.State.Running) await waitForReady(30000);
  }
  writeAuditLog(ctx, {
    actor,
    action: "n8n.image.update",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200,
    details: `${image}${updated ? " (updated)" : " (already current)"}`
  });
  return { ...(await getN8nStatus(ctx)), updated };
}

export async function setN8nAutostart(ctx: AppContext, enabled: boolean): Promise<N8nStatus> {
  setSetting(ctx, SETTING_AUTOSTART, enabled ? "1" : "0");
  const info = await containerInspect(ctx);
  if (info) {
    // Restart policy is set at create-time; recreate to apply.
    await recreateN8n(ctx, Boolean(info.State.Running));
  }
  writeAuditLog(ctx, {
    actor: "system",
    action: enabled ? "n8n.autostart.enable" : "n8n.autostart.disable",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200
  });
  return getN8nStatus(ctx);
}

export async function setN8nPublicUrl(ctx: AppContext, url: string): Promise<N8nStatus> {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    } catch {
      throw httpError("Public URL must be an absolute http(s) URL", 400);
    }
    setSetting(ctx, SETTING_PUBLIC_URL, trimmed);
  } else {
    setSetting(ctx, SETTING_PUBLIC_URL, "");
  }
  const info = await containerInspect(ctx);
  if (info?.State.Running) {
    await recreateN8n(ctx, true);
  }
  writeAuditLog(ctx, {
    actor: "system",
    action: "n8n.public-url.update",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200,
    details: trimmed || "(cleared)"
  });
  return getN8nStatus(ctx);
}

export function validateN8nConfig(patch: Partial<N8nConfig>): Partial<N8nConfig> {
  const out: Partial<N8nConfig> = {};
  if (patch.imageTag !== undefined) {
    const tag = patch.imageTag.trim() || "latest";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tag)) throw httpError("Image tag may only contain letters, digits, . _ -", 400);
    out.imageTag = tag;
  }
  if (patch.timezone !== undefined) {
    const tz = patch.timezone.trim();
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw httpError(`Unknown timezone "${tz}" — use an IANA name like Europe/Copenhagen`, 400);
      }
    }
    out.timezone = tz;
  }
  if (patch.pruneEnabled !== undefined) out.pruneEnabled = Boolean(patch.pruneEnabled);
  if (patch.pruneMaxAgeHours !== undefined) {
    const h = Number(patch.pruneMaxAgeHours);
    if (!Number.isFinite(h) || h < 1 || h > 24 * 365) throw httpError("Prune age must be 1–8760 hours", 400);
    out.pruneMaxAgeHours = Math.round(h);
  }
  if (patch.runnersEnabled !== undefined) out.runnersEnabled = Boolean(patch.runnersEnabled);
  if (patch.useSharedSmtp !== undefined) out.useSharedSmtp = Boolean(patch.useSharedSmtp);
  if (patch.extraEnv !== undefined) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch.extraEnv ?? {})) {
      const key = k.trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw httpError(`Invalid env key "${key}"`, 400);
      if (MANAGED_ENV.has(key)) throw httpError(`${key} is managed by LocalSURV and can't be overridden`, 400);
      env[key] = String(v ?? "");
    }
    out.extraEnv = env;
  }
  return out;
}

/**
 * Save configuration. With `apply`, a running container is recreated right
 * away; otherwise the status reports `pendingRestart` until the next restart.
 */
export async function setN8nConfig(
  ctx: AppContext,
  patch: Partial<N8nConfig>,
  opts: { apply?: boolean; actor?: string } = {}
): Promise<N8nStatus> {
  const next = { ...getN8nConfig(ctx), ...validateN8nConfig(patch) };
  setSetting(ctx, SETTING_CONFIG, JSON.stringify(next));
  writeAuditLog(ctx, {
    actor: opts.actor ?? "system",
    action: "n8n.config.update",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200,
    details: Object.keys(patch).join(",")
  });
  if (opts.apply) {
    const info = await containerInspect(ctx);
    if (info?.State.Running) {
      await recreateN8n(ctx, true);
      await waitForReady(20000);
    }
  }
  return getN8nStatus(ctx);
}

/** Ensure the encryption key exists and is injected into a running container. */
export async function bootstrapN8nSecrets(ctx: AppContext): Promise<N8nStatus> {
  ensureEncryptionKey(ctx);
  const info = await containerInspect(ctx);
  if (info?.State.Running && !envOf(info, "N8N_ENCRYPTION_KEY")) {
    await recreateN8n(ctx, true);
  }
  writeAuditLog(ctx, {
    actor: "system",
    action: "n8n.secrets.bootstrap",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200
  });
  return getN8nStatus(ctx);
}

/**
 * Store the Public API key the owner created in n8n (Settings → n8n API).
 * Verified against the live API first so a typo can't silently break the
 * workflow / execution views. Empty string clears it.
 */
export async function setN8nApiKey(ctx: AppContext, key: string, actor = "system"): Promise<N8nStatus> {
  const trimmed = key.trim();
  if (!trimmed) {
    deleteSetting(ctx, SETTING_API_KEY);
    return getN8nStatus(ctx);
  }
  const info = await containerInspect(ctx);
  if (info?.State.Running) {
    try {
      const res = await fetch(`${LOCAL_BASE}/api/v1/workflows?limit=1`, {
        headers: { "X-N8N-API-KEY": trimmed, Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.status === 401 || res.status === 403) {
        throw httpError("n8n rejected that API key — create one under Settings → n8n API", 400);
      }
    } catch (err) {
      if ((err as HttpError).statusCode) throw err;
      // n8n unreachable: store anyway, status will report the problem.
    }
  }
  setSecretSetting(ctx, SETTING_API_KEY, trimmed);
  writeAuditLog(ctx, {
    actor,
    action: "n8n.api-key.set",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200
  });
  return getN8nStatus(ctx);
}

/**
 * One-click AI Gateway wiring: enable gateway if needed, mint a dedicated
 * consumer token, inject OPENAI_* into the n8n container, recreate.
 */
export async function wireN8nAiGateway(ctx: AppContext, actor = "system"): Promise<N8nStatus> {
  if (!isExternalMode(ctx)) {
    const config = getGatewayConfig(ctx);
    if (!config.enabled || !inferenceServerRunning()) {
      setGatewayConfig(ctx, { enabled: true }, actor);
      try {
        await startInferenceServer(ctx);
      } catch (err) {
        throw httpError(`Could not start AI Gateway: ${(err as Error).message}`, 503);
      }
    }
  }

  const baseUrl = resolveAiBaseUrl(ctx);
  if (!baseUrl) {
    throw httpError("AI Gateway has no reachable base URL. Enable the gateway or set its Public URL.", 400);
  }

  // Revoke a previous n8n token if we still know its id.
  const prevId = getSetting(ctx, SETTING_AI_TOKEN_ID);
  if (prevId) {
    try {
      revokeConsumerToken(ctx, prevId, actor);
    } catch {
      /* already gone */
    }
  } else {
    // Best-effort: revoke any active token named for n8n.
    for (const t of listConsumerTokens(ctx)) {
      if (t.active && t.name.toLowerCase() === "n8n") {
        try {
          revokeConsumerToken(ctx, t.id, actor);
        } catch {
          /* ignore */
        }
      }
    }
  }

  let token: string;
  let recordId: string;
  if (isExternalMode(ctx)) {
    const minted = (await externalMintToken(ctx, "n8n")) as {
      token?: string;
      record?: { id?: string };
    };
    if (!minted.token) throw httpError("External AI Gateway did not return a consumer token", 502);
    token = minted.token;
    recordId = minted.record?.id ?? `ext-${nanoid()}`;
  } else {
    const minted = mintConsumerToken(ctx, "n8n", actor);
    token = minted.token;
    recordId = minted.record.id;
  }

  setSecretSetting(ctx, SETTING_AI_TOKEN, token);
  setSetting(ctx, SETTING_AI_TOKEN_ID, recordId);

  const info = await containerInspect(ctx);
  if (info) {
    await recreateN8n(ctx, true);
  }

  writeAuditLog(ctx, {
    actor,
    action: "n8n.ai-gateway.wire",
    resourceType: "n8n",
    resourceId: N8N_CONTAINER,
    statusCode: 200,
    details: `tokenId=${recordId}`
  });
  return getN8nStatus(ctx);
}

/** Strip Docker multiplex framing (8-byte headers) from `docker logs` output. */
function stripDockerLogs(raw: Buffer | string): string {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  // Heuristic: framed streams start with stream-type byte 0x01/0x02 and a size.
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (end > buf.length) break;
      chunks.push(buf.subarray(start, end));
      offset = end;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return buf.toString("utf8");
}

export async function readN8nLog(ctx: AppContext, lines: number): Promise<string> {
  try {
    const container = ctx.docker.getContainer(N8N_CONTAINER);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: Math.min(Math.max(lines, 1), 2000),
      timestamps: true
    });
    return stripDockerLogs(logs as Buffer);
  } catch (err) {
    return `Failed to read logs: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// n8n Public API
// ---------------------------------------------------------------------------

async function n8nApiFetch(ctx: AppContext, apiPath: string, init?: RequestInit): Promise<Response | null> {
  const apiKey = getSecretSetting(ctx, SETTING_API_KEY);
  if (!apiKey) return null;
  try {
    // Always the loopback port: the public URL may sit behind an access
    // gateway that would reject a machine call.
    return await fetch(`${LOCAL_BASE}${apiPath}`, {
      ...init,
      headers: {
        ...((init?.headers as Record<string, string>) ?? {}),
        "X-N8N-API-KEY": apiKey,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {})
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    return null;
  }
}

async function apiJson<T>(ctx: AppContext, apiPath: string, init?: RequestInit): Promise<T> {
  if (!getSecretSetting(ctx, SETTING_API_KEY)) {
    throw httpError("Add an n8n API key first (n8n → Settings → n8n API)", 400);
  }
  const res = await n8nApiFetch(ctx, apiPath, init);
  if (!res) throw httpError("n8n API unreachable — is n8n running?", 503);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : null) ??
      `n8n API returned ${res.status}`;
    throw httpError(
      res.status === 401 ? "n8n rejected the API key — paste a fresh one" : `n8n: ${msg}`,
      res.status === 404 ? 404 : res.status >= 500 ? 502 : 400
    );
  }
  return body as T;
}

type RawWorkflow = {
  id: string | number;
  name: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ id?: string; name: string }>;
  nodes?: Array<{ type?: string; name?: string; parameters?: Record<string, unknown>; disabled?: boolean }>;
  connections?: unknown;
  settings?: Record<string, unknown>;
  staticData?: unknown;
};

const TRIGGER_LABELS: Record<string, string> = {
  "n8n-nodes-base.webhook": "Webhook",
  "n8n-nodes-base.scheduleTrigger": "Schedule",
  "n8n-nodes-base.cron": "Cron",
  "n8n-nodes-base.manualTrigger": "Manual",
  "n8n-nodes-base.emailReadImap": "IMAP",
  "n8n-nodes-base.formTrigger": "Form",
  "n8n-nodes-base.errorTrigger": "Error",
  "n8n-nodes-base.executeWorkflowTrigger": "Sub-workflow",
  "@n8n/n8n-nodes-langchain.chatTrigger": "Chat"
};

function summarizeWorkflow(ctx: AppContext, w: RawWorkflow, editorBase: string | null): N8nWorkflow {
  const nodes = w.nodes ?? [];
  const triggers = new Set<string>();
  const webhooks: N8nWorkflow["webhooks"] = [];
  const base = webhookUrlOf(ctx);
  for (const node of nodes) {
    const type = node.type ?? "";
    if (node.disabled) continue;
    if (TRIGGER_LABELS[type]) triggers.add(TRIGGER_LABELS[type]);
    else if (/trigger$/i.test(type)) triggers.add(type.split(".").pop()!.replace(/Trigger$/i, "") || "Trigger");
    if (type === "n8n-nodes-base.webhook") {
      const p = String(node.parameters?.path ?? "").replace(/^\/+/, "");
      if (p) {
        webhooks.push({
          method: String(node.parameters?.httpMethod ?? "GET"),
          path: p,
          productionUrl: `${base}webhook/${p}`
        });
      }
    }
  }
  return {
    id: String(w.id),
    name: w.name,
    active: Boolean(w.active),
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    tags: (w.tags ?? []).map((t) => t.name),
    nodeCount: nodes.length,
    triggers: [...triggers],
    webhooks,
    editorUrl: editorBase ? `${editorBase.replace(/\/+$/, "")}/workflow/${w.id}` : null
  };
}

async function fetchAllWorkflows(ctx: AppContext): Promise<RawWorkflow[]> {
  const out: RawWorkflow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const qs = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body: { data?: RawWorkflow[]; nextCursor?: string | null } = await apiJson(ctx, `/api/v1/workflows?${qs}`);
    out.push(...(body.data ?? []));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

export async function listN8nWorkflows(ctx: AppContext): Promise<{
  available: boolean;
  items: N8nWorkflow[];
  error?: string;
}> {
  const info = await containerInspect(ctx);
  if (!info?.State?.Running) return { available: false, items: [], error: "n8n is stopped" };
  if (!getSecretSetting(ctx, SETTING_API_KEY)) {
    return { available: false, items: [], error: "Add an n8n API key to manage workflows from here" };
  }
  try {
    const raw = await fetchAllWorkflows(ctx);
    const editorBase = openUrlOf(ctx, true);
    const items = raw
      .map((w) => summarizeWorkflow(ctx, w, editorBase))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { available: true, items };
  } catch (err) {
    return { available: false, items: [], error: (err as Error).message };
  }
}

export async function setN8nWorkflowActive(
  ctx: AppContext,
  id: string,
  active: boolean,
  actor = "system"
): Promise<N8nWorkflow> {
  const w = await apiJson<RawWorkflow>(
    ctx,
    `/api/v1/workflows/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`,
    { method: "POST" }
  );
  writeAuditLog(ctx, {
    actor,
    action: active ? "n8n.workflow.activate" : "n8n.workflow.deactivate",
    resourceType: "n8n",
    resourceId: id,
    statusCode: 200,
    details: w.name
  });
  return summarizeWorkflow(ctx, w, openUrlOf(ctx, true));
}

export async function deleteN8nWorkflow(ctx: AppContext, id: string, actor = "system"): Promise<void> {
  const w = await apiJson<RawWorkflow>(ctx, `/api/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  writeAuditLog(ctx, {
    actor,
    action: "n8n.workflow.delete",
    resourceType: "n8n",
    resourceId: id,
    statusCode: 200,
    details: w?.name
  });
}

export async function getN8nWorkflowJson(ctx: AppContext, id: string): Promise<RawWorkflow> {
  return apiJson<RawWorkflow>(ctx, `/api/v1/workflows/${encodeURIComponent(id)}`);
}

/** Every workflow, full definitions — a portable backup bundle. */
export async function exportN8nWorkflows(ctx: AppContext): Promise<{ exportedAt: string; workflows: RawWorkflow[] }> {
  return { exportedAt: nowIso(), workflows: await fetchAllWorkflows(ctx) };
}

/** Settings keys the Public API accepts on create (it rejects unknown ones). */
const WORKFLOW_SETTING_KEYS = [
  "saveExecutionProgress",
  "saveManualExecutions",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "executionTimeout",
  "errorWorkflow",
  "timezone",
  "executionOrder"
];

/** Reduce an editor export to the shape POST /api/v1/workflows accepts. */
export function sanitizeWorkflowForImport(input: unknown): {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  staticData?: unknown;
} {
  if (!input || typeof input !== "object") throw httpError("Workflow JSON must be an object", 400);
  const w = input as RawWorkflow;
  if (!Array.isArray(w.nodes) || w.nodes.length === 0) throw httpError("Workflow JSON has no nodes", 400);
  const settings: Record<string, unknown> = {};
  for (const key of WORKFLOW_SETTING_KEYS) {
    if (w.settings && key in w.settings) settings[key] = w.settings[key];
  }
  if (!settings.executionOrder) settings.executionOrder = "v1";
  const out: ReturnType<typeof sanitizeWorkflowForImport> = {
    name: (typeof w.name === "string" && w.name.trim()) || "Imported workflow",
    nodes: w.nodes,
    connections: (w.connections as Record<string, unknown>) ?? {},
    settings
  };
  if (w.staticData) out.staticData = w.staticData;
  return out;
}

export async function importN8nWorkflow(
  ctx: AppContext,
  input: unknown,
  opts: { activate?: boolean; actor?: string } = {}
): Promise<N8nWorkflow> {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { workflows?: unknown[] }).workflows)
      ? (input as { workflows: unknown[] }).workflows
      : [input];
  if (items.length !== 1) throw httpError("Import one workflow at a time", 400);
  const body = sanitizeWorkflowForImport(items[0]);
  let created = await apiJson<RawWorkflow>(ctx, "/api/v1/workflows", {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (opts.activate) {
    created = await apiJson<RawWorkflow>(ctx, `/api/v1/workflows/${encodeURIComponent(String(created.id))}/activate`, {
      method: "POST"
    });
  }
  writeAuditLog(ctx, {
    actor: opts.actor ?? "system",
    action: "n8n.workflow.import",
    resourceType: "n8n",
    resourceId: String(created.id),
    statusCode: 200,
    details: created.name
  });
  return summarizeWorkflow(ctx, created, openUrlOf(ctx, true));
}

type RawExecution = {
  id: string | number;
  workflowId?: string | number;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  retryOf?: string | number | null;
  waitTill?: string | null;
};

export async function listN8nExecutions(
  ctx: AppContext,
  opts: { workflowId?: string; status?: string; limit?: number; cursor?: string } = {}
): Promise<{ available: boolean; items: N8nExecution[]; nextCursor: string | null; error?: string }> {
  const info = await containerInspect(ctx);
  if (!info?.State?.Running) return { available: false, items: [], nextCursor: null, error: "n8n is stopped" };
  if (!getSecretSetting(ctx, SETTING_API_KEY)) {
    return { available: false, items: [], nextCursor: null, error: "Add an n8n API key to see executions" };
  }
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 50, 1), 250)));
  if (opts.workflowId) params.set("workflowId", opts.workflowId);
  if (opts.status) params.set("status", opts.status);
  if (opts.cursor) params.set("cursor", opts.cursor);
  try {
    const [execs, workflows] = await Promise.all([
      apiJson<{ data?: RawExecution[]; nextCursor?: string | null }>(ctx, `/api/v1/executions?${params}`),
      fetchAllWorkflows(ctx).catch(() => [] as RawWorkflow[])
    ]);
    const names = new Map(workflows.map((w) => [String(w.id), w.name]));
    const items = (execs.data ?? []).map((e) => {
      const started = e.startedAt ? Date.parse(e.startedAt) : NaN;
      const stopped = e.stoppedAt ? Date.parse(e.stoppedAt) : NaN;
      const status =
        e.status ?? (e.finished ? "success" : e.waitTill ? "waiting" : e.stoppedAt ? "error" : "running");
      return {
        id: String(e.id),
        workflowId: e.workflowId != null ? String(e.workflowId) : null,
        workflowName: e.workflowId != null ? names.get(String(e.workflowId)) ?? null : null,
        status,
        mode: e.mode ?? null,
        startedAt: e.startedAt ?? null,
        stoppedAt: e.stoppedAt ?? null,
        durationMs: Number.isFinite(started) && Number.isFinite(stopped) ? stopped - started : null,
        retryOf: e.retryOf != null ? String(e.retryOf) : null
      };
    });
    return { available: true, items, nextCursor: execs.nextCursor ?? null };
  } catch (err) {
    return { available: false, items: [], nextCursor: null, error: (err as Error).message };
  }
}

export async function retryN8nExecution(ctx: AppContext, id: string, actor = "system"): Promise<{ id: string | null }> {
  const res = await apiJson<RawExecution | null>(ctx, `/api/v1/executions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: JSON.stringify({ loadWorkflow: true })
  }).catch((err: HttpError) => {
    if (err.statusCode === 404) {
      throw httpError("This n8n version can't retry executions over the API — update n8n or retry in the editor", 400);
    }
    throw err;
  });
  writeAuditLog(ctx, {
    actor,
    action: "n8n.execution.retry",
    resourceType: "n8n",
    resourceId: id,
    statusCode: 200
  });
  return { id: res?.id != null ? String(res.id) : null };
}

export async function deleteN8nExecution(ctx: AppContext, id: string): Promise<void> {
  await apiJson(ctx, `/api/v1/executions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// LocalSURV → n8n event webhooks
// ---------------------------------------------------------------------------

export function listN8nEventStarters(ctx: AppContext): N8nEventStarter[] {
  const map = readWebhookMap(ctx);
  return N8N_EVENT_STARTERS.map((s) => ({
    ...s,
    installed: Boolean(map[s.event]),
    webhookUrl: map[s.event] ?? null
  }));
}

/**
 * Register a LocalSURV → n8n webhook starter. The operator pastes the
 * production webhook URL from an n8n Webhook node, or uses one-click install.
 */
export function installN8nEventStarter(
  ctx: AppContext,
  event: string,
  webhookUrl: string,
  actor = "system"
): N8nEventStarter {
  const starter = N8N_EVENT_STARTERS.find((s) => s.event === event);
  if (!starter) throw httpError(`Unknown event: ${event}`, 400);
  const url = webhookUrl.trim();
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw httpError("Webhook URL must be an absolute http(s) URL", 400);
  }
  const map = readWebhookMap(ctx);
  map[event] = url;
  writeWebhookMap(ctx, map);
  writeAuditLog(ctx, {
    actor,
    action: "n8n.webhook.install",
    resourceType: "n8n",
    resourceId: event,
    statusCode: 200,
    details: url
  });
  return { ...starter, installed: true, webhookUrl: url };
}

export function removeN8nEventStarter(ctx: AppContext, event: string, actor = "system"): void {
  const map = readWebhookMap(ctx);
  if (!(event in map)) return;
  delete map[event];
  writeWebhookMap(ctx, map);
  writeAuditLog(ctx, {
    actor,
    action: "n8n.webhook.remove",
    resourceType: "n8n",
    resourceId: event,
    statusCode: 200
  });
}

function starterPath(event: string): string {
  return `localsurv-${event.replace(/\./g, "-")}`;
}

function starterName(event: string): string {
  const starter = N8N_EVENT_STARTERS.find((s) => s.event === event);
  return `LocalSURV · ${starter?.label ?? event}`;
}

/** Sample payloads so a freshly installed workflow can be test-fired. */
function samplePayload(event: string): Record<string, unknown> {
  if (event.startsWith("email.")) {
    return {
      thread_id: "sample-thread",
      service_id: null,
      mailbox: "support@example.com",
      message: {
        id: "sample-message",
        direction: event === "email.received" ? "in" : "out",
        from: { address: "jane@example.com", name: "Jane Doe" },
        to: [{ address: "support@example.com", name: null }],
        subject: "Sample message from LocalSURV",
        text: "This is a test event fired from the LocalSURV n8n tab.",
        snippet: "This is a test event fired from the LocalSURV n8n tab."
      }
    };
  }
  if (event.startsWith("license.")) {
    return { license_id: "sample-license", product: "pro", customer_email: "jane@example.com" };
  }
  return { service_id: "sample-service", service_name: "sample-app", message: "Test event from LocalSURV" };
}

/** Suggested importable n8n workflow JSON for a given LocalSURV event. */
export function n8nStarterWorkflowJson(event: string, publicBase?: string | null): object {
  const webhookPath = starterPath(event);
  return {
    name: starterName(event),
    nodes: [
      {
        parameters: {
          httpMethod: "POST",
          path: webhookPath,
          responseMode: "onReceived",
          options: {}
        },
        id: crypto.randomUUID(),
        name: "LocalSURV event",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [0, 0],
        webhookId: crypto.randomUUID()
      },
      {
        parameters: {},
        id: crypto.randomUUID(),
        name: "Your logic here",
        type: "n8n-nodes-base.noOp",
        typeVersion: 1,
        position: [260, 0]
      }
    ],
    connections: {
      "LocalSURV event": { main: [[{ node: "Your logic here", type: "main", index: 0 }]] }
    },
    settings: { executionOrder: "v1" },
    meta: {
      localsurvEvent: event,
      suggestedUrl: `${(publicBase ?? LOCAL_BASE).replace(/\/+$/, "")}/webhook/${webhookPath}`
    }
  };
}

/**
 * One-click: create (or reuse) the receiving workflow in n8n through the API,
 * activate it, and register its webhook. LocalSURV calls it on loopback, so it
 * works without a public URL.
 */
export async function autoInstallN8nEventStarter(
  ctx: AppContext,
  event: string,
  actor = "system"
): Promise<N8nEventStarter & { workflowId: string; editorUrl: string | null }> {
  if (!N8N_EVENT_STARTERS.some((s) => s.event === event)) throw httpError(`Unknown event: ${event}`, 400);
  const name = starterName(event);
  const existing = (await fetchAllWorkflows(ctx)).find((w) => w.name === name);
  let workflow: RawWorkflow;
  if (existing) {
    workflow = existing.active
      ? existing
      : await apiJson<RawWorkflow>(ctx, `/api/v1/workflows/${encodeURIComponent(String(existing.id))}/activate`, {
          method: "POST"
        });
  } else {
    const body = sanitizeWorkflowForImport(n8nStarterWorkflowJson(event));
    const created = await apiJson<RawWorkflow>(ctx, "/api/v1/workflows", {
      method: "POST",
      body: JSON.stringify(body)
    });
    workflow = await apiJson<RawWorkflow>(
      ctx,
      `/api/v1/workflows/${encodeURIComponent(String(created.id))}/activate`,
      { method: "POST" }
    );
  }
  const hookNode = (workflow.nodes ?? []).find((n) => n.type === "n8n-nodes-base.webhook");
  const hookPath = String(hookNode?.parameters?.path ?? starterPath(event)).replace(/^\/+/, "");
  const url = `${LOCAL_BASE}/webhook/${hookPath}`;
  const installed = installN8nEventStarter(ctx, event, url, actor);
  const editorBase = openUrlOf(ctx, true);
  return {
    ...installed,
    workflowId: String(workflow.id),
    editorUrl: editorBase ? `${editorBase.replace(/\/+$/, "")}/workflow/${workflow.id}` : null
  };
}

/** Fire a sample event at the registered webhook and report what n8n said. */
export async function testN8nEventStarter(
  ctx: AppContext,
  event: string
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const url = readWebhookMap(ctx)[event];
  if (!url) throw httpError("No webhook registered for this event yet", 400);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LocalSURV-Event": event, "X-LocalSURV-Test": "1" },
      body: JSON.stringify({ event, at: nowIso(), test: true, ...samplePayload(event) }),
      signal: AbortSignal.timeout(8000)
    });
    return res.ok
      ? { ok: true, status: res.status }
      : {
          ok: false,
          status: res.status,
          error:
            res.status === 404
              ? "n8n has no active workflow on that path — activate the workflow"
              : `n8n answered ${res.status}`
        };
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  }
}

/**
 * Fan-out a LocalSURV event to any installed n8n webhook starters.
 * Failures are swallowed — automation must never break the control plane.
 */
export async function emitN8nEvent(
  ctx: AppContext,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = readWebhookMap(ctx)[event];
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LocalSURV-Event": event },
      body: JSON.stringify({ event, at: nowIso(), ...payload }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    /* ignore */
  }
}
