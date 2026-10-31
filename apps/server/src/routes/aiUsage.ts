/**
 * AI Usage routes.
 *
 * Management and read routes live under /api/ai-usage and are gated by the
 * dashboard session like the rest of /api. The one exception is
 * POST /api/ai-usage/report: hosted apps have no dashboard session, so it is
 * exempted in routes/auth.ts and authenticates with the per-service token
 * (SURVHUB_AI_USAGE_TOKEN) verified here.
 */

import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../types.js";
import { writeAuditLog } from "../services/audit.js";
import {
  connectService,
  disconnectService,
  getBudgets,
  listApps,
  modelPrices,
  recentEvents,
  recordUsage,
  serviceForToken,
  setBudgets,
  setPriceOverrides,
  usageSummary
} from "../services/aiUsage.js";

const eventSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(120),
  feature: z.string().trim().max(60).nullish(),
  input_tokens: z.number().int().min(0).max(1e9),
  output_tokens: z.number().int().min(0).max(1e9),
  cache_read_tokens: z.number().int().min(0).max(1e9).optional(),
  cache_write_tokens: z.number().int().min(0).max(1e9).optional(),
  status: z.enum(["ok", "error"]),
  error_code: z.string().trim().max(60).nullish(),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
  request_ref: z.string().trim().min(1).max(120).nullish(),
  cost_micro_usd: z.number().int().min(0).max(1e10).nullish()
});

const reportSchema = z.union([eventSchema, z.object({ events: z.array(eventSchema).min(1).max(100) })]);

const priceSchema = z.object({
  input: z.number().min(0).max(10000),
  output: z.number().min(0).max(10000),
  cacheRead: z.number().min(0).max(10000),
  cacheWrite: z.number().min(0).max(10000)
});

const budgetSchema = z.object({
  global_daily_usd: z.number().positive().max(1_000_000).nullable(),
  per_service: z.record(
    z.string().max(80),
    z.object({
      daily_usd: z.number().positive().max(1_000_000).nullable(),
      monthly_usd: z.number().positive().max(1_000_000).nullable()
    })
  )
});

function bearer(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  return auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
}

export function registerAiUsageRoutes(ctx: AppContext): void {
  // ---- Public: usage report from a hosted app (service token) --------------
  ctx.app.post(
    "/api/ai-usage/report",
    { bodyLimit: 256 * 1024, config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const svc = serviceForToken(ctx, bearer(req));
      if (!svc) {
        reply.code(401);
        return { error: "Invalid usage token" };
      }
      const body = reportSchema.parse(req.body ?? {});
      const events = "events" in body ? body.events : [body];
      let recorded = 0;
      // Per-event results let the app settle its own spend accounting against the
      // price ServerHoster computed (cost is null when the model has no price).
      const results = events.map((e) => {
        const r = recordUsage(ctx, svc.service_id, e);
        if (r.recorded) recorded++;
        return r;
      });
      return {
        ok: true,
        recorded,
        duplicates: events.length - recorded,
        results,
        // Convenience for the single-event form.
        cost_micro_usd: results[0]?.cost_micro_usd ?? null
      };
    }
  );

  // ---- Dashboard: reads ---------------------------------------------------
  ctx.app.get("/api/ai-usage/summary", async (req) => {
    const q = z
      .object({ range: z.enum(["24h", "7d", "30d", "month"]).default("7d"), service: z.string().max(80).optional() })
      .parse(req.query ?? {});
    return usageSummary(ctx, q.range, q.service);
  });

  ctx.app.get("/api/ai-usage/events", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), service: z.string().max(80).optional() })
      .parse(req.query ?? {});
    return { events: recentEvents(ctx, q.limit, q.service) };
  });

  ctx.app.get("/api/ai-usage/apps", async () => ({ apps: listApps(ctx) }));

  ctx.app.get("/api/ai-usage/prices", async () => ({ models: modelPrices(ctx) }));

  // ---- Dashboard: changes ---------------------------------------------------
  ctx.app.post("/api/ai-usage/connect/:serviceId", async (req) => {
    const { serviceId } = z.object({ serviceId: z.string().min(1).max(80) }).parse(req.params);
    const result = connectService(ctx, serviceId);
    writeAuditLog(ctx, {
      actor: (req as { actor?: string }).actor ?? "dashboard",
      action: "ai-usage.connect",
      resourceType: "service",
      resourceId: serviceId,
      statusCode: 200
    });
    return { ok: true, ...result };
  });

  ctx.app.delete("/api/ai-usage/connect/:serviceId", async (req) => {
    const { serviceId } = z.object({ serviceId: z.string().min(1).max(80) }).parse(req.params);
    disconnectService(ctx, serviceId);
    writeAuditLog(ctx, {
      actor: (req as { actor?: string }).actor ?? "dashboard",
      action: "ai-usage.disconnect",
      resourceType: "service",
      resourceId: serviceId,
      statusCode: 200
    });
    return { ok: true, restart_required: true };
  });

  ctx.app.get("/api/ai-usage/budgets", async () => getBudgets(ctx));

  ctx.app.put("/api/ai-usage/budgets", async (req) => {
    setBudgets(ctx, budgetSchema.parse(req.body ?? {}));
    return getBudgets(ctx);
  });

  ctx.app.put("/api/ai-usage/prices", async (req) => {
    const body = z.object({ overrides: z.record(z.string().min(1).max(120), priceSchema) }).parse(req.body ?? {});
    setPriceOverrides(ctx, body.overrides);
    return { models: modelPrices(ctx) };
  });
}
