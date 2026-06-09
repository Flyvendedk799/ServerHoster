const WS_URL = import.meta.env.VITE_SURVHUB_WS_URL ?? "ws://localhost:8787/ws";
const TOKEN_KEY = "survhub_token";

/** Live-connection state, for driving an honest streaming indicator. */
export type LiveStatus = "connecting" | "open" | "closed";

/**
 * A resilient live connection. Unlike a bare WebSocket it reconnects with
 * backoff after any drop, queues sends issued while the socket is down (flushed
 * on the next open), and exposes `onReopen` so consumers can re-subscribe
 * (e.g. re-attach a terminal) after a reconnect. `close()` stops reconnecting.
 * `onStatus` reports the real connection state so a "streaming"/"live" dot can
 * tell the truth instead of being hardcoded on.
 */
export type LiveSocket = {
  send: (data: string) => void;
  close: () => void;
  /** Fired on every (re)open. Use to re-send subscription/attach messages. */
  onReopen: (cb: () => void) => void;
  /** Fired whenever the connection state changes (and immediately with the current state). */
  onStatus: (cb: (status: LiveStatus) => void) => void;
};

export function connectLogs(onMessage: (payload: unknown) => void): LiveSocket {
  let ws: WebSocket | null = null;
  let attempts = 0;
  let closedByCaller = false;
  let status: LiveStatus = "connecting";
  const outbox: string[] = [];
  const reopenCbs: Array<() => void> = [];
  const statusCbs: Array<(s: LiveStatus) => void> = [];

  const setStatus = (next: LiveStatus): void => {
    if (next === status) return;
    status = next;
    for (const cb of statusCbs) cb(status);
  };

  const open = (): void => {
    setStatus("connecting");
    const token = localStorage.getItem(TOKEN_KEY) ?? "";
    const sock = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      attempts = 0;
      setStatus("open");
      while (outbox.length) sock.send(outbox.shift()!);
      for (const cb of reopenCbs) cb();
    };
    sock.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        onMessage(event.data);
      }
    };
    sock.onclose = () => {
      if (closedByCaller) {
        setStatus("closed");
        return;
      }
      setStatus("connecting");
      const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
      setTimeout(open, delay);
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* triggers onclose → reconnect */
      }
    };
  };
  open();

  return {
    send: (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
      else if (outbox.length < 200) outbox.push(data);
    },
    close: () => {
      closedByCaller = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    onReopen: (cb) => {
      reopenCbs.push(cb);
    },
    onStatus: (cb) => {
      statusCbs.push(cb);
      cb(status);
    }
  };
}
