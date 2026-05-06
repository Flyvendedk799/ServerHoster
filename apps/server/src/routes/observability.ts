import { z } from "zod";
import type { AppContext } from "../types.js";
import { getLatestMetrics, getServiceSparkline } from "../services/metrics.js";
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
}
