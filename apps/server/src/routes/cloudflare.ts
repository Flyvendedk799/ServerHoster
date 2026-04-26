import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  detectCloudflared,
  getTunnelStatus,
  removeTunnelIngress,
  saveTunnelConfig,
  startTunnel,
  stopTunnel,
  upsertDnsCname,
  upsertTunnelIngress
} from "../services/cloudflare.js";
import { setSecretSetting, deleteSetting } from "../services/settings.js";

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
}
