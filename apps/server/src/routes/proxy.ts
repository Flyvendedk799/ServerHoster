import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

const proxySchema = z.object({ serviceId: z.string(), domain: z.string().min(1), targetPort: z.number().int() });

export function registerProxyRoutes(ctx: AppContext): void {
  ctx.app.get("/proxy/routes", async () => ctx.db.prepare("SELECT * FROM proxy_routes ORDER BY created_at DESC").all());

  ctx.app.post("/proxy/routes", async (req) => {
    const p = proxySchema.parse(req.body);
    const domain = p.domain.toLowerCase();
    const existingDomain = ctx.db.prepare("SELECT id FROM proxy_routes WHERE domain = ?").get(domain);
    if (existingDomain) {
      throw new Error(`Proxy domain already exists: ${domain}`);
    }
    const existingPort = ctx.db.prepare("SELECT id, domain FROM proxy_routes WHERE target_port = ?").get(p.targetPort) as
      | { id: string; domain: string }
      | undefined;
    if (existingPort) {
      throw new Error(`Target port already mapped by ${existingPort.domain}`);
    }
    const row = { id: nanoid(), service_id: p.serviceId, domain, target_port: p.targetPort, created_at: nowIso() };
    ctx.db.prepare("INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)")
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
    const route = ctx.db.prepare("SELECT target_port FROM proxy_routes WHERE domain = ?").get(host) as { target_port?: number } | undefined;
    if (!route?.target_port) return reply.code(404).send({ error: "No proxy route for host" });

    await new Promise<void>((resolve, reject) => {
      ctx.proxy.web(req.raw, reply.raw, { target: `http://127.0.0.1:${route.target_port}` }, (error) => reject(error));
      reply.hijack();
      resolve();
    });
  });
}
