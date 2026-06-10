import { nanoid } from "nanoid";
import { nowIso } from "../../lib/core.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../security.js";
import type { AppContext } from "../../types.js";

/**
 * Encrypted resource secrets (Database-Tracker Phase 1).
 *
 * `resource_secrets.value` is ALWAYS stored AES-256-GCM encrypted with
 * ctx.config.secretKey (same path as env_vars / agent secrets). Only
 * `getResourceSecret` ever decrypts; everything list-shaped returns a masked
 * `value_preview` so full values never leak into API responses or logs.
 */

type ResourceSecretRow = {
  id: string;
  resource_id: string;
  key: string;
  value: string;
  is_generated: number;
  created_at: string;
  updated_at: string;
};

export type ResourceSecretPreview = {
  key: string;
  is_generated: boolean;
  value_preview: string;
  created_at: string;
  updated_at: string;
};

/** Upsert a secret for a resource; the stored value is always encrypted. */
export function setResourceSecret(
  ctx: AppContext,
  resourceId: string,
  key: string,
  value: string,
  isGenerated = false
): void {
  const encrypted = encryptSecret(value, ctx.config.secretKey);
  const now = nowIso();
  const existing = ctx.db
    .prepare("SELECT id FROM resource_secrets WHERE resource_id = ? AND key = ?")
    .get(resourceId, key) as { id: string } | undefined;
  if (existing) {
    ctx.db
      .prepare("UPDATE resource_secrets SET value = ?, is_generated = ?, updated_at = ? WHERE id = ?")
      .run(encrypted, isGenerated ? 1 : 0, now, existing.id);
    return;
  }
  ctx.db
    .prepare(
      `INSERT INTO resource_secrets (id, resource_id, key, value, is_generated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nanoid(), resourceId, key, encrypted, isGenerated ? 1 : 0, now, now);
}

/** Decrypted secret value, or null when the key isn't set. */
export function getResourceSecret(ctx: AppContext, resourceId: string, key: string): string | null {
  const row = ctx.db
    .prepare("SELECT value FROM resource_secrets WHERE resource_id = ? AND key = ?")
    .get(resourceId, key) as { value: string } | undefined;
  if (!row) return null;
  return decryptSecret(row.value, ctx.config.secretKey);
}

/** Preview-only listing — never returns decrypted values. */
export function listResourceSecrets(ctx: AppContext, resourceId: string): ResourceSecretPreview[] {
  const rows = ctx.db
    .prepare("SELECT * FROM resource_secrets WHERE resource_id = ? ORDER BY key")
    .all(resourceId) as ResourceSecretRow[];
  return rows.map((row) => ({
    key: row.key,
    is_generated: Boolean(row.is_generated),
    value_preview: maskSecret(decryptSecret(row.value, ctx.config.secretKey)),
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

export function deleteResourceSecret(ctx: AppContext, resourceId: string, key: string): void {
  ctx.db.prepare("DELETE FROM resource_secrets WHERE resource_id = ? AND key = ?").run(resourceId, key);
}
