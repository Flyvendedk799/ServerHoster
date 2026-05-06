import type { AppContext } from "../../types.js";
import type { TunnelAdapter, TunnelLiveStatus, TunnelStartResult } from "./index.js";
import {
  detectCloudflared,
  startQuickTunnel,
  stopQuickTunnel,
  getQuickTunnelStatus,
  ensureCloudflared
} from "../cloudflare.js";

/**
 * Adapter wrapper around the existing Cloudflare quick-tunnel plumbing.
 * Named tunnels and DNS / ingress management stay on the dedicated CF
 * routes — this adapter is the "one-click public URL" entry point that all
 * adapters share.
 */
export const cloudflareAdapter: TunnelAdapter = {
  id: "cloudflare",
  label: "Cloudflare Tunnel (default)",
  async available(_ctx) {
    const detected = detectCloudflared(_ctx);
    return Boolean(detected.binary);
  },
  async start(ctx, serviceId, port): Promise<TunnelStartResult> {
    await ensureCloudflared(ctx);
    startQuickTunnel(ctx, serviceId, port);
    // Quick-tunnel URL is discovered from cloudflared's stdout asynchronously.
    // Surface whatever is currently known; the caller polls `status()` for
    // the URL once cloudflared has logged it.
    const s = getQuickTunnelStatus(serviceId);
    return {
      publicUrl: s.tunnelUrl ?? "",
      details: { provider: "cloudflare-quick-tunnel", running: s.running, pid: s.pid }
    };
  },
  async stop(ctx, serviceId) {
    stopQuickTunnel(ctx, serviceId);
  },
  status(_ctx, serviceId): TunnelLiveStatus {
    const s = getQuickTunnelStatus(serviceId);
    return {
      running: s.running,
      publicUrl: s.tunnelUrl ?? undefined,
      detail: s.running ? "running" : "stopped"
    };
  }
};
