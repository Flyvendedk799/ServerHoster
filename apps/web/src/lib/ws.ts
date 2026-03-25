const WS_URL = import.meta.env.VITE_SURVHUB_WS_URL ?? "ws://localhost:8787/ws";
const TOKEN_KEY = "survhub_token";

export function connectLogs(onMessage: (payload: unknown) => void): WebSocket {
  const token = localStorage.getItem(TOKEN_KEY) ?? "";
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      onMessage(event.data);
    }
  };
  return ws;
}
