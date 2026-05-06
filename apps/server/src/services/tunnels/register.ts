import { registerTunnelAdapter } from "./index.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { ngrokAdapter } from "./ngrok.js";
import { tailscaleAdapter } from "./tailscale.js";

let registered = false;

/**
 * Register all built-in tunnel adapters once. Order is preferential:
 * cloudflare first (default + auto-installable), then bring-your-own.
 */
export function registerBuiltinTunnelAdapters(): void {
  if (registered) return;
  registered = true;
  registerTunnelAdapter(cloudflareAdapter);
  registerTunnelAdapter(ngrokAdapter);
  registerTunnelAdapter(tailscaleAdapter);
}
