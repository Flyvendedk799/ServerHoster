import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { activeChallenges } from "../services/ssl.js";
import { recordInboundRequest } from "../services/requestInspector.js";

const proxySchema = z.object({
  serviceId: z.string(),
  domain: z.string().min(1),
  targetPort: z.number().int()
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
    const route = ctx.db
      .prepare("SELECT service_id, target_port FROM proxy_routes WHERE domain = ?")
      .get(host) as { service_id?: string; target_port?: number } | undefined;
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
        path: (req.raw.url ?? "/").split("?")[0],
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
    const existingDomain = ctx.db.prepare("SELECT id FROM proxy_routes WHERE domain = ?").get(domain);
    if (existingDomain) {
      throw new Error(`Proxy domain already exists: ${domain}`);
    }
    const existingPort = ctx.db
      .prepare("SELECT id, domain FROM proxy_routes WHERE target_port = ?")
      .get(p.targetPort) as { id: string; domain: string } | undefined;
    if (existingPort) {
      throw new Error(`Target port already mapped by ${existingPort.domain}`);
    }
    const row = {
      id: nanoid(),
      service_id: p.serviceId,
      domain,
      target_port: p.targetPort,
      created_at: nowIso()
    };
    ctx.db
      .prepare(
        "INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(row.id, row.service_id, row.domain, row.target_port, row.created_at);
    return row;
  });

  ctx.app.delete("/proxy/routes/:id", async (req) => {
    const { id } = req.params as { id: string };
    ctx.db.prepare("DELETE FROM proxy_routes WHERE id = ?").run(id);
    return { ok: true };
  });

  ctx.app.all("/proxy/*", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const route = ctx.db.prepare("SELECT target_port FROM proxy_routes WHERE domain = ?").get(host) as
      | { target_port?: number }
      | undefined;
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
