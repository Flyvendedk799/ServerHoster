import type { AppContext } from "../types.js";
import { getExposure } from "../services/exposure.js";
import { provisionCertificate } from "../services/ssl.js";

export function registerExposureRoutes(ctx: AppContext): void {
  ctx.app.get("/services/:id/exposure", async (req) => {
    const { id } = req.params as { id: string };
    return getExposure(ctx, id);
  });

  /** Cert metadata for the service's currently-bound domain. */
  ctx.app.get("/services/:id/certificate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const svc = ctx.db.prepare("SELECT domain, ssl_status FROM services WHERE id = ?").get(id) as
      | { domain?: string; ssl_status?: string }
      | undefined;
    if (!svc?.domain) {
      reply.code(404);
      return { error: "Service has no domain" };
    }
    const cert = ctx.db
      .prepare("SELECT domain, expires_at, created_at FROM certificates WHERE domain = ?")
      .get(svc.domain) as { domain: string; expires_at: number; created_at: string } | undefined;
    if (!cert) {
      reply.code(404);
      return { error: "No certificate on file" };
    }
    return {
      domain: cert.domain,
      issuer: svc.ssl_status === "cloudflare" ? "cloudflare" : "letsencrypt",
      issued_at: cert.created_at,
      expires_at: new Date(cert.expires_at).toISOString(),
      days_remaining: Math.max(0, Math.floor((cert.expires_at - Date.now()) / 86400000))
    };
  });

  /** Force a renewal pass for this service's domain (manual trigger). */
  ctx.app.post("/services/:id/certificate/renew", async (req) => {
    const { id } = req.params as { id: string };
    const svc = ctx.db.prepare("SELECT domain, ssl_status FROM services WHERE id = ?").get(id) as
      | { domain?: string; ssl_status?: string }
      | undefined;
    if (!svc?.domain) throw new Error("Service has no domain bound");
    if (svc.ssl_status === "cloudflare") {
      throw new Error("Cloudflare-tunneled domains are TLS-terminated at the edge; nothing to renew here");
    }
    await provisionCertificate(ctx, id, svc.domain);
    return { ok: true };
  });
}
