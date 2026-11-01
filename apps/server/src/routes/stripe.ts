/**
 * Stripe routes (dashboard + REST for agents).
 *
 * Everything is under /api/stripe and therefore gated by the dashboard session
 * like the rest of /api; nothing here is public. No route accepts a key except
 * PUT /api/stripe/keys/:mode, and no route ever returns one. Writes to live
 * Stripe need `confirmLive: true` in the body.
 *
 * Key fields are validated by hand (not through Zod) so that no validation
 * error, which the global handler echoes back, can ever contain a key.
 */

import type { AppContext } from "../types.js";
import {
  connectApp,
  disconnectApp,
  ensurePortal,
  ensureProductPrice,
  ensureWebhook,
  getStatus,
  listApps,
  removeKeys,
  saveKeys,
  verifyKeys,
  type StripeDeps
} from "../services/stripe.js";

const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

function body(req: { body?: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

export function registerStripeRoutes(ctx: AppContext, deps: StripeDeps = {}): void {
  const actorOf = (req: unknown) => (req as { actor?: string }).actor ?? "dashboard";

  ctx.app.get("/api/stripe/status", async () => getStatus(ctx));

  ctx.app.put("/api/stripe/keys/:mode", limited, async (req) => {
    const { mode } = req.params as { mode: string };
    const b = body(req);
    return saveKeys(ctx, actorOf(req), mode, { secretKey: b.secretKey, publishableKey: b.publishableKey, webhookSecret: b.webhookSecret });
  });

  ctx.app.delete("/api/stripe/keys/:mode", limited, async (req) => {
    const { mode } = req.params as { mode: string };
    const { part } = (req.query ?? {}) as { part?: string };
    return removeKeys(ctx, actorOf(req), mode, part);
  });

  ctx.app.post("/api/stripe/verify/:mode", limited, async (req) => {
    const { mode } = req.params as { mode: string };
    return { ok: true, account: await verifyKeys(ctx, actorOf(req), mode, deps) };
  });

  ctx.app.get("/api/stripe/apps", async () => ({ apps: listApps(ctx) }));

  ctx.app.post("/api/stripe/apps/:serviceId/connect", limited, async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    const b = body(req);
    return connectApp(ctx, actorOf(req), { serviceId, mode: b.mode, confirmLive: b.confirmLive, takeover: b.takeover });
  });

  ctx.app.delete("/api/stripe/apps/:serviceId", limited, async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    return disconnectApp(ctx, actorOf(req), serviceId);
  });

  ctx.app.post("/api/stripe/setup/product-price", limited, async (req) => ensureProductPrice(ctx, actorOf(req), body(req), deps));
  ctx.app.post("/api/stripe/setup/webhook", limited, async (req) => ensureWebhook(ctx, actorOf(req), body(req), deps));
  ctx.app.post("/api/stripe/setup/portal", limited, async (req) => ensurePortal(ctx, actorOf(req), body(req), deps));
}
