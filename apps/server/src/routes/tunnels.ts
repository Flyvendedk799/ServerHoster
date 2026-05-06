import type { AppContext } from "../types.js";
import { listTunnelAdapters } from "../services/tunnels/index.js";

export function registerTunnelRoutes(ctx: AppContext): void {
  /**
   * List built-in tunnel adapters and which ones are usable on this host.
   * Used by the dashboard to populate the "expose via" dropdown.
   */
  ctx.app.get("/tunnels/adapters", async () => {
    const adapters = listTunnelAdapters();
    const out = await Promise.all(
      adapters.map(async (a) => ({
        id: a.id,
        label: a.label,
        available: await a.available(ctx)
      }))
    );
    return { adapters: out };
  });
}
