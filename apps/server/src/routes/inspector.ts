import type { AppContext } from "../types.js";
import { listRequests, clearRequests } from "../services/requestInspector.js";

export function registerInspectorRoutes(ctx: AppContext): void {
  /**
   * Recent inbound HTTP requests for a service (ngrok-style traffic log).
   * Newest first; capped at 200 entries per service.
   */
  ctx.app.get("/services/:id/requests", async (req) => {
    const { id } = req.params as { id: string };
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return { items: listRequests(id, limit) };
  });

  ctx.app.delete("/services/:id/requests", async (req) => {
    const { id } = req.params as { id: string };
    clearRequests(id);
    return { ok: true };
  });
}
