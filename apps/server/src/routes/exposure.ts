import type { AppContext } from "../types.js";
import { z } from "zod";
import { getExposure } from "../services/exposure.js";
import { provisionCertificate } from "../services/ssl.js";
import { diagnoseDomain, issueOwnershipToken, verifyOwnership } from "../services/domainValidation.js";

export function registerExposureRoutes(ctx: AppContext): void {
  ctx.app.get("/services/:id/exposure", async (req) => {
    const { id } = req.params as { id: string };
    return getExposure(ctx, id);
  });

  /**
   * Sequence 3 — domain diagnostics. Lightweight DNS check the dashboard
   * can run before binding a domain; saves a Let's Encrypt rate-limit burn
   * when DNS is mis-configured.
   */
  ctx.app.post("/exposure/domains/diagnose", async (req) => {
    const body = z
      .object({
        domain: z.string().min(1),
        expectedAddresses: z.array(z.string()).optional()
      })
      .parse(req.body);
    return diagnoseDomain(body.domain, body.expectedAddresses ?? []);
  });

  ctx.app.post("/exposure/domains/ownership/issue", async (req) => {
    const body = z.object({ domain: z.string().min(1) }).parse(req.body);
    return issueOwnershipToken(ctx, body.domain);
  });

  ctx.app.post("/exposure/domains/ownership/verify", async (req) => {
    const body = z.object({ domain: z.string().min(1) }).parse(req.body);
    return verifyOwnership(ctx, body.domain);
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
