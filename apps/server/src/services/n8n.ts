/**
 * Managed n8n add-on.
 *
 * n8n runs as a Docker container (`serverhoster-n8n`), not a SURVHub service
 * row. Lifecycle mirrors the Plex tab: status polling, power actions, logs,
 * plus add-on specifics — encryption-key bootstrap, public WEBHOOK_URL,
 * one-click AI Gateway consumer-token wiring, workflow listing, and
 * LocalSURV → n8n event webhook starters (including license.*).
 */

import crypto from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { getSetting, setSetting, getSecretSetting, setSecretSetting } from "./settings.js";
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
  State: { Running: boolean; Status: string };
  Config?: { Image?: string; Labels?: Record<string, string> };
};

const N8N_IMAGE = "docker.n8n.io/n8nio/n8n:latest";
const N8N_CONTAINER = "serverhoster-n8n";
const N8N_PORT = 5678;

const SETTING_PUBLIC_URL = "n8n_public_url";
const SETTING_AUTOSTART = "n8n_autostart";
const SETTING_ENCRYPTION = "n8n_encryption_key";
const SETTING_API_KEY = "n8n_api_key";
const SETTING_AI_TOKEN = "n8n_ai_gateway_token";
const SETTING_AI_TOKEN_ID = "n8n_ai_gateway_token_id";
const SETTING_WEBHOOKS = "n8n_event_webhooks";

export type N8nPowerAction = "start" | "stop" | "restart";

export type N8nStatus = {
  installed: boolean;
  running: boolean;
  state: string;
  reachable: boolean;
  version: string | null;
  port: number;
  dataDir: string;
  publicUrl: string | null;
  openUrl: string | null;
  webhookUrl: string | null;
  autostart: boolean;
  encryptionKeySet: boolean;
  apiKeySet: boolean;
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
  updatedAt: string | null;
};

export type N8nEventStarter = {
  event: string;
  label: string;
  description: string;
  installed: boolean;
  webhookUrl: string | null;
};

/** LocalSURV events that can fan out into n8n webhook workflows. */
export const N8N_EVENT_STARTERS: Array<{ event: string; label: string; description: string }> = [
  {
    event: "deployment.succeeded",
    label: "Deployment succeeded",
    description: "Fires when a service deploy finishes successfully."
  },
  {
    event: "deployment.failed",
    label: "Deployment failed",
    description: "Fires when a service deploy fails."
  },
  {
    event: "service.crashed",
    label: "Service crashed",
    description: "Fires when a watched service exits unexpectedly."
  },
  {
    event: "license.issued",
    label: "License issued",
    description: "Fires when a new license key is generated."
  },
  {
    event: "license.revoked",
    label: "License revoked",
    description: "Fires when a license key is revoked."
  },
  {
    event: "license.extended",
    label: "License extended",
    description: "Fires when a license expiry is extended."
  },
  {
    event: "license.validated",
    label: "License validated",
    description: "Fires on each successful public license validation."
  },
  {
    event: "license.activation",
    label: "License activation",
    description: "Fires when a new device fingerprint activates a key."
  }
];

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
  return publicUrlOf(ctx) ?? `http://127.0.0.1:${N8N_PORT}`;
}

function webhookUrlOf(ctx: AppContext): string | null {
  const publicUrl = publicUrlOf(ctx);
  if (publicUrl) return publicUrl;
  return `http://127.0.0.1:${N8N_PORT}/`;
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

function ensureApiKey(ctx: AppContext): string {
  const existing = getSecretSetting(ctx, SETTING_API_KEY);
  if (existing) return existing;
  const key = `n8n_${crypto.randomBytes(24).toString("base64url")}`;
  setSecretSetting(ctx, SETTING_API_KEY, key);
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

async function containerInspect(ctx: AppContext): Promise<ContainerInspectInfo | null> {
  try {
    return (await ctx.docker.getContainer(N8N_CONTAINER).inspect()) as ContainerInspectInfo;
  } catch {
    return null;
  }
}

async function pingN8n(base: string): Promise<boolean> {
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/healthz", {
      signal: AbortSignal.timeout(2500)
    });
    return res.ok;
  } catch {
    try {
      const res = await fetch(base.replace(/\/+$/, "") + "/", {
        signal: AbortSignal.timeout(2500)
      });
      return res.status > 0;
    } catch {
      return false;
    }
  }
}

export async function getN8nStatus(ctx: AppContext): Promise<N8nStatus> {
  const info = await containerInspect(ctx);
  const running = Boolean(info?.State?.Running);
  const state = info?.State?.Status ?? (info ? "created" : "absent");
  const version =
    (info?.Config?.Labels?.["org.opencontainers.image.version"] as string | undefined) ??
    (info?.Config?.Image?.includes(":") ? info.Config.Image.split(":").pop() ?? null : null);
  const openUrl = openUrlOf(ctx, running);
  const reachable = running ? await pingN8n(openUrl ?? `http://127.0.0.1:${N8N_PORT}`) : false;
  const aiToken = getSecretSetting(ctx, SETTING_AI_TOKEN);
  const aiBase = resolveAiBaseUrl(ctx);
  const gw = getGatewayConfig(ctx);

  return {
    installed: info !== null,
    running,
    state,
    reachable,
    version,
    port: N8N_PORT,
    dataDir: dataDirOf(ctx),
    publicUrl: publicUrlOf(ctx),
    openUrl,
    webhookUrl: webhookUrlOf(ctx),
    autostart: autostartEnabled(ctx),
    encryptionKeySet: Boolean(getSecretSetting(ctx, SETTING_ENCRYPTION)),
    apiKeySet: Boolean(getSecretSetting(ctx, SETTING_API_KEY)),
    aiGateway: {
      wired: Boolean(aiToken),
      baseUrl: aiToken ? aiBase : null,
      tokenPreview: aiToken ? `${aiToken.slice(0, 10)}…` : null,
      gatewayEnabled: isExternalMode(ctx) || gw.enabled || inferenceServerRunning()
    },
    updatedAt: nowIso()
  };
}

async function pullImage(ctx: AppContext): Promise<void> {
  try {
    await ctx.docker.getImage(N8N_IMAGE).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      ctx.docker.pull(N8N_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        ctx.docker.modem.followProgress(stream, (followErr: Error | null) =>
          followErr ? reject(followErr) : resolve()
        );
      });
    });
  }
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

function buildEnv(ctx: AppContext): string[] {
  const encryptionKey = ensureEncryptionKey(ctx);
  const apiKey = ensureApiKey(ctx);
  const publicUrl = publicUrlOf(ctx);
  const webhookUrl = webhookUrlOf(ctx);
  const env: string[] = [
    `N8N_ENCRYPTION_KEY=${encryptionKey}`,
    `N8N_PORT=5678`,
    `N8N_LISTEN_ADDRESS=0.0.0.0`,
    `N8N_API_KEY=${apiKey}`,
    // Disable personal-data telemetry for self-hosted operators.
    `N8N_DIAGNOSTICS_ENABLED=false`,
    `N8N_PERSONALIZATION_ENABLED=false`
  ];

  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      env.push(`N8N_HOST=${u.hostname}`);
      env.push(`N8N_PROTOCOL=${u.protocol.replace(":", "")}`);
      if (u.port) env.push(`N8N_PORT_EDITOR=${u.port}`);
      env.push(`WEBHOOK_URL=${publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`}`);
      env.push(`N8N_EDITOR_BASE_URL=${publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`}`);
    } catch {
      env.push(`WEBHOOK_URL=${webhookUrl}`);
    }
  } else if (webhookUrl) {
    env.push(`WEBHOOK_URL=${webhookUrl.endsWith("/") ? webhookUrl : `${webhookUrl}/`}`);
  }

  const aiToken = getSecretSetting(ctx, SETTING_AI_TOKEN);
  const aiBase = resolveAiBaseUrl(ctx);
  if (aiToken && aiBase) {
    env.push(`OPENAI_API_KEY=${aiToken}`);
    env.push(`OPENAI_BASE_URL=${aiBase}`);
  }

  return env;
}

async function createAndStartN8n(ctx: AppContext): Promise<void> {
  await pullImage(ctx);
  const dataDir = dataDirOf(ctx);
  await mkdir(dataDir, { recursive: true, mode: 0o777 });

  const restart = autostartEnabled(ctx)
    ? { Name: "unless-stopped" as const }
    : { Name: "no" as const };

  const container = await ctx.docker.createContainer({
    Image: N8N_IMAGE,
    name: N8N_CONTAINER,
    Env: buildEnv(ctx),
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

  await container.start();
}

/** Recreate the container so env / restart policy changes take effect. */
async function recreateN8n(ctx: AppContext, startAfter = true): Promise<void> {
  const wasRunning = (await containerInspect(ctx))?.State?.Running ?? false;
  await removeContainerIfExists(ctx);
  if (startAfter || wasRunning) {
    await createAndStartN8n(ctx);
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
      if (!info) {
        await createAndStartN8n(ctx);
      } else if (info.State.Running) {
        await ctx.docker.getContainer(N8N_CONTAINER).restart({ t: 15 });
      } else {
        // Env may have changed while stopped — recreate so settings apply.
        await recreateN8n(ctx, true);
      }
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
  // Give the editor a moment to bind 5678 before returning status.
  if (action !== "stop") await new Promise((r) => setTimeout(r, 1500));
  return getN8nStatus(ctx);
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
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      const err = new Error("Public URL must be an absolute http(s) URL") as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
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

/** Ensure encryption + API keys exist and are injected into a running container. */
export async function bootstrapN8nSecrets(ctx: AppContext): Promise<N8nStatus> {
  ensureEncryptionKey(ctx);
  ensureApiKey(ctx);
  const info = await containerInspect(ctx);
  if (info?.State.Running) {
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
        const e = new Error(
          `Could not start AI Gateway: ${(err as Error).message}`
        ) as Error & { statusCode?: number };
        e.statusCode = 503;
        throw e;
      }
    }
  }

  const baseUrl = resolveAiBaseUrl(ctx);
  if (!baseUrl) {
    const e = new Error(
      "AI Gateway has no reachable base URL. Enable the gateway or set its Public URL."
    ) as Error & { statusCode?: number };
    e.statusCode = 400;
    throw e;
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
    if (!minted.token) {
      const e = new Error("External AI Gateway did not return a consumer token") as Error & {
        statusCode?: number;
      };
      e.statusCode = 502;
      throw e;
    }
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

async function n8nApiFetch(
  ctx: AppContext,
  apiPath: string,
  init?: RequestInit
): Promise<Response | null> {
  const apiKey = getSecretSetting(ctx, SETTING_API_KEY);
  if (!apiKey) return null;
  const base = openUrlOf(ctx, true) ?? `http://127.0.0.1:${N8N_PORT}`;
  try {
    return await fetch(`${base.replace(/\/+$/, "")}${apiPath}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "X-N8N-API-KEY": apiKey,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return null;
  }
}

export async function listN8nWorkflows(ctx: AppContext): Promise<{
  available: boolean;
  items: N8nWorkflow[];
  error?: string;
}> {
  const status = await getN8nStatus(ctx);
  if (!status.running || !status.apiKeySet) {
    return { available: false, items: [], error: status.running ? "API key not bootstrapped" : "n8n is stopped" };
  }
  const res = await n8nApiFetch(ctx, "/api/v1/workflows?limit=50");
  if (!res) return { available: false, items: [], error: "n8n API unreachable" };
  if (!res.ok) {
    return {
      available: false,
      items: [],
      error: `n8n API returned ${res.status}`
    };
  }
  try {
    const body = (await res.json()) as {
      data?: Array<{ id: string; name: string; active?: boolean; updatedAt?: string }>;
    };
    const items = (body.data ?? []).map((w) => ({
      id: String(w.id),
      name: w.name,
      active: Boolean(w.active),
      updatedAt: w.updatedAt ?? null
    }));
    return { available: true, items };
  } catch (err) {
    return { available: false, items: [], error: (err as Error).message };
  }
}

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
 * production webhook URL from an n8n Webhook node (or we generate a suggested
 * path under the public URL).
 */
export function installN8nEventStarter(
  ctx: AppContext,
  event: string,
  webhookUrl: string,
  actor = "system"
): N8nEventStarter {
  const starter = N8N_EVENT_STARTERS.find((s) => s.event === event);
  if (!starter) {
    const err = new Error(`Unknown event: ${event}`) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  const url = webhookUrl.trim();
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    const err = new Error("Webhook URL must be absolute") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
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

/** Suggested importable n8n workflow JSON for a given LocalSURV event. */
export function n8nStarterWorkflowJson(event: string, publicBase?: string | null): object {
  const starter = N8N_EVENT_STARTERS.find((s) => s.event === event);
  const name = starter?.label ?? event;
  const pathSlug = event.replace(/\./g, "-");
  const webhookPath = `localsurv-${pathSlug}`;
  return {
    name: `LocalSURV · ${name}`,
    nodes: [
      {
        parameters: {
          httpMethod: "POST",
          path: webhookPath,
          responseMode: "onReceived",
          options: {}
        },
        id: nanoid(),
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [0, 0],
        webhookId: nanoid()
      },
      {
        parameters: {
          values: {
            string: [
              { name: "event", value: `={{$json.event || "${event}"}}` },
              { name: "receivedAt", value: "={{$now}}" }
            ]
          },
          options: {}
        },
        id: nanoid(),
        name: "Normalize",
        type: "n8n-nodes-base.set",
        typeVersion: 3,
        position: [280, 0]
      }
    ],
    connections: {
      Webhook: { main: [[{ node: "Normalize", type: "main", index: 0 }]] }
    },
    meta: {
      localsurvEvent: event,
      suggestedUrl: publicBase
        ? `${publicBase.replace(/\/+$/, "")}/webhook/${webhookPath}`
        : `http://127.0.0.1:${N8N_PORT}/webhook/${webhookPath}`
    }
  };
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
