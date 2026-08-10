import os from "node:os";
import { z } from "zod";
import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";
import {
  PairingError,
  cancelPairing,
  claimPairing,
  createPairing,
  getPairingStatus,
  listCompanionDevices,
  resolveCompanionDevice,
  revokeCompanionDevice,
  serverDisplayName
} from "../services/companion.js";

const createPairingSchema = z.object({
  scope: z.enum(["read", "control"]).default("control"),
  label: z.string().max(60).optional(),
  /** Explicit override — the operator knows best which address the phone can reach. */
  serverUrl: z.string().url().optional()
});

const claimSchema = z.object({
  code: z.string().min(4).max(32),
  deviceName: z.string().min(1).max(60),
  platform: z.string().max(60).optional()
});

export type EndpointCandidate = {
  url: string;
  kind: "configured" | "dashboard-origin" | "proxy-domain" | "lan" | "loopback";
  label: string;
  /** False for addresses that only resolve on the same machine or LAN. */
  remote: boolean;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLoopbackHost(host: string): boolean {
  const bare = host.split(":")[0].toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "0.0.0.0" || bare === "::1";
}

/**
 * Every address this control plane might be reachable at, best first.
 *
 * This is the one genuinely hard part of pairing: the dashboard is usually open
 * on `localhost:8787`, which is useless to a phone on mobile data. So rather
 * than guess, collect the candidates the host actually knows about — an
 * explicitly configured public URL, the origin the dashboard was served from, a
 * proxy route pointing back at the API port, LAN interfaces — and let the
 * operator pick in the pairing UI.
 */
export function companionEndpointCandidates(ctx: AppContext, requestHost?: string): EndpointCandidate[] {
  const candidates: EndpointCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: EndpointCandidate): void => {
    const url = stripTrailingSlash(candidate.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ ...candidate, url });
  };

  if (ctx.config.publicUrl) {
    push({
      url: ctx.config.publicUrl,
      kind: "configured",
      label: "Configured public URL (SURVHUB_PUBLIC_URL)",
      remote: true
    });
  }

  if (requestHost && !isLoopbackHost(requestHost)) {
    const scheme = ctx.config.enableHttps ? "https" : "http";
    push({
      url: `${scheme}://${requestHost}`,
      kind: "dashboard-origin",
      label: "This dashboard's address",
      remote: true
    });
  }

  const routes = ctx.db
    .prepare("SELECT domain FROM proxy_routes WHERE target_port = ? ORDER BY created_at DESC")
    .all(ctx.config.apiPort) as Array<{ domain: string }>;
  for (const route of routes) {
    push({
      url: `https://${route.domain}`,
      kind: "proxy-domain",
      label: `Domain routed to the control plane`,
      remote: true
    });
  }

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      push({
        url: `http://${addr.address}:${ctx.config.apiPort}`,
        kind: "lan",
        label: `Local network (${name}) — same Wi-Fi only`,
        remote: false
      });
    }
  }

  push({
    url: `http://localhost:${ctx.config.apiPort}`,
    kind: "loopback",
    label: "This machine only",
    remote: false
  });

  return candidates;
}

/**
 * What the QR encodes. Kept small — every byte costs QR modules, and a denser
 * code is a code a phone camera fails to read across a desk.
 */
function pairingPayload(input: {
  serverUrl: string;
  code: string;
  serverName: string;
  expiresAt: number;
}): string {
  return JSON.stringify({
    v: 1,
    t: "serverhoster-pair",
    url: input.serverUrl,
    code: input.code,
    name: input.serverName,
    exp: input.expiresAt
  });
}

export function registerCompanionRoutes(ctx: AppContext): void {
  // --- Dashboard-side pairing management -----------------------------------

  ctx.app.get("/companion/endpoints", async (req) => ({
    candidates: companionEndpointCandidates(ctx, req.headers.host),
    serverName: serverDisplayName(ctx)
  }));

  ctx.app.post("/companion/pairings", async (req, reply) => {
    const parsed = createPairingSchema.parse(req.body ?? {});
    const candidates = companionEndpointCandidates(ctx, req.headers.host);
    const serverUrl = parsed.serverUrl
      ? stripTrailingSlash(parsed.serverUrl)
      : (candidates.find((c) => c.remote) ?? candidates[0])?.url;
    if (!serverUrl) {
      reply.code(500).send({ error: "No reachable address for this control plane" });
      return;
    }
    const pairing = createPairing(ctx, {
      scope: parsed.scope,
      label: parsed.label ?? null,
      serverUrl
    });
    const serverName = serverDisplayName(ctx);
    return {
      id: pairing.id,
      code: pairing.code,
      scope: pairing.scope,
      serverUrl,
      serverName,
      expiresAt: pairing.expiresAt,
      payload: pairingPayload({ serverUrl, code: pairing.code, serverName, expiresAt: pairing.expiresAt }),
      /** Present only when the operator told us where the companion app is hosted. */
      appLink: ctx.config.companionAppUrl
        ? `${stripTrailingSlash(ctx.config.companionAppUrl)}/#/pair?s=${encodeURIComponent(serverUrl)}&c=${encodeURIComponent(pairing.code)}`
        : null
    };
  });

  ctx.app.get("/companion/pairings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = getPairingStatus(ctx, id);
    if (!status) {
      reply.code(404).send({ error: "Pairing not found" });
      return;
    }
    return status;
  });

  ctx.app.delete("/companion/pairings/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { ok: cancelPairing(ctx, id) };
  });

  ctx.app.get("/companion/devices", async () => ({ devices: listCompanionDevices(ctx) }));

  ctx.app.delete("/companion/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!revokeCompanionDevice(ctx, id)) {
      reply.code(404).send({ error: "Device not found" });
      return;
    }
    return { ok: true };
  });

  // --- Phone-side ----------------------------------------------------------

  // Unauthenticated by necessity: the phone has no credential until this call
  // succeeds. Guarded by a short-lived single-use code, a per-code attempt cap
  // (in claimPairing) and this per-IP rate limit.
  ctx.app.post(
    "/companion/pair/claim",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = claimSchema.parse(req.body);
      try {
        // `req.ip` is the socket peer unless SURVHUB_TRUST_PROXY names the hop
        // in front of us; behind an untrusted proxy every caller collapses into
        // one bucket, which is why that setting exists.
        const result = claimPairing(ctx, { ...parsed, caller: req.ip ?? "unknown" });
        return {
          token: result.token,
          deviceId: result.device.id,
          deviceName: result.device.name,
          scope: result.device.scope,
          expiresAt: result.device.expiresAt,
          serverUrl: result.serverUrl,
          server: result.server
        };
      } catch (err) {
        if (err instanceof PairingError) {
          reply.code(err.statusCode).send({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }
  );

  /**
   * Token introspection — the app calls this on launch to confirm it is still
   * paired. A dashboard session token is legitimate here too; it just resolves
   * to `device: null` rather than an error.
   */
  ctx.app.get("/companion/me", async (req) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return {
      device: resolveCompanionDevice(ctx, token),
      server: { name: serverDisplayName(ctx), platform: os.platform() }
    };
  });

  ctx.app.post("/companion/heartbeat", async (req) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const device = resolveCompanionDevice(ctx, token);
    return { ok: true, at: nowIso(), device: device?.id ?? null };
  });

  /** A phone revoking itself — "forget this server" without reaching a laptop. */
  ctx.app.post("/companion/unpair", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const device = resolveCompanionDevice(ctx, token);
    if (!device) {
      reply.code(400).send({ error: "Not a paired device" });
      return;
    }
    revokeCompanionDevice(ctx, device.id);
    return { ok: true };
  });

  /**
   * One round trip for the whole home screen. The phone is on a bus with two
   * bars: five parallel requests is five chances to time out, so the mobile
   * client gets a single aggregate instead.
   */
  ctx.app.get("/companion/summary", async () => {
    const services = ctx.db
      .prepare(
        `SELECT s.id, s.name, s.status, s.type, s.port, s.project_id AS projectId, p.name AS projectName
           FROM services s LEFT JOIN projects p ON p.id = s.project_id
          ORDER BY p.name IS NULL, p.name, s.name`
      )
      .all() as Array<{
      id: string;
      name: string;
      status: string;
      type: string;
      port: number | null;
      projectId: string | null;
      projectName: string | null;
    }>;

    const counts = services.reduce<Record<string, number>>((acc, svc) => {
      acc[svc.status] = (acc[svc.status] ?? 0) + 1;
      return acc;
    }, {});

    const deployments = ctx.db
      .prepare(
        `SELECT d.id, d.service_id AS serviceId, s.name AS serviceName, d.status, d.commit_hash AS commitHash,
                d.created_at AS createdAt
           FROM deployments d LEFT JOIN services s ON s.id = d.service_id
          ORDER BY d.created_at DESC LIMIT 8`
      )
      .all();

    const unread = (
      ctx.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read = 0").get() as {
        count: number;
      }
    ).count;

    const notifications = ctx.db
      .prepare(
        `SELECT id, kind, severity, title, body, service_id AS serviceId, read, created_at AS createdAt
           FROM notifications ORDER BY created_at DESC LIMIT 8`
      )
      .all();

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return {
      server: {
        name: serverDisplayName(ctx),
        platform: os.platform(),
        uptimeSeconds: os.uptime()
      },
      system: {
        totalMemory,
        freeMemory,
        memoryUsedPercent: totalMemory > 0 ? Math.round(((totalMemory - freeMemory) / totalMemory) * 100) : 0,
        loadAvg: os.loadavg(),
        cpus: os.cpus().length
      },
      services,
      counts: {
        total: services.length,
        running: counts.running ?? 0,
        stopped: counts.stopped ?? 0,
        error: counts.error ?? 0,
        building: counts.building ?? 0
      },
      deployments,
      notifications,
      unreadNotifications: unread,
      generatedAt: nowIso()
    };
  });
}
