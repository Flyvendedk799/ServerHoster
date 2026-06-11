import crypto from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { isAuthorizedToken, resolveActorFromToken } from "../services/auth.js";
import { getSecretSetting, getSetting, setSecretSetting, setSetting } from "../services/settings.js";
import {
  deleteSaasDomain,
  ensureFallbackOrigin,
  exposeApiHostname,
  getSaasConfigStatus,
  listSaasDomains,
  registerSaasDomain,
  verifySaasDomain
} from "../services/saasDomains.js";

const registerSchema = z.object({ hostname: z.string().min(1) });
const configSchema = z.object({
  fallbackOrigin: z.string().min(1).optional(),
  fallbackServiceId: z.string().min(1).optional(),
  apiHostname: z.string().min(1).optional()
});

function bearerToken(req: { headers: { authorization?: string } }): string {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
}

function timingSafeEquals(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** True when the request carries the long-lived machine token (edge functions). */
function isMachineToken(ctx: AppContext, token: string): boolean {
  if (!token) return false;
  const configured = getSecretSetting(ctx, "saas_api_token");
  return Boolean(configured && timingSafeEquals(token, configured));
}

/**
 * Routes under /saas are EXEMPT from the global session-auth hook (mirroring
 * /webhooks) because they're called by external machine clients — a hosted
 * app's Supabase edge functions — holding the dedicated `saas_api_token`.
 * Every handler below still authenticates: domain CRUD accepts a dashboard
 * session OR the machine token; configuration and token rotation are
 * dashboard-only so a leaked machine token can't escalate.
 */
export function registerSaasDomainRoutes(ctx: AppContext): void {
  const requireAny = (req: { headers: { authorization?: string } }): void => {
    const token = bearerToken(req);
    if (isMachineToken(ctx, token)) return;
    if (isAuthorizedToken(ctx, token)) return;
    const err = new Error("Unauthorized") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  };
  const requireDashboard = (req: { headers: { authorization?: string } }): void => {
    const token = bearerToken(req);
    if (isAuthorizedToken(ctx, token)) return;
    const err = new Error("Unauthorized (dashboard session required)") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  };
  const stampActor = (req: { headers: { authorization?: string } }): void => {
    const token = bearerToken(req);
    (req as { actor?: string }).actor = isMachineToken(ctx, token)
      ? "saas-machine-token"
      : (resolveActorFromToken(ctx, token) ?? "unknown");
  };

  ctx.app.get("/saas/config", async (req) => {
    requireAny(req);
    stampActor(req);
    return getSaasConfigStatus(ctx);
  });

  ctx.app.post("/saas/config", async (req) => {
    requireDashboard(req);
    stampActor(req);
    const p = configSchema.parse(req.body);
    if (p.fallbackServiceId !== undefined) {
      const svc = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(p.fallbackServiceId);
      if (!svc) {
        const err = new Error("fallbackServiceId does not match any service") as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      setSetting(ctx, "saas_fallback_service_id", p.fallbackServiceId);
    }
    if (p.fallbackOrigin !== undefined) {
      setSetting(ctx, "saas_fallback_origin", p.fallbackOrigin.trim().toLowerCase());
    }
    let fallbackError: string | null = null;
    const fallbackServiceId = getSetting(ctx, "saas_fallback_service_id");
    if ((p.fallbackOrigin !== undefined || p.fallbackServiceId !== undefined) && fallbackServiceId) {
      try {
        await ensureFallbackOrigin(ctx, fallbackServiceId);
      } catch (error) {
        fallbackError = error instanceof Error ? error.message : String(error);
      }
    }
    let apiHostnameError: string | null = null;
    if (p.apiHostname !== undefined) {
      try {
        await exposeApiHostname(ctx, p.apiHostname);
      } catch (error) {
        apiHostnameError = error instanceof Error ? error.message : String(error);
      }
    }
    return { ok: !fallbackError && !apiHostnameError, fallbackError, apiHostnameError, status: getSaasConfigStatus(ctx) };
  });

  // Generates (or replaces) the machine token. The plaintext is returned ONCE —
  // it's stored encrypted and never readable again, only rotatable.
  ctx.app.post("/saas/token/rotate", async (req) => {
    requireDashboard(req);
    stampActor(req);
    const token = `shsaas_${crypto.randomBytes(32).toString("hex")}`;
    setSecretSetting(ctx, "saas_api_token", token);
    return { token };
  });

  ctx.app.get("/saas/services/:serviceId/domains", async (req) => {
    requireAny(req);
    stampActor(req);
    const { serviceId } = req.params as { serviceId: string };
    return listSaasDomains(ctx, serviceId);
  });

  ctx.app.post("/saas/services/:serviceId/domains", async (req) => {
    requireAny(req);
    stampActor(req);
    const { serviceId } = req.params as { serviceId: string };
    const p = registerSchema.parse(req.body);
    return registerSaasDomain(ctx, serviceId, p.hostname);
  });

  ctx.app.post("/saas/domains/:domainId/verify", async (req) => {
    requireAny(req);
    stampActor(req);
    const { domainId } = req.params as { domainId: string };
    return verifySaasDomain(ctx, domainId);
  });

  ctx.app.delete("/saas/domains/:domainId", async (req) => {
    requireAny(req);
    stampActor(req);
    const { domainId } = req.params as { domainId: string };
    return deleteSaasDomain(ctx, domainId);
  });
}
