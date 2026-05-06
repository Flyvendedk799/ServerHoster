import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  deleteDnsRecord,
  detectCloudflared,
  ensureCloudflared,
  getTunnelStatus,
  getQuickTunnelStatus,
  removeTunnelIngress,
  saveTunnelConfig,
  setSystemEnv,
  startTunnel,
  startQuickTunnel,
  stopTunnel,
  stopQuickTunnel,
  upsertDnsCname,
  upsertTunnelIngress
} from "../services/cloudflare.js";
import { broadcast, nowIso } from "../lib/core.js";
import { setSecretSetting, deleteSetting, getSetting, getSecretSetting } from "../services/settings.js";
import { enqueueCleanup } from "../services/cleanupQueue.js";

const configSchema = z.object({
  accountId: z.string().optional(),
  tunnelId: z.string().optional(),
  zoneId: z.string().optional(),
  cloudflaredBinaryPath: z.string().optional()
});

const routeSchema = z.object({
  domain: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535)
});

export function registerCloudflareRoutes(ctx: AppContext): void {
  ctx.app.get("/cloudflare/status", async () => getTunnelStatus(ctx));

  ctx.app.get("/cloudflare/detect", async () => detectCloudflared(ctx));

  ctx.app.put("/cloudflare/config", async (req) => {
    const p = configSchema.parse(req.body);
    saveTunnelConfig(ctx, p);
    return { ok: true, status: getTunnelStatus(ctx) };
  });

  ctx.app.put("/cloudflare/api-token", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    // Validate against /user/tokens/verify
    const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Cloudflare rejected API token (HTTP ${res.status})`);
    setSecretSetting(ctx, "cloudflare_api_token", token);
    return { ok: true };
  });

  ctx.app.delete("/cloudflare/api-token", async () => {
    deleteSetting(ctx, "cloudflare_api_token");
    return { ok: true };
  });

  ctx.app.put("/cloudflare/tunnel-token", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    setSecretSetting(ctx, "cloudflare_tunnel_token", token);
    return { ok: true };
  });

  ctx.app.delete("/cloudflare/tunnel-token", async () => {
    deleteSetting(ctx, "cloudflare_tunnel_token");
    return { ok: true };
  });

  ctx.app.post("/cloudflare/start", async () => startTunnel(ctx));
  ctx.app.post("/cloudflare/stop", async () => stopTunnel(ctx));

  ctx.app.post("/cloudflare/routes/ensure", async (req) => {
    const p = routeSchema.parse(req.body);
    const domain = p.domain.toLowerCase();
    const dns = await upsertDnsCname(ctx, domain);
    await upsertTunnelIngress(ctx, domain, p.targetPort);
    return { ok: true, dns, domain, targetPort: p.targetPort };
  });

  ctx.app.post("/cloudflare/routes/remove", async (req) => {
    const { domain } = z.object({ domain: z.string().min(1) }).parse(req.body);
    await removeTunnelIngress(ctx, domain.toLowerCase());
    return { ok: true };
  });

  // ===== Per-service quick tunnels ==========================================

  ctx.app.post("/cloudflare/install-cloudflared", async () => {
    const binaryPath = await ensureCloudflared(ctx);
    return { ok: true, binaryPath };
  });

  ctx.app.get("/cloudflare/quick-tunnel/:serviceId", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    return getQuickTunnelStatus(serviceId);
  });

  ctx.app.post("/cloudflare/quick-tunnel/:serviceId", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    const service = ctx.db.prepare("SELECT port, status FROM services WHERE id = ?").get(serviceId) as
      | { port?: number; status?: string }
      | undefined;
    if (!service) throw new Error("Service not found");
    if (!service.port) throw new Error("Service has no port assigned; cannot start quick tunnel");
    // Atomic flag flip protects against two tabs racing the toggle: only the
    // first transaction sees enabled=0 and proceeds to spawn cloudflared.
    const flipped = ctx.db.transaction(() => {
      const row = ctx.db.prepare("SELECT quick_tunnel_enabled FROM services WHERE id = ?").get(serviceId) as
        | { quick_tunnel_enabled?: number }
        | undefined;
      if (row?.quick_tunnel_enabled) return false;
      ctx.db
        .prepare("UPDATE services SET quick_tunnel_enabled = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), serviceId);
      return true;
    })();
    // startQuickTunnel is itself idempotent (returns early if already running),
    // so it's safe to call here either way once the flag is set.
    if (service.status === "running") {
      startQuickTunnel(ctx, serviceId, service.port);
    }
    if (flipped) broadcast(ctx, { type: "exposure_changed", serviceId });
    return { ok: true, status: getQuickTunnelStatus(serviceId), spawned: service.status === "running" };
  });

  ctx.app.post("/cloudflare/quick-tunnel/:serviceId/regenerate", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    const service = ctx.db.prepare("SELECT port, status FROM services WHERE id = ?").get(serviceId) as
      | { port?: number; status?: string }
      | undefined;
    if (!service) throw new Error("Service not found");
    if (!service.port) throw new Error("Service has no port assigned");
    stopQuickTunnel(ctx, serviceId);
    // Wait briefly for the SIGTERM to land so the new tunnel claims the slot.
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (service.status === "running") startQuickTunnel(ctx, serviceId, service.port);
    broadcast(ctx, { type: "exposure_changed", serviceId });
    return { ok: true, status: getQuickTunnelStatus(serviceId) };
  });

  ctx.app.delete("/cloudflare/quick-tunnel/:serviceId", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    ctx.db
      .prepare("UPDATE services SET quick_tunnel_enabled = 0, tunnel_url = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), serviceId);
    stopQuickTunnel(ctx, serviceId);
    broadcast(ctx, { type: "exposure_changed", serviceId });
    return { ok: true };
  });

  // ===== Named tunnel + custom domain (Go Public S3) ========================

  /**
   * Bulk-save Cloudflare credentials in one call. Validates the API token via
   * /user/tokens/verify before persisting any of them so the wizard can fail
   * fast on a bad paste.
   */
  ctx.app.post("/cloudflare/credentials", async (req) => {
    const p = z
      .object({
        apiToken: z.string().min(10).optional(),
        tunnelToken: z.string().min(10).optional(),
        accountId: z.string().min(1).optional(),
        tunnelId: z.string().min(1).optional(),
        zoneId: z.string().min(1).optional()
      })
      .parse(req.body);
    if (p.apiToken) {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${p.apiToken}` }
      });
      if (!res.ok) throw new Error(`Cloudflare rejected API token (HTTP ${res.status})`);
      setSecretSetting(ctx, "cloudflare_api_token", p.apiToken);
    }
    if (p.tunnelToken) setSecretSetting(ctx, "cloudflare_tunnel_token", p.tunnelToken);
    saveTunnelConfig(ctx, {
      accountId: p.accountId,
      tunnelId: p.tunnelId,
      zoneId: p.zoneId
    });
    return { ok: true, status: getTunnelStatus(ctx) };
  });

  /**
   * Bind a custom domain to a service via the named Cloudflare tunnel. Idempotent;
   * if the domain is already bound to this service the call is a no-op.
   */
  ctx.app.post("/services/:id/expose/domain", async (req) => {
    const { id: serviceId } = req.params as { id: string };
    const { domain: rawDomain } = z.object({ domain: z.string().min(1) }).parse(req.body);
    const domain = rawDomain.trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain === "localhost") {
      throw new Error("domain must be a valid hostname (e.g. app.example.com)");
    }
    const service = ctx.db.prepare("SELECT id, port, domain FROM services WHERE id = ?").get(serviceId) as
      | { id: string; port?: number; domain?: string }
      | undefined;
    if (!service) throw new Error("Service not found");
    if (!service.port) throw new Error("Service has no port assigned");
    if (!getSecretSetting(ctx, "cloudflare_api_token")) {
      const e = new Error("Cloudflare API token is not configured");
      (e as Error & { statusCode?: number }).statusCode = 422;
      throw e;
    }
    if (!getSetting(ctx, "cloudflare_tunnel_id") || !getSetting(ctx, "cloudflare_zone_id")) {
      const e = new Error("Cloudflare tunnel ID and zone ID must both be configured");
      (e as Error & { statusCode?: number }).statusCode = 422;
      throw e;
    }
    // If a different domain was previously bound, schedule cleanup of the old
    // record before flipping to the new one. We try inline first, queue on failure.
    const previous = service.domain && service.domain !== domain ? service.domain : null;

    startTunnel(ctx); // idempotent — ensures cloudflared run is up
    await upsertDnsCname(ctx, domain);
    await upsertTunnelIngress(ctx, domain, service.port);

    ctx.db.transaction(() => {
      // Replace any old proxy_routes row for this service.
      ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(serviceId);
      ctx.db
        .prepare(
          "INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(nanoid(), serviceId, domain, service.port, nowIso());
      ctx.db
        .prepare("UPDATE services SET domain = ?, ssl_status = 'cloudflare', updated_at = ? WHERE id = ?")
        .run(domain, nowIso(), serviceId);
      setSystemEnv(ctx, serviceId, "PUBLIC_URL", `https://${domain}`);
    })();

    if (previous) {
      try {
        await removeTunnelIngress(ctx, previous);
        await deleteDnsRecord(ctx, previous);
      } catch {
        enqueueCleanup(ctx, "remove_ingress", { domain: previous });
        enqueueCleanup(ctx, "delete_dns", { domain: previous });
      }
    }
    broadcast(ctx, { type: "exposure_changed", serviceId });
    return { ok: true, domain, public_url: `https://${domain}` };
  });

  /** Tear down the custom-domain binding for a service. */
  ctx.app.delete("/services/:id/expose/domain", async (req) => {
    const { id: serviceId } = req.params as { id: string };
    const service = ctx.db.prepare("SELECT id, domain FROM services WHERE id = ?").get(serviceId) as
      | { id: string; domain?: string }
      | undefined;
    if (!service) throw new Error("Service not found");
    if (!service.domain) return { ok: true };
    const domain = service.domain;
    try {
      await removeTunnelIngress(ctx, domain);
    } catch {
      enqueueCleanup(ctx, "remove_ingress", { domain });
    }
    try {
      await deleteDnsRecord(ctx, domain);
    } catch {
      enqueueCleanup(ctx, "delete_dns", { domain });
    }
    ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(serviceId);
      ctx.db
        .prepare("UPDATE services SET domain = NULL, ssl_status = 'none', updated_at = ? WHERE id = ?")
        .run(nowIso(), serviceId);
      setSystemEnv(ctx, serviceId, "PUBLIC_URL", null);
    })();
    broadcast(ctx, { type: "exposure_changed", serviceId });
    return { ok: true };
  });

  /**
   * HTTP HEAD probe against the bound domain. Useful for the wizard's "Test"
   * button so users can confirm DNS has propagated before treating a binding
   * as healthy.
   */
  ctx.app.post("/services/:id/expose/test", async (req) => {
    const { id: serviceId } = req.params as { id: string };
    const service = ctx.db.prepare("SELECT domain FROM services WHERE id = ?").get(serviceId) as
      | { domain?: string }
      | undefined;
    if (!service?.domain) throw new Error("Service has no domain bound");
    const url = `https://${service.domain}`;
    const start = Date.now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: ctrl.signal });
      return { ok: res.status < 500, status: res.status, latencyMs: Date.now() - start, url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, latencyMs: Date.now() - start, url, error: message };
    } finally {
      clearTimeout(timeout);
    }
  });
}
