import { z } from "zod";
import type { AppContext } from "../types.js";
import { getLatestMetrics, getServiceSparkline, snapshotDeployKpis } from "../services/metrics.js";
import { listNotifications, markAllRead, markRead, unreadCount } from "../services/notifications.js";
import { collectSystemHealth } from "../services/health.js";
import { setSetting } from "../services/settings.js";
import { isPrometheusEnabled, renderPrometheusText } from "../services/prometheus.js";

export function registerObservabilityRoutes(ctx: AppContext): void {
  ctx.app.get("/metrics/services", async () => getLatestMetrics(ctx));

  ctx.app.get("/metrics/services/:id", async (req) => {
    const { id } = req.params as { id: string };
    const minutes = Number((req.query as { minutes?: string }).minutes ?? 60);
    return getServiceSparkline(ctx, id, Math.min(Math.max(minutes, 1), 24 * 60));
  });

  ctx.app.get("/notifications", async (req) => {
    const q = req.query as { unreadOnly?: string; limit?: string };
    return {
      items: listNotifications(ctx, {
        unreadOnly: q.unreadOnly === "true",
        limit: Number(q.limit ?? 100)
      }),
      unread: unreadCount(ctx)
    };
  });

  ctx.app.post("/notifications/:id/read", async (req) => {
    const { id } = req.params as { id: string };
    markRead(ctx, id);
    return { ok: true };
  });

  ctx.app.post("/notifications/read-all", async () => ({ ok: true, changed: markAllRead(ctx) }));

  ctx.app.put("/notifications/webhook", async (req) => {
    const p = z
      .object({
        url: z.string().url(),
        kind: z.enum(["discord", "slack"]).default("discord")
      })
      .parse(req.body);
    setSetting(ctx, "notification_webhook_url", p.url);
    setSetting(ctx, "notification_webhook_kind", p.kind);
    return { ok: true };
  });

  ctx.app.get("/health/system", async () => collectSystemHealth(ctx));

  // Prometheus scrape endpoint. Off by default (set `prometheus.enabled` to
  // "1" via the settings API or LOCALSURV_PROMETHEUS=1). Returns 404 when
  // disabled so external scrapers don't accidentally light up dashboards.
  ctx.app.get("/metrics/prometheus", async (_req, reply) => {
    if (!isPrometheusEnabled(ctx)) {
      reply.code(404).send({ error: "Prometheus endpoint disabled" });
      return;
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderPrometheusText(ctx);
  });

  /**
   * Sequence 4 — deploy KPIs (totals, failures-by-stage, p50/p95). Always
   * available; cheap (in-process counters). Pair with /metrics/prometheus
   * for scraped exposure.
   */
  ctx.app.get("/metrics/deploys", async () => snapshotDeployKpis());

  /**
   * Sequence 4 — log query endpoint with filters. Replaces the previous
   * unstructured "tail of all logs" approach with something the dashboard
   * can paginate and grep over. Filter on serviceId, deploymentId
   * (matched as a substring inside `message`), level, time range, and a
   * free-text search term.
   */
  const logQuerySchema = z.object({
    serviceId: z.string().optional(),
    deploymentId: z.string().optional(),
    level: z.enum(["info", "warn", "error"]).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(2000).default(500)
  });

  ctx.app.get("/logs/query", async (req) => {
    const q = logQuerySchema.parse({
      ...(req.query as Record<string, unknown>),
      limit: Number((req.query as { limit?: string }).limit ?? 500)
    });
    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (q.serviceId) {
      wheres.push("service_id = ?");
      params.push(q.serviceId);
    }
    if (q.level) {
      wheres.push("level = ?");
      params.push(q.level);
    }
    if (q.since) {
      wheres.push("timestamp >= ?");
      params.push(q.since);
    }
    if (q.until) {
      wheres.push("timestamp <= ?");
      params.push(q.until);
    }
    if (q.search) {
      wheres.push("message LIKE ?");
      params.push(`%${q.search}%`);
    }
    if (q.deploymentId) {
      // Build logs identify their deployment by substring inclusion in
      // the message body. This is intentionally loose so messages emitted
      // by the runtime layer (which doesn't carry deploymentId) can still
      // be grouped when the operator pastes a deployment id in.
      wheres.push("message LIKE ?");
      params.push(`%${q.deploymentId}%`);
    }
    const sql = `SELECT id, service_id, level, message, timestamp FROM logs ${wheres.length ? "WHERE " + wheres.join(" AND ") : ""} ORDER BY timestamp DESC LIMIT ?`;
    params.push(q.limit);
    const rows = ctx.db.prepare(sql).all(...params) as Array<{
      id: string;
      service_id: string;
      level: string;
      message: string;
      timestamp: string;
    }>;
    return { items: rows, count: rows.length, query: q };
  });
}
