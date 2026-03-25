import { WebSocketServer, type WebSocket } from "ws";
import { buildApp } from "./app.js";
import { isAuthorizedToken } from "./services/auth.js";
import { gracefulShutdown } from "./services/runtime.js";

const ctx = await buildApp();
const server = await ctx.app.listen({ port: ctx.config.apiPort, host: ctx.config.host });

const wss = new WebSocketServer({ server: ctx.app.server, path: ctx.config.webSocketPath });
wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";
  if (!isAuthorizedToken(ctx, token)) {
    ws.close(1008, "Unauthorized");
    return;
  }
  ctx.wsSubscribers.add(ws);
  ws.send(JSON.stringify({ type: "welcome", message: "Connected to SURVHub logs stream" }));
  ws.on("close", () => ctx.wsSubscribers.delete(ws));
});

process.on("SIGINT", () => { void gracefulShutdown(ctx); });
process.on("SIGTERM", () => { void gracefulShutdown(ctx); });

wss.on("close", () => {
  ctx.wsSubscribers.clear();
});

ctx.app.log.info(`SURVHub running at ${server}`);
