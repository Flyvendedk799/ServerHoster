import type { AppContext } from "../../types.js";

/**
 * Pluggable tunnel-adapter contract. The default adapter is Cloudflare
 * Tunnel (already implemented in `services/cloudflare.ts`); this module lets
 * users plug in alternative providers (ngrok, Tailscale Funnel) by name.
 *
 * Adapters intentionally keep state-of-the-art behaviour minimal: start a
 * tunnel for a single service:port, return a public URL, stop it on demand.
 * Anything richer (named tunnels, persistent ingress, edge SSL) is left to
 * the provider-specific routes.
 */

export type TunnelStartResult = {
  publicUrl: string;
  details?: Record<string, unknown>;
};

export type TunnelLiveStatus = {
  running: boolean;
  publicUrl?: string;
  detail?: string;
};

export interface TunnelAdapter {
  /** Stable identifier used in DB / API ("cloudflare", "ngrok", "tailscale"). */
  readonly id: string;
  /** Human-readable label for UI dropdowns. */
  readonly label: string;
  /** Quick check that the adapter's prerequisites are present on this host. */
  available(ctx: AppContext): Promise<boolean>;
  /** Start a one-off tunnel pointing at `port` on localhost for `serviceId`. */
  start(ctx: AppContext, serviceId: string, port: number): Promise<TunnelStartResult>;
  /** Stop the running tunnel for `serviceId`. Idempotent. */
  stop(ctx: AppContext, serviceId: string): Promise<void>;
  /** Return current status for the given service. */
  status(ctx: AppContext, serviceId: string): TunnelLiveStatus;
}

const REGISTRY = new Map<string, TunnelAdapter>();

export function registerTunnelAdapter(adapter: TunnelAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

export function getTunnelAdapter(id: string): TunnelAdapter | undefined {
  return REGISTRY.get(id);
}

export function listTunnelAdapters(): TunnelAdapter[] {
  return Array.from(REGISTRY.values());
}

export async function selectAvailableTunnelAdapter(
  ctx: AppContext,
  preferred?: string
): Promise<TunnelAdapter | undefined> {
  if (preferred) {
    const explicit = REGISTRY.get(preferred);
    if (explicit && (await explicit.available(ctx))) return explicit;
  }
  for (const adapter of REGISTRY.values()) {
    if (await adapter.available(ctx)) return adapter;
  }
  return undefined;
}
