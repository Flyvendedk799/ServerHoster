import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import httpProxy from "http-proxy";
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

// Domain-based reverse proxy on port 80 (configurable via SURVHUB_PROXY_PORT).
// Quick tunnels bypass this entirely; it's only needed for named-tunnel domain routing.
const domainProxy = httpProxy.createProxyServer({});
const port80 = http.createServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  const route = ctx.db
    .prepare("SELECT target_port FROM proxy_routes WHERE domain = ?")
    .get(host) as { target_port?: number } | undefined;
  if (!route?.target_port) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No service mapped to this domain\n");
    return;
  }
  domainProxy.web(req, res, { target: `http://127.0.0.1:${route.target_port}` }, (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(String((err as Error).message));
  });
});
try {
  await new Promise<void>((resolve, reject) => {
    port80.once("error", reject);
    port80.listen(ctx.config.proxyPort, "0.0.0.0", resolve);
  });
  ctx.app.log.info(`Domain proxy listening on port ${ctx.config.proxyPort}`);
} catch (err: unknown) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES") {
    ctx.app.log.warn(`Domain proxy: cannot bind port ${ctx.config.proxyPort} (EACCES). Set SURVHUB_PROXY_PORT to a port > 1024 or run with elevated privileges.`);
  } else {
    ctx.app.log.warn(`Domain proxy failed to start: ${(err as Error).message}`);
  }
}
ctx.shutdownTasks.push(() => new Promise<void>((res) => port80.close(() => res())));

process.on("SIGINT", () => { void gracefulShutdown(ctx); });
process.on("SIGTERM", () => { void gracefulShutdown(ctx); });

wss.on("close", () => {
  ctx.wsSubscribers.clear();
});

ctx.app.log.info(`SURVHub running at ${server}`);
