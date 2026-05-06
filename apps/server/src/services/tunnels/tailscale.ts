import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TunnelAdapter, TunnelLiveStatus, TunnelStartResult } from "./index.js";

/**
 * Tailscale Funnel adapter — exposes a local port on a *.ts.net hostname.
 *
 * Prerequisites: the `tailscale` binary is on PATH, the device is logged in
 * to a Tailnet, and Funnel is enabled for the user. We don't manage any of
 * that — this adapter just shells out to `tailscale funnel`.
 *
 * Public URL: derived from `tailscale status --json` (`Self.DNSName`).
 * Funnel routes are bound to specific local ports via `tailscale funnel
 * <port>`; the public URL maps to that port over HTTPS.
 */

type TailscaleRuntime = {
  child: ChildProcess;
  serviceId: string;
  publicUrl: string | null;
  port: number;
  startedAt: string;
  stopRequested: boolean;
};

const RUNTIMES = new Map<string, TailscaleRuntime>();

function spawnSyncSilent(cmd: string, args: string[]): string | null {
  try {
    const child = spawnSync(cmd, args, { encoding: "utf8" });
    if (child.status === 0 && typeof child.stdout === "string") return child.stdout;
    return null;
  } catch {
    return null;
  }
}

function which(bin: string): string | null {
  const out = spawnSyncSilent("which", [bin]) ?? spawnSyncSilent("where.exe", [bin]);
  return out && out.trim() ? out.trim().split(/\r?\n/)[0] : null;
}

function getTailnetHost(binary: string): string | null {
  const json = spawnSyncSilent(binary, ["status", "--json"]);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName;
    if (!dns) return null;
    return dns.replace(/\.$/, "");
  } catch {
    return null;
  }
}

export const tailscaleAdapter: TunnelAdapter = {
  id: "tailscale",
  label: "Tailscale Funnel (bring-your-own)",
  async available(_ctx) {
    const binary = which("tailscale");
    if (!binary) return false;
    return Boolean(getTailnetHost(binary));
  },
  async start(_ctx, serviceId, port): Promise<TunnelStartResult> {
    if (RUNTIMES.has(serviceId)) {
      const existing = RUNTIMES.get(serviceId)!;
      return { publicUrl: existing.publicUrl ?? "", details: { provider: "tailscale", reused: true } };
    }
    const binary = which("tailscale");
    if (!binary) {
      throw new Error(
        "tailscale binary not found. Install from https://tailscale.com/download and `tailscale up` first."
      );
    }
    const host = getTailnetHost(binary);
    if (!host) {
      throw new Error("Tailscale is not connected. Run `tailscale up` and try again.");
    }

    // `tailscale funnel <port>` blocks while Funnel is active. Killing the
    // process tears down the Funnel route automatically.
    const child = spawn(binary, ["funnel", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    const runtime: TailscaleRuntime = {
      child,
      serviceId,
      publicUrl: `https://${host}`,
      port,
      startedAt: new Date().toISOString(),
      stopRequested: false
    };
    RUNTIMES.set(serviceId, runtime);

    child.on("exit", () => RUNTIMES.delete(serviceId));

    return {
      publicUrl: runtime.publicUrl ?? "",
      details: { provider: "tailscale", host, port, pid: child.pid }
    };
  },
  async stop(_ctx, serviceId) {
    const runtime = RUNTIMES.get(serviceId);
    if (!runtime) return;
    runtime.stopRequested = true;
    try {
      runtime.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  },
  status(_ctx, serviceId): TunnelLiveStatus {
    const runtime = RUNTIMES.get(serviceId);
    if (!runtime) return { running: false };
    return {
      running: !runtime.child.killed,
      publicUrl: runtime.publicUrl ?? undefined,
      detail: runtime.publicUrl ? "running" : "starting"
    };
  }
};
