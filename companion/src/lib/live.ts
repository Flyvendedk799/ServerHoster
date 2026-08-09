import type { PairedServer } from "./vault";

/**
 * The live event stream from a paired machine.
 *
 * Same socket the desktop dashboard uses, with the same reconnect discipline —
 * but a phone drops its connection constantly (screen off, tunnel handoff,
 * train), so reconnection is the normal case here rather than the exception.
 * The backoff is capped low (10s) because a user staring at a stalled log view
 * will not wait 30 seconds for a retry.
 */

export type LiveEvent =
  | { type: "log"; serviceId: string; level: string; message: string; timestamp: string }
  | { type: "service_status"; serviceId: string; status: string; lastExitCode: number | null }
  | { type: "service_lifecycle"; serviceId: string; stage: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type LiveStatus = "connecting" | "open" | "closed";

export type LiveConnection = {
  close: () => void;
};

function socketUrl(server: PairedServer): string {
  const base = server.url.replace(/^http/i, "ws");
  return `${base}/ws?token=${encodeURIComponent(server.token)}`;
}

export function connectLive(
  server: PairedServer,
  handlers: { onEvent: (event: LiveEvent) => void; onStatus?: (status: LiveStatus) => void }
): LiveConnection {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let closedByCaller = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (closedByCaller) return;
    handlers.onStatus?.("connecting");
    let next: WebSocket;
    try {
      next = new WebSocket(socketUrl(server));
    } catch {
      scheduleRetry();
      return;
    }
    socket = next;

    next.onopen = () => {
      attempts = 0;
      handlers.onStatus?.("open");
    };
    next.onmessage = (event) => {
      try {
        handlers.onEvent(JSON.parse(String(event.data)) as LiveEvent);
      } catch {
        /* the control plane also sends a plain welcome string */
      }
    };
    next.onclose = () => {
      if (closedByCaller) {
        handlers.onStatus?.("closed");
        return;
      }
      scheduleRetry();
    };
    next.onerror = () => {
      try {
        next.close();
      } catch {
        /* onclose drives the retry */
      }
    };
  };

  const scheduleRetry = (): void => {
    handlers.onStatus?.("connecting");
    const delay = Math.min(10_000, 750 * 2 ** attempts);
    attempts += 1;
    retryTimer = setTimeout(open, delay);
  };

  open();

  return {
    close: () => {
      closedByCaller = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
    }
  };
}
