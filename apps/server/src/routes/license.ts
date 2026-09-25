import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  createProduct,
  deactivateActivation,
  deleteProduct,
  emailLicenseKey,
  extendLicense,
  generateLicense,
  getLicenseOverview,
  getLicensePublicUrl,
  injectLicenseServerUrl,
  licenseValidateUrl,
  listActivations,
  listLicenseAudit,
  listLicenses,
  listProducts,
  revokeLicense,
  setLicensePublicUrl,
  updateProduct,
  validateLicense
} from "../services/license.js";

function actorOf(req: { actor?: string }): string {
  return req.actor ?? "unknown";
}

const productCreateSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  maxActivations: z.number().int().min(1).max(10000).optional()
});

const productUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  maxActivations: z.number().int().min(1).max(10000).optional()
});

const generateSchema = z.object({
  productId: z.string().min(1),
  customerEmail: z.string().email().optional().or(z.literal("")),
  customerName: z.string().max(120).optional(),
  expiresAt: z.string().max(64).nullable().optional().or(z.literal("")),
  maxActivations: z.number().int().min(1).max(10000).nullable().optional()
});

const extendSchema = z.object({
  expiresAt: z.string().max(64).nullable()
});

const validateSchema = z.object({
  key: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(256),
  deviceName: z.string().max(120).optional()
});

const emailSchema = z.object({
  to: z.string().email().optional(),
  key: z.string().min(1).optional()
});

const publicUrlSchema = z.object({
  url: z.string().max(500)
});

const injectSchema = z.object({
  projectId: z.string().min(1)
});

export function registerLicenseRoutes(ctx: AppContext): void {
  /* Public validate — auth skipped in routes/auth.ts; rate-limited here. */
  ctx.app.post(
    "/license/v1/validate",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (req) => {
      const body = validateSchema.parse(req.body ?? {});
      return validateLicense(ctx, body, req.ip ?? null);
    }
  );

  /* Admin dashboard API */
  ctx.app.get("/license/overview", async (req) => {
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
    return getLicenseOverview(ctx, host ?? null);
  });

  ctx.app.get("/license/public-url", async () => ({
    url: getLicensePublicUrl(ctx),
    validate_url: licenseValidateUrl(ctx)
  }));

  ctx.app.post("/license/public-url", async (req) => {
    const { url } = publicUrlSchema.parse(req.body ?? {});
    const next = setLicensePublicUrl(ctx, url);
    return { url: next, validate_url: licenseValidateUrl(ctx) };
  });

  ctx.app.get("/license/products", async () => ({ items: listProducts(ctx) }));

  ctx.app.post("/license/products", async (req, reply) => {
    const body = productCreateSchema.parse(req.body ?? {});
    const product = createProduct(ctx, body, actorOf(req as { actor?: string }));
    reply.code(201);
    return product;
  });

  ctx.app.patch("/license/products/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = productUpdateSchema.parse(req.body ?? {});
    return updateProduct(ctx, id, body, actorOf(req as { actor?: string }));
  });

  ctx.app.delete("/license/products/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteProduct(ctx, id, actorOf(req as { actor?: string }));
    return { ok: true };
  });

  ctx.app.get("/license/keys", async (req) => {
    const q = req.query as { productId?: string };
    return { items: listLicenses(ctx, q.productId) };
  });

  ctx.app.post("/license/keys", async (req, reply) => {
    const body = generateSchema.parse(req.body ?? {});
    const result = generateLicense(
      ctx,
      {
        productId: body.productId,
        customerEmail: body.customerEmail || undefined,
        customerName: body.customerName,
        expiresAt: body.expiresAt === "" ? null : body.expiresAt ?? null,
        maxActivations: body.maxActivations ?? null
      },
      actorOf(req as { actor?: string })
    );
    reply.code(201);
    return {
      ok: true,
      key: result.key,
      record: result.record,
      warning: "Copy this key now — it is shown once and stored only as a hash."
    };
  });

  ctx.app.post("/license/keys/:id/revoke", async (req) => {
    const { id } = req.params as { id: string };
    return revokeLicense(ctx, id, actorOf(req as { actor?: string }));
  });

  ctx.app.post("/license/keys/:id/extend", async (req) => {
    const { id } = req.params as { id: string };
    const body = extendSchema.parse(req.body ?? {});
    return extendLicense(ctx, id, body.expiresAt, actorOf(req as { actor?: string }));
  });

  ctx.app.post("/license/keys/:id/email", async (req) => {
    const { id } = req.params as { id: string };
    const body = emailSchema.parse(req.body ?? {});
    return emailLicenseKey(
      ctx,
      { licenseId: id, to: body.to, key: body.key },
      actorOf(req as { actor?: string })
    );
  });

  ctx.app.get("/license/activations", async (req) => {
    const q = req.query as { licenseId?: string };
    return { items: listActivations(ctx, q.licenseId) };
  });

  ctx.app.post("/license/activations/:id/deactivate", async (req) => {
    const { id } = req.params as { id: string };
    deactivateActivation(ctx, id, actorOf(req as { actor?: string }));
    return { ok: true };
  });

  ctx.app.get("/license/audit", async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 100;
    return { items: listLicenseAudit(ctx, Number.isFinite(limit) ? limit : 100) };
  });

  ctx.app.post("/license/inject-server-url", async (req) => {
    const body = injectSchema.parse(req.body ?? {});
    return injectLicenseServerUrl(ctx, body.projectId, actorOf(req as { actor?: string }));
  });

  /* Client integration helper payload */
  ctx.app.get("/license/client-integration", async (req) => {
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
    const validateUrl = licenseValidateUrl(ctx, host ?? null);
    return {
      validate_url: validateUrl,
      public_url: getLicensePublicUrl(ctx),
      example: {
        curl: `curl -sS -X POST '${validateUrl}' -H 'Content-Type: application/json' -d '{"key":"lsv1_…","fingerprint":"device-id","deviceName":"My App"}'`,
        env: `LICENSE_SERVER_URL=${validateUrl.replace(/\/license\/v1\/validate$/, "")}`
      }
    };
  });
}
