import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso, matchProxyRoute, normalizeRoutePrefix } from "../lib/core.js";
import { activeChallenges } from "../services/ssl.js";
import { recordInboundRequest } from "../services/requestInspector.js";
import { publicResourceRouteForRequest } from "../services/resources/publicExposure.js";

const proxySchema = z.object({
  serviceId: z.string(),
  domain: z.string().min(1),
  targetPort: z.number().int(),
  /** Path prefix this route claims, e.g. "/v1". Defaults to "/" (whole domain),
   *  which is the pre-path-routing behaviour. */
  pathPrefix: z.string().optional()
});

export function registerProxyRoutes(ctx: AppContext): void {
  // Host-based reverse proxy: intercept any request whose Host header matches
  // a registered proxy_route, and forward it to the target port. Runs before
  // route matching so bare domain requests (not just /proxy/*) are routed.
  ctx.app.addHook("onRequest", async (req, reply) => {
    const url = req.raw.url ?? "";
    // Let ACME challenges and the explicit /proxy/* admin routes fall through.
    if (url.startsWith("/.well-known/acme-challenge/")) return;
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    if (!host) return;
    const requestPath = url.split("?")[0] || "/";
    const publicResourceRoute = publicResourceRouteForRequest(ctx, host, requestPath);
    const route = publicResourceRoute
      ? { service_id: publicResourceRoute.serviceId, target_port: publicResourceRoute.targetPort }
      : (matchProxyRoute(
          ctx.db
            .prepare("SELECT service_id, target_port, path_prefix FROM proxy_routes WHERE domain = ?")
            .all(host) as Array<{
            service_id?: string;
            target_port?: number;
            path_prefix?: string | null;
          }>,
          requestPath
        ) ?? undefined);
    if (!route?.target_port) return;
    reply.hijack();

    // Capture inbound request metadata once the upstream finishes responding.
    const requestId = nanoid(8);
    const startedAt = Date.now();
    const finalize = (status: number | null): void => {
      if (!route.service_id) return;
      recordInboundRequest({
        requestId,
        serviceId: route.service_id,
        timestamp: new Date(startedAt).toISOString(),
        method: req.method ?? "GET",
        path: requestPath,
        status,
        latencyMs: Date.now() - startedAt,
        remoteAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
        host
      });
    };
    reply.raw.on("finish", () => finalize(reply.raw.statusCode ?? null));
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) finalize(null);
    });

    const target = `http://127.0.0.1:${route.target_port}`;
    let attempted = 0;
    const tryProxy = (): void => {
      ctx.proxy.web(req.raw, reply.raw, { target }, (error: NodeJS.ErrnoException) => {
        // One retry with 250ms backoff on ECONNREFUSED — covers the
        // "service is mid-restart" race that otherwise drops every request
        // until the next health-check tick.
        if (error.code === "ECONNREFUSED" && attempted === 0 && !reply.raw.headersSent) {
          attempted = 1;
          setTimeout(tryProxy, 250);
          return;
        }
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "application/json" });
        }
        reply.raw.end(JSON.stringify({ error: `proxy_error: ${error.message}` }));
      });
    };
    tryProxy();
  });

  // ACME challenge handler - high priority
  ctx.app.get("/.well-known/acme-challenge/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const response = activeChallenges.get(token);
    if (response) {
      return reply.send(response);
    }
    return reply.code(404).send({ error: "Challenge not found" });
  });

  ctx.app.get("/proxy/routes", async () =>
    ctx.db.prepare("SELECT * FROM proxy_routes ORDER BY created_at DESC").all()
  );

  ctx.app.post("/proxy/routes", async (req) => {
    const p = proxySchema.parse(req.body);
    const domain = p.domain.toLowerCase();
    const pathPrefix = normalizeRoutePrefix(p.pathPrefix);
    // Uniqueness is (domain, path_prefix): one domain may fan out to several
    // services by path, e.g. "/" -> web and "/v1" -> api.
    const existingRoute = ctx.db
      .prepare("SELECT id FROM proxy_routes WHERE domain = ? AND path_prefix = ?")
      .get(domain, pathPrefix);
    if (existingRoute) {
      throw new Error(`Proxy route already exists: ${domain}${pathPrefix === "/" ? "" : pathPrefix}`);
    }
    // A port may back several prefixes on the SAME domain, but reusing it under
    // a different domain is still a misconfiguration.
    const existingPort = ctx.db
      .prepare("SELECT id, domain FROM proxy_routes WHERE target_port = ? AND domain != ?")
      .get(p.targetPort, domain) as { id: string; domain: string } | undefined;
    if (existingPort) {
      throw new Error(`Target port already mapped by ${existingPort.domain}`);
    }
    const row = {
      id: nanoid(),
      service_id: p.serviceId,
      domain,
      target_port: p.targetPort,
      path_prefix: pathPrefix,
      created_at: nowIso()
    };
    ctx.db
      .prepare(
        "INSERT INTO proxy_routes (id, service_id, domain, target_port, path_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(row.id, row.service_id, row.domain, row.target_port, row.path_prefix, row.created_at);
    return row;
  });

  ctx.app.delete("/proxy/routes/:id", async (req) => {
    const { id } = req.params as { id: string };
    ctx.db.prepare("DELETE FROM proxy_routes WHERE id = ?").run(id);
    return { ok: true };
  });

  ctx.app.all("/proxy/*", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const route = matchProxyRoute(
      ctx.db
        .prepare("SELECT target_port, path_prefix FROM proxy_routes WHERE domain = ?")
        .all(host) as Array<{ target_port?: number; path_prefix?: string | null }>,
      (req.raw.url ?? "/").split("?")[0] || "/"
    );
    if (!route?.target_port) return reply.code(404).send({ error: "No proxy route for host" });

    await new Promise<void>((resolve, reject) => {
      ctx.proxy.web(req.raw, reply.raw, { target: `http://127.0.0.1:${route.target_port}` }, (error) =>
        reject(error)
      );
      reply.hijack();
      resolve();
    });
  });
}
