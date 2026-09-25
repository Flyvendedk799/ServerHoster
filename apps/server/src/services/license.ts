/**
 * License Server v1 — products, keys, activations, and public validation.
 *
 * Security model (mirrors AI Gateway consumer tokens):
 *   - Plaintext keys (`lsv1_…`) are shown once at mint time.
 *   - Only SHA-256 hashes are stored; lookup is by hash (no plaintext compare).
 *   - Public validate is rate-limited and auth-free; admin CRUD is session-gated.
 *   - Activations are bound to a client-supplied fingerprint with a max seat count.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { writeAuditLog } from "./audit.js";
import { createNotification } from "./notifications.js";
import { emitN8nEvent } from "./n8n.js";
import { getSetting, setSetting, getSecretSetting, setSecretSetting } from "./settings.js";

const KEY_PREFIX = "lsv1_";
const SETTING_PUBLIC_URL = "license_server_public_url";

export type LicenseProduct = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  max_activations: number;
  created_at: string;
  updated_at: string;
  license_count?: number;
};

export type LicenseKey = {
  id: string;
  product_id: string;
  product_slug?: string;
  product_name?: string;
  key_prefix: string;
  customer_email: string | null;
  customer_name: string | null;
  status: "active" | "revoked" | "expired";
  expires_at: string | null;
  max_activations: number | null;
  activation_count: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type LicenseActivation = {
  id: string;
  license_id: string;
  product_slug?: string;
  key_prefix?: string;
  device_fingerprint: string;
  device_name: string | null;
  last_seen_at: string;
  created_at: string;
  deactivated_at: string | null;
};

export type LicenseAuditEntry = {
  id: string;
  license_id: string | null;
  action: string;
  detail: string | null;
  source_ip: string | null;
  created_at: string;
};

export type LicenseOverview = {
  products: number;
  keys_active: number;
  keys_revoked: number;
  activations: number;
  validations_24h: number;
  public_url: string | null;
  validate_url: string | null;
};

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function recordLicenseAudit(
  ctx: AppContext,
  input: { licenseId?: string | null; action: string; detail?: string; sourceIp?: string | null }
): void {
  ctx.db
    .prepare(
      `INSERT INTO license_audit (id, license_id, action, detail, source_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(nanoid(), input.licenseId ?? null, input.action, input.detail ?? null, input.sourceIp ?? null, nowIso());
}

export function getLicensePublicUrl(ctx: AppContext): string | null {
  const raw = (getSetting(ctx, SETTING_PUBLIC_URL) ?? "").trim().replace(/\/+$/, "");
  return raw || null;
}

export function setLicensePublicUrl(ctx: AppContext, url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      throw httpError("Public URL must be an absolute http(s) URL", 400);
    }
    setSetting(ctx, SETTING_PUBLIC_URL, trimmed);
    return trimmed;
  }
  setSetting(ctx, SETTING_PUBLIC_URL, "");
  return null;
}

export function licenseValidateUrl(ctx: AppContext, requestHost?: string | null): string {
  const publicUrl = getLicensePublicUrl(ctx);
  if (publicUrl) return `${publicUrl.replace(/\/+$/, "")}/license/v1/validate`;
  if (requestHost) {
    const host = requestHost.replace(/\/+$/, "");
    const base = host.startsWith("http") ? host : `http://${host}`;
    return `${base}/license/v1/validate`;
  }
  return `http://127.0.0.1:${ctx.config.apiPort}/license/v1/validate`;
}

export function getLicenseOverview(ctx: AppContext, requestHost?: string | null): LicenseOverview {
  const products = (
    ctx.db.prepare("SELECT COUNT(*) AS c FROM license_products").get() as { c: number }
  ).c;
  const keys_active = (
    ctx.db
      .prepare("SELECT COUNT(*) AS c FROM licenses WHERE status = 'active'")
      .get() as { c: number }
  ).c;
  const keys_revoked = (
    ctx.db
      .prepare("SELECT COUNT(*) AS c FROM licenses WHERE status = 'revoked'")
      .get() as { c: number }
  ).c;
  const activations = (
    ctx.db
      .prepare("SELECT COUNT(*) AS c FROM license_activations WHERE deactivated_at IS NULL")
      .get() as { c: number }
  ).c;
  const validations_24h = (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM license_audit
         WHERE action = 'validate.ok' AND created_at >= datetime('now', '-1 day')`
      )
      .get() as { c: number }
  ).c;
  const public_url = getLicensePublicUrl(ctx);
  return {
    products,
    keys_active,
    keys_revoked,
    activations,
    validations_24h,
    public_url,
    validate_url: licenseValidateUrl(ctx, requestHost)
  };
}

/* ------------------------------------------------------------------------ */
/* Products                                                                   */
/* ------------------------------------------------------------------------ */

export function listProducts(ctx: AppContext): LicenseProduct[] {
  const rows = ctx.db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM licenses l WHERE l.product_id = p.id) AS license_count
       FROM license_products p
       ORDER BY p.created_at DESC`
    )
    .all() as LicenseProduct[];
  return rows;
}

export function createProduct(
  ctx: AppContext,
  input: { slug: string; name: string; description?: string; maxActivations?: number },
  actor = "system"
): LicenseProduct {
  const slug = input.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw httpError("Slug is required", 400);
  const existing = ctx.db.prepare("SELECT id FROM license_products WHERE slug = ?").get(slug);
  if (existing) throw httpError("A product with that slug already exists", 409);

  const id = nanoid();
  const now = nowIso();
  const max = Math.max(1, Math.min(input.maxActivations ?? 1, 10000));
  ctx.db
    .prepare(
      `INSERT INTO license_products (id, slug, name, description, max_activations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, slug, input.name.trim(), input.description?.trim() || null, max, now, now);

  writeAuditLog(ctx, {
    actor,
    action: "license.product.create",
    resourceType: "license_product",
    resourceId: id,
    statusCode: 201,
    details: `slug=${slug}`
  });
  return ctx.db.prepare("SELECT * FROM license_products WHERE id = ?").get(id) as LicenseProduct;
}

export function updateProduct(
  ctx: AppContext,
  id: string,
  patch: { name?: string; description?: string | null; maxActivations?: number },
  actor = "system"
): LicenseProduct {
  const row = ctx.db.prepare("SELECT * FROM license_products WHERE id = ?").get(id) as
    | LicenseProduct
    | undefined;
  if (!row) throw httpError("Product not found", 404);
  const name = patch.name?.trim() || row.name;
  const description =
    patch.description === undefined ? row.description : patch.description?.trim() || null;
  const max =
    patch.maxActivations === undefined
      ? row.max_activations
      : Math.max(1, Math.min(patch.maxActivations, 10000));
  ctx.db
    .prepare(
      `UPDATE license_products SET name = ?, description = ?, max_activations = ?, updated_at = ? WHERE id = ?`
    )
    .run(name, description, max, nowIso(), id);
  writeAuditLog(ctx, {
    actor,
    action: "license.product.update",
    resourceType: "license_product",
    resourceId: id,
    statusCode: 200
  });
  return ctx.db.prepare("SELECT * FROM license_products WHERE id = ?").get(id) as LicenseProduct;
}

export function deleteProduct(ctx: AppContext, id: string, actor = "system"): void {
  const row = ctx.db.prepare("SELECT id FROM license_products WHERE id = ?").get(id);
  if (!row) throw httpError("Product not found", 404);
  const keys = (
    ctx.db.prepare("SELECT COUNT(*) AS c FROM licenses WHERE product_id = ?").get(id) as { c: number }
  ).c;
  if (keys > 0) throw httpError("Revoke/delete all keys for this product first", 409);
  ctx.db.prepare("DELETE FROM license_products WHERE id = ?").run(id);
  writeAuditLog(ctx, {
    actor,
    action: "license.product.delete",
    resourceType: "license_product",
    resourceId: id,
    statusCode: 200
  });
}

/* ------------------------------------------------------------------------ */
/* Keys                                                                       */
/* ------------------------------------------------------------------------ */

function licenseView(row: Record<string, unknown>): LicenseKey {
  const status = String(row.status) as LicenseKey["status"];
  let effective = status;
  if (status === "active" && row.expires_at && String(row.expires_at) < nowIso()) {
    effective = "expired";
  }
  return {
    id: String(row.id),
    product_id: String(row.product_id),
    product_slug: row.product_slug ? String(row.product_slug) : undefined,
    product_name: row.product_name ? String(row.product_name) : undefined,
    key_prefix: String(row.key_prefix),
    customer_email: (row.customer_email as string | null) ?? null,
    customer_name: (row.customer_name as string | null) ?? null,
    status: effective,
    expires_at: (row.expires_at as string | null) ?? null,
    max_activations: (row.max_activations as number | null) ?? null,
    activation_count: Number(row.activation_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    revoked_at: (row.revoked_at as string | null) ?? null
  };
}

export function listLicenses(ctx: AppContext, productId?: string): LicenseKey[] {
  const sql = productId
    ? `SELECT l.*, p.slug AS product_slug, p.name AS product_name,
         (SELECT COUNT(*) FROM license_activations a
           WHERE a.license_id = l.id AND a.deactivated_at IS NULL) AS activation_count
       FROM licenses l
       JOIN license_products p ON p.id = l.product_id
       WHERE l.product_id = ?
       ORDER BY l.created_at DESC`
    : `SELECT l.*, p.slug AS product_slug, p.name AS product_name,
         (SELECT COUNT(*) FROM license_activations a
           WHERE a.license_id = l.id AND a.deactivated_at IS NULL) AS activation_count
       FROM licenses l
       JOIN license_products p ON p.id = l.product_id
       ORDER BY l.created_at DESC`;
  const rows = (
    productId ? ctx.db.prepare(sql).all(productId) : ctx.db.prepare(sql).all()
  ) as Record<string, unknown>[];
  return rows.map(licenseView);
}

export function generateLicense(
  ctx: AppContext,
  input: {
    productId: string;
    customerEmail?: string;
    customerName?: string;
    expiresAt?: string | null;
    maxActivations?: number | null;
  },
  actor = "system"
): { key: string; record: LicenseKey } {
  const product = ctx.db.prepare("SELECT * FROM license_products WHERE id = ?").get(input.productId) as
    | LicenseProduct
    | undefined;
  if (!product) throw httpError("Product not found", 404);

  const token = `${KEY_PREFIX}${product.slug}_${crypto.randomBytes(24).toString("base64url")}`;
  const id = nanoid();
  const now = nowIso();
  const expiresAt = input.expiresAt?.trim() || null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw httpError("expiresAt must be an ISO timestamp", 400);
  }

  ctx.db
    .prepare(
      `INSERT INTO licenses
        (id, product_id, key_hash, key_prefix, customer_email, customer_name, status,
         expires_at, max_activations, metadata_json, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, '{}', ?, ?, NULL)`
    )
    .run(
      id,
      product.id,
      hashKey(token),
      token.slice(0, KEY_PREFIX.length + Math.min(product.slug.length, 12) + 4),
      input.customerEmail?.trim() || null,
      input.customerName?.trim() || null,
      expiresAt,
      input.maxActivations ?? null,
      now,
      now
    );

  writeAuditLog(ctx, {
    actor,
    action: "license.key.generate",
    resourceType: "license",
    resourceId: id,
    statusCode: 201,
    details: `product=${product.slug}`
  });
  recordLicenseAudit(ctx, {
    licenseId: id,
    action: "key.generate",
    detail: `product=${product.slug}`
  });

  createNotification(ctx, {
    kind: "system",
    severity: "success",
    title: `License issued for ${product.name}`,
    body: input.customerEmail
      ? `Key minted for ${input.customerEmail}`
      : `Key ${token.slice(0, 14)}… minted`
  });

  void emitN8nEvent(ctx, "license.issued", {
    licenseId: id,
    productId: product.id,
    productSlug: product.slug,
    customerEmail: input.customerEmail ?? null
  });

  const record = listLicenses(ctx).find((l) => l.id === id)!;
  return { key: token, record };
}

export function revokeLicense(ctx: AppContext, id: string, actor = "system"): LicenseKey {
  const row = ctx.db.prepare("SELECT * FROM licenses WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw httpError("License not found", 404);
  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE licenses SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(now, now, id);
  writeAuditLog(ctx, {
    actor,
    action: "license.key.revoke",
    resourceType: "license",
    resourceId: id,
    statusCode: 200
  });
  recordLicenseAudit(ctx, { licenseId: id, action: "key.revoke" });
  createNotification(ctx, {
    kind: "system",
    severity: "warning",
    title: "License revoked",
    body: `Key ${String(row.key_prefix)}… revoked`
  });
  void emitN8nEvent(ctx, "license.revoked", { licenseId: id });
  return listLicenses(ctx).find((l) => l.id === id)!;
}

export function extendLicense(
  ctx: AppContext,
  id: string,
  expiresAt: string | null,
  actor = "system"
): LicenseKey {
  const row = ctx.db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  if (!row) throw httpError("License not found", 404);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw httpError("expiresAt must be an ISO timestamp", 400);
  }
  const now = nowIso();
  // Re-activate if previously only expired (not revoked).
  const current = row as { status: string; revoked_at: string | null };
  const nextStatus = current.revoked_at ? "revoked" : "active";
  ctx.db
    .prepare(`UPDATE licenses SET expires_at = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(expiresAt, nextStatus, now, id);
  writeAuditLog(ctx, {
    actor,
    action: "license.key.extend",
    resourceType: "license",
    resourceId: id,
    statusCode: 200,
    details: `expiresAt=${expiresAt ?? "never"}`
  });
  recordLicenseAudit(ctx, {
    licenseId: id,
    action: "key.extend",
    detail: `expiresAt=${expiresAt ?? "never"}`
  });
  void emitN8nEvent(ctx, "license.extended", { licenseId: id, expiresAt });
  return listLicenses(ctx).find((l) => l.id === id)!;
}

/* ------------------------------------------------------------------------ */
/* Activations                                                                */
/* ------------------------------------------------------------------------ */

export function listActivations(ctx: AppContext, licenseId?: string): LicenseActivation[] {
  const sql = licenseId
    ? `SELECT a.*, p.slug AS product_slug, l.key_prefix
       FROM license_activations a
       JOIN licenses l ON l.id = a.license_id
       JOIN license_products p ON p.id = l.product_id
       WHERE a.license_id = ?
       ORDER BY a.created_at DESC`
    : `SELECT a.*, p.slug AS product_slug, l.key_prefix
       FROM license_activations a
       JOIN licenses l ON l.id = a.license_id
       JOIN license_products p ON p.id = l.product_id
       ORDER BY a.created_at DESC
       LIMIT 500`;
  return (
    licenseId ? ctx.db.prepare(sql).all(licenseId) : ctx.db.prepare(sql).all()
  ) as LicenseActivation[];
}

export function deactivateActivation(ctx: AppContext, id: string, actor = "system"): void {
  const row = ctx.db.prepare("SELECT * FROM license_activations WHERE id = ?").get(id) as
    | LicenseActivation
    | undefined;
  if (!row) throw httpError("Activation not found", 404);
  if (!row.deactivated_at) {
    ctx.db
      .prepare(`UPDATE license_activations SET deactivated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }
  writeAuditLog(ctx, {
    actor,
    action: "license.activation.deactivate",
    resourceType: "license_activation",
    resourceId: id,
    statusCode: 200
  });
  recordLicenseAudit(ctx, {
    licenseId: row.license_id,
    action: "activation.deactivate",
    detail: `fingerprint=${row.device_fingerprint}`
  });
}

export function listLicenseAudit(ctx: AppContext, limit = 100): LicenseAuditEntry[] {
  return ctx.db
    .prepare(`SELECT * FROM license_audit ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as LicenseAuditEntry[];
}

/* ------------------------------------------------------------------------ */
/* Public validate                                                            */
/* ------------------------------------------------------------------------ */

export type ValidateResult = {
  valid: boolean;
  code?: string;
  message?: string;
  product?: { slug: string; name: string };
  license?: {
    id: string;
    status: string;
    expires_at: string | null;
    activations: { used: number; max: number };
  };
};

export function validateLicense(
  ctx: AppContext,
  input: { key: string; fingerprint: string; deviceName?: string },
  sourceIp?: string | null
): ValidateResult {
  const key = input.key?.trim() ?? "";
  const fingerprint = input.fingerprint?.trim() ?? "";
  if (!key || !fingerprint) {
    recordLicenseAudit(ctx, {
      action: "validate.bad_request",
      detail: "missing key or fingerprint",
      sourceIp
    });
    return { valid: false, code: "bad_request", message: "key and fingerprint are required" };
  }
  if (!key.startsWith(KEY_PREFIX)) {
    recordLicenseAudit(ctx, { action: "validate.invalid_key", sourceIp });
    return { valid: false, code: "invalid_key", message: "Unrecognized license key" };
  }

  const row = ctx.db
    .prepare(
      `SELECT l.*, p.slug AS product_slug, p.name AS product_name, p.max_activations AS product_max
       FROM licenses l
       JOIN license_products p ON p.id = l.product_id
       WHERE l.key_hash = ?`
    )
    .get(hashKey(key)) as
    | (Record<string, unknown> & {
        id: string;
        status: string;
        expires_at: string | null;
        max_activations: number | null;
        product_slug: string;
        product_name: string;
        product_max: number;
        revoked_at: string | null;
      })
    | undefined;

  if (!row) {
    recordLicenseAudit(ctx, { action: "validate.invalid_key", sourceIp });
    return { valid: false, code: "invalid_key", message: "Unrecognized license key" };
  }

  if (row.status === "revoked" || row.revoked_at) {
    recordLicenseAudit(ctx, {
      licenseId: row.id,
      action: "validate.revoked",
      sourceIp
    });
    return { valid: false, code: "revoked", message: "License has been revoked" };
  }

  if (row.expires_at && row.expires_at < nowIso()) {
    // Lazily flip status for admin views.
    ctx.db
      .prepare(`UPDATE licenses SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(nowIso(), row.id);
    recordLicenseAudit(ctx, {
      licenseId: row.id,
      action: "validate.expired",
      sourceIp
    });
    return { valid: false, code: "expired", message: "License has expired" };
  }

  const maxSeats = row.max_activations ?? row.product_max;
  const existing = ctx.db
    .prepare(
      `SELECT * FROM license_activations
       WHERE license_id = ? AND device_fingerprint = ? AND deactivated_at IS NULL`
    )
    .get(row.id, fingerprint) as LicenseActivation | undefined;

  const now = nowIso();
  let isNewActivation = false;
  if (existing) {
    ctx.db
      .prepare(`UPDATE license_activations SET last_seen_at = ?, device_name = COALESCE(?, device_name) WHERE id = ?`)
      .run(now, input.deviceName?.trim() || null, existing.id);
  } else {
    const used = (
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS c FROM license_activations
           WHERE license_id = ? AND deactivated_at IS NULL`
        )
        .get(row.id) as { c: number }
    ).c;
    if (used >= maxSeats) {
      recordLicenseAudit(ctx, {
        licenseId: row.id,
        action: "validate.seat_limit",
        detail: `used=${used} max=${maxSeats}`,
        sourceIp
      });
      return {
        valid: false,
        code: "seat_limit",
        message: `Activation limit reached (${maxSeats})`,
        product: { slug: row.product_slug, name: row.product_name },
        license: {
          id: row.id,
          status: "active",
          expires_at: row.expires_at,
          activations: { used, max: maxSeats }
        }
      };
    }
    ctx.db
      .prepare(
        `INSERT INTO license_activations
          (id, license_id, device_fingerprint, device_name, last_seen_at, created_at, deactivated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(nanoid(), row.id, fingerprint, input.deviceName?.trim() || null, now, now);
    isNewActivation = true;
    void emitN8nEvent(ctx, "license.activation", {
      licenseId: row.id,
      fingerprint,
      deviceName: input.deviceName ?? null
    });
  }

  const used = (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM license_activations
         WHERE license_id = ? AND deactivated_at IS NULL`
      )
      .get(row.id) as { c: number }
  ).c;

  recordLicenseAudit(ctx, {
    licenseId: row.id,
    action: "validate.ok",
    detail: isNewActivation ? "new_activation" : "renew",
    sourceIp
  });
  void emitN8nEvent(ctx, "license.validated", {
    licenseId: row.id,
    fingerprint,
    newActivation: isNewActivation
  });

  return {
    valid: true,
    product: { slug: row.product_slug, name: row.product_name },
    license: {
      id: row.id,
      status: "active",
      expires_at: row.expires_at,
      activations: { used, max: maxSeats }
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Email key send (uses shared SMTP settings)                                 */
/* ------------------------------------------------------------------------ */

export async function emailLicenseKey(
  ctx: AppContext,
  input: { licenseId: string; to?: string; key?: string },
  actor = "system"
): Promise<{ ok: boolean; message: string }> {
  const row = ctx.db
    .prepare(
      `SELECT l.*, p.name AS product_name
       FROM licenses l JOIN license_products p ON p.id = l.product_id
       WHERE l.id = ?`
    )
    .get(input.licenseId) as
    | (Record<string, unknown> & {
        customer_email: string | null;
        key_prefix: string;
        product_name: string;
      })
    | undefined;
  if (!row) throw httpError("License not found", 404);

  const to = (input.to || row.customer_email || "").trim();
  if (!to) throw httpError("No recipient email — pass `to` or set customer email on the key", 400);
  if (!input.key) {
    throw httpError(
      "Plaintext key is only available at mint time. Re-send immediately after generate, or pass the key.",
      400
    );
  }

  const host = getSetting(ctx, "smtp_host");
  const port = getSetting(ctx, "smtp_port") ?? "465";
  const user = getSetting(ctx, "smtp_user") ?? "api_token";
  const pass = getSecretSetting(ctx, "smtp_password");
  const from = getSetting(ctx, "smtp_from");
  const fromName = getSetting(ctx, "smtp_from_name") ?? "";
  if (!host || !pass || !from) {
    throw httpError("Configure SMTP under Email settings first", 400);
  }

  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const validateUrl = licenseValidateUrl(ctx);
  const message = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: Your ${row.product_name} license key`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Here is your license key for ${row.product_name}:`,
    ``,
    input.key,
    ``,
    `Validation endpoint: ${validateUrl}`,
    ``,
    `Keep this key private. It will not be shown again in the dashboard.`,
    ``
  ].join("\r\n");

  const { writeFile, unlink } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const run = promisify(execFile);

  const cfgPath = path.join(tmpdir(), `survhub-license-mail-${nanoid()}.conf`);
  const msgPath = path.join(tmpdir(), `survhub-license-mail-${nanoid()}.eml`);
  try {
    await writeFile(
      cfgPath,
      [`url = "smtps://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}"`, `mail-from = "${from}"`].join(
        "\n"
      ),
      { mode: 0o600 }
    );
    await writeFile(msgPath, message, { mode: 0o600 });
    await run("curl", ["--silent", "--show-error", "--config", cfgPath, "--mail-rcpt", to, "--upload-file", msgPath], {
      timeout: 30000
    });
  } catch (err) {
    throw httpError(`Failed to send email: ${(err as Error).message}`, 502);
  } finally {
    await unlink(cfgPath).catch(() => undefined);
    await unlink(msgPath).catch(() => undefined);
  }

  writeAuditLog(ctx, {
    actor,
    action: "license.key.email",
    resourceType: "license",
    resourceId: input.licenseId,
    statusCode: 200,
    details: `to=${to}`
  });
  recordLicenseAudit(ctx, {
    licenseId: input.licenseId,
    action: "key.email",
    detail: `to=${to}`
  });

  return { ok: true, message: `License key emailed to ${to}` };
}

/** Helper for Secrets tab: inject LICENSE_SERVER_URL into a project's shared env. */
export function injectLicenseServerUrl(
  ctx: AppContext,
  projectId: string,
  actor = "system"
): { key: string; value: string } {
  const project = ctx.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) throw httpError("Project not found", 404);
  const value = licenseValidateUrl(ctx).replace(/\/license\/v1\/validate$/, "");
  const existing = ctx.db
    .prepare("SELECT id FROM project_env_vars WHERE project_id = ? AND key = 'LICENSE_SERVER_URL'")
    .get(projectId) as { id?: string } | undefined;
  if (existing?.id) {
    ctx.db
      .prepare(`UPDATE project_env_vars SET value = ?, is_secret = 0 WHERE id = ?`)
      .run(value, existing.id);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO project_env_vars (id, project_id, key, value, is_secret)
         VALUES (?, ?, 'LICENSE_SERVER_URL', ?, 0)
         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, is_secret = 0`
      )
      .run(nanoid(), projectId, value);
  }
  writeAuditLog(ctx, {
    actor,
    action: "license.inject_server_url",
    resourceType: "project",
    resourceId: projectId,
    statusCode: 200,
    details: value
  });
  return { key: "LICENSE_SERVER_URL", value };
}
