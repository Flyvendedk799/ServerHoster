import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import httpProxy from "http-proxy";
import { buildApp } from "./app.js";
import { isAuthorizedToken } from "./services/auth.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  cleanupTerminalSocket,
  handleTerminalWebSocketMessage,
  stopAllTerminalSessions
} from "./services/terminals.js";
import { publicResourceRouteForRequest } from "./services/resources/publicExposure.js";
import { matchProxyRoute } from "./lib/core.js";

const ctx = await buildApp();
const server = await ctx.app.listen({ port: ctx.config.apiPort, host: ctx.config.host });

// Restart previously-running local Supabase stacks + their function serve
// processes (both die with us). Lives in the entrypoint — NOT buildApp — so
// test apps never spin up real stacks. Fire-and-forget: `supabase start` can
// take minutes when images need pulling and must not block API readiness.
void import("./services/resources/profiles/supabase.js")
  .then(({ reconcileSupabaseResourcesOnBoot }) => reconcileSupabaseResourcesOnBoot(ctx))
  .catch((err) => {
    ctx.app.log.error({ err }, "reconcileSupabaseResourcesOnBoot failed");
  });

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

  // Per-client set of transferIds this socket has subscribed to. We track here
  // so the on-close cleanup can prune the global ctx.transferSubscribers map.
  const attachedTransfers = new Set<string>();
  const attachedTerminals = new Set<string>();

  ws.on("message", (raw) => {
    let msg: { type?: string; transferId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (handleTerminalWebSocketMessage(ctx, ws, msg as Record<string, unknown>, attachedTerminals)) return;
    if (!msg || typeof msg.type !== "string" || typeof msg.transferId !== "string") return;
    const transferId = msg.transferId;
    if (msg.type === "attach_transfer") {
      attachedTransfers.add(transferId);
      const set = ctx.transferSubscribers.get(transferId) ?? new Set<WebSocket>();
      set.add(ws);
      ctx.transferSubscribers.set(transferId, set);
    } else if (msg.type === "detach_transfer") {
      attachedTransfers.delete(transferId);
      const set = ctx.transferSubscribers.get(transferId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) ctx.transferSubscribers.delete(transferId);
      }
    }
  });

  ws.on("close", () => {
    ctx.wsSubscribers.delete(ws);
    cleanupTerminalSocket(ctx, ws, attachedTerminals);
    for (const transferId of attachedTransfers) {
      const set = ctx.transferSubscribers.get(transferId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) ctx.transferSubscribers.delete(transferId);
      }
    }
  });
});

// Domain-based reverse proxy on port 80 (configurable via SURVHUB_PROXY_PORT).
// Quick tunnels bypass this entirely; it's only needed for named-tunnel domain routing.
const domainProxy = httpProxy.createProxyServer({});

const hostOf = (raw: string | undefined): string => (raw ?? "").split(":")[0].toLowerCase();
const pathOf = (raw: string | undefined): string => (raw ?? "/").split("?")[0] || "/";

/**
 * Resolve the upstream port for a request, in precedence order: public resource
 * routes, then the operator's own proxy_routes (longest path prefix wins), then
 * SaaS tenant custom hostnames.
 *
 * Shared by the HTTP handler and the WebSocket upgrade handler below so both
 * route identically — a split-brain there would send a socket somewhere its
 * own HTTP requests never went.
 */
function resolveProxyTargetPort(host: string, requestPath: string): number | null {
  const publicResourceRoute = publicResourceRouteForRequest(ctx, host, requestPath);
  if (publicResourceRoute?.targetPort) return publicResourceRoute.targetPort;

  // Several routes may share a domain (e.g. "/" -> web, "/v1" -> api); the
  // longest matching prefix wins.
  const domainRoutes = ctx.db
    .prepare("SELECT target_port, path_prefix FROM proxy_routes WHERE domain = ?")
    .all(host) as Array<{ target_port?: number; path_prefix?: string | null }>;
  const matched = matchProxyRoute(domainRoutes, requestPath);
  if (matched?.target_port) return matched.target_port;

  // SaaS tenant custom hostnames route to their owning service's port
  // (or an explicit per-route target port).
  const saasRoute = ctx.db
    .prepare(
      "SELECT COALESCE(sd.target_port, s.port) AS target_port FROM saas_domains sd JOIN services s ON s.id = sd.service_id WHERE sd.hostname = ?"
    )
    .get(host) as { target_port?: number } | undefined;
  return saasRoute?.target_port ?? null;
}

const port80 = http.createServer((req, res) => {
  const targetPort = resolveProxyTargetPort(hostOf(req.headers.host), pathOf(req.url));
  if (!targetPort) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No service mapped to this domain\n");
    return;
  }
  domainProxy.web(req, res, { target: `http://127.0.0.1:${targetPort}` }, (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(String((err as Error).message));
  });
});

// WebSocket upgrades need proxying explicitly — http-proxy's .web() does not
// handle them. Without this, any app behind a domain that uses WebSockets (live
// collaboration, dev HMR, log streams) fails to connect with no clear cause,
// even though its ordinary HTTP requests route fine.
port80.on("upgrade", (req, socket, head) => {
  // An upgrade socket has no HTTP response to fall back on: an unhandled error
  // here would take down the proxy process, so failures just close the socket.
  socket.on("error", () => socket.destroy());
  const targetPort = resolveProxyTargetPort(hostOf(req.headers.host), pathOf(req.url));
  if (!targetPort) {
    socket.destroy();
    return;
  }
  domainProxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort}` }, () =>
    socket.destroy()
  );
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
    ctx.app.log.warn(
      `Domain proxy: cannot bind port ${ctx.config.proxyPort} (EACCES). Set SURVHUB_PROXY_PORT to a port > 1024 or run with elevated privileges.`
    );
  } else {
    ctx.app.log.warn(`Domain proxy failed to start: ${(err as Error).message}`);
  }
}
ctx.shutdownTasks.push(() => new Promise<void>((res) => port80.close(() => res())));

process.on("SIGINT", () => {
  void gracefulShutdown(ctx);
});
process.on("SIGTERM", () => {
  void gracefulShutdown(ctx);
});

wss.on("close", () => {
  ctx.wsSubscribers.clear();
  stopAllTerminalSessions(ctx);
});

ctx.app.log.info(`SURVHub running at ${server}`);
