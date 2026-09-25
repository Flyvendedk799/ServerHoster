/**
 * License v1 unit tests — hash storage, validate seats, revoke, extend.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import { nanoid } from "nanoid";
import type { AppContext } from "./types.js";
import {
  createProduct,
  extendLicense,
  generateLicense,
  getLicenseOverview,
  injectLicenseServerUrl,
  listActivations,
  listLicenses,
  revokeLicense,
  validateLicense
} from "./services/license.js";
import { isApiPath } from "./routes/auth.js";

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  git_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE project_env_vars (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, key)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  resource_type TEXT NOT NULL, resource_id TEXT, status_code INTEGER NOT NULL,
  details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, service_id TEXT, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE license_products (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, max_activations INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, customer_email TEXT, customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, max_activations INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE license_activations (
  id TEXT PRIMARY KEY, license_id TEXT NOT NULL, device_fingerprint TEXT NOT NULL,
  device_name TEXT, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL,
  deactivated_at TEXT, UNIQUE(license_id, device_fingerprint)
);
CREATE TABLE license_audit (
  id TEXT PRIMARY KEY, license_id TEXT, action TEXT NOT NULL, detail TEXT,
  source_ip TEXT, created_at TEXT NOT NULL
);
`;

let ctx: AppContext;

function makeContext(): AppContext {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    db,
    config: { secretKey: "test-secret-key-32-bytes-not-for-prod", apiPort: 8787 },
    wsSubscribers: new Set(),
    app: { log: { info() {}, warn() {}, error() {}, child: () => ({}) } }
  } as unknown as AppContext;
}

beforeEach(() => {
  ctx = makeContext();
});

describe("license v1", () => {
  test("mints a key once and validates by hash", () => {
    const product = createProduct(ctx, { slug: "pro", name: "Pro", maxActivations: 2 });
    const { key, record } = generateLicense(ctx, {
      productId: product.id,
      customerEmail: "a@b.co"
    });
    assert.match(key, /^lsv1_pro_/);
    assert.equal(record.key_prefix.startsWith("lsv1_"), true);

    const row = ctx.db.prepare("SELECT key_hash FROM licenses WHERE id = ?").get(record.id) as {
      key_hash: string;
    };
    assert.notEqual(row.key_hash, key);
    assert.ok(!JSON.stringify(row).includes(key));

    const ok = validateLicense(ctx, { key, fingerprint: "device-1", deviceName: "Mac" });
    assert.equal(ok.valid, true);
    assert.equal(ok.product?.slug, "pro");
    assert.equal(ok.license?.activations.used, 1);
    assert.equal(ok.license?.activations.max, 2);

    const again = validateLicense(ctx, { key, fingerprint: "device-1" });
    assert.equal(again.valid, true);
    assert.equal(again.license?.activations.used, 1);
  });

  test("enforces seat limits and revoke", () => {
    const product = createProduct(ctx, { slug: "seat", name: "Seat", maxActivations: 1 });
    const { key, record } = generateLicense(ctx, { productId: product.id });

    assert.equal(validateLicense(ctx, { key, fingerprint: "a" }).valid, true);
    const limited = validateLicense(ctx, { key, fingerprint: "b" });
    assert.equal(limited.valid, false);
    assert.equal(limited.code, "seat_limit");

    revokeLicense(ctx, record.id);
    const revoked = validateLicense(ctx, { key, fingerprint: "a" });
    assert.equal(revoked.valid, false);
    assert.equal(revoked.code, "revoked");
  });

  test("extends expiry and lists activations", () => {
    const product = createProduct(ctx, { slug: "exp", name: "Exp" });
    const past = new Date(Date.now() - 60_000).toISOString();
    const { key, record } = generateLicense(ctx, {
      productId: product.id,
      expiresAt: past
    });
    assert.equal(validateLicense(ctx, { key, fingerprint: "x" }).code, "expired");

    const future = new Date(Date.now() + 86_400_000).toISOString();
    extendLicense(ctx, record.id, future);
    assert.equal(validateLicense(ctx, { key, fingerprint: "x" }).valid, true);
    assert.equal(listActivations(ctx).length, 1);
    assert.equal(listLicenses(ctx).length, 1);
  });

  test("overview + LICENSE_SERVER_URL inject", () => {
    createProduct(ctx, { slug: "o", name: "O" });
    const overview = getLicenseOverview(ctx);
    assert.equal(overview.products, 1);

    const projectId = nanoid();
    ctx.db
      .prepare(
        `INSERT INTO projects (id, name, description, git_url, created_at, updated_at)
         VALUES (?, 'Demo', '', '', datetime('now'), datetime('now'))`
      )
      .run(projectId);
    const injected = injectLicenseServerUrl(ctx, projectId);
    assert.equal(injected.key, "LICENSE_SERVER_URL");
    assert.match(injected.value, /8787$/);
  });
});

describe("auth API prefixes for n8n + license", () => {
  test("gates n8n and license admin namespaces", () => {
    assert.equal(isApiPath("/n8n"), true);
    assert.equal(isApiPath("/n8n/status"), true);
    assert.equal(isApiPath("/license"), true);
    assert.equal(isApiPath("/license/keys"), true);
    assert.equal(isApiPath("/license/v1/validate"), true);
  });
});
