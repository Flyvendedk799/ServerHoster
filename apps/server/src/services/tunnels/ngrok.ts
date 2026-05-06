import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TunnelAdapter, TunnelLiveStatus, TunnelStartResult } from "./index.js";

/**
 * ngrok adapter — wraps the local `ngrok` binary as a managed child process.
 *
 * Discovery: looks for `ngrok` on PATH. We deliberately don't bundle it
 * (license + size). User installs ngrok separately and authenticates with
 * `ngrok config add-authtoken <token>`.
 *
 * Public URL detection: parses the URL out of ngrok's stdout (it logs lines
 * containing `url=https://...ngrok-free.app` on startup). The local API on
 * 127.0.0.1:4040 also exposes tunnel state but we keep this dependency-free.
 */

type NgrokRuntime = {
  child: ChildProcess;
  serviceId: string;
  publicUrl: string | null;
  startedAt: string;
  stopRequested: boolean;
};

const RUNTIMES = new Map<string, NgrokRuntime>();
const NGROK_URL_RE = /url=(https?:\/\/[^\s]+)/i;

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
  const result = spawnSyncSilent("which", [bin]) ?? spawnSyncSilent("where.exe", [bin]);
  return result && result.trim() ? result.trim().split(/\r?\n/)[0] : null;
}

export const ngrokAdapter: TunnelAdapter = {
  id: "ngrok",
  label: "ngrok (bring-your-own)",
  async available(_ctx) {
    return Boolean(which("ngrok"));
  },
  async start(_ctx, serviceId, port): Promise<TunnelStartResult> {
    if (RUNTIMES.has(serviceId)) {
      const existing = RUNTIMES.get(serviceId)!;
      return { publicUrl: existing.publicUrl ?? "", details: { provider: "ngrok", reused: true } };
    }
    const binary = which("ngrok");
    if (!binary) {
      throw new Error(
        "ngrok binary not found on PATH. Install from https://ngrok.com/download and authenticate with `ngrok config add-authtoken <token>`."
      );
    }
    const child = spawn(binary, ["http", "--log=stdout", String(port)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const runtime: NgrokRuntime = {
      child,
      serviceId,
      publicUrl: null,
      startedAt: new Date().toISOString(),
      stopRequested: false
    };
    RUNTIMES.set(serviceId, runtime);

    const onData = (data: Buffer): void => {
      const chunk = data.toString();
      for (const line of chunk.split("\n")) {
        if (!line.trim() || runtime.publicUrl) continue;
        const match = NGROK_URL_RE.exec(line);
        if (match) runtime.publicUrl = match[1];
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => RUNTIMES.delete(serviceId));

    return { publicUrl: runtime.publicUrl ?? "", details: { provider: "ngrok", pid: child.pid } };
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
