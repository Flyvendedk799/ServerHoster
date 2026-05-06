import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { deleteDnsRecord, removeTunnelIngress } from "./cloudflare.js";

/**
 * Best-effort retry queue for asynchronous Cloudflare cleanups (DNS records,
 * tunnel ingress) that failed during a service delete or domain change. The
 * SSL renewal loop drains it daily.
 *
 * Sequence 2 hardening:
 *   - `enqueueCleanup` is idempotent for the same `(kind, payload)` pair so
 *     a flaky retry loop can't blow the table up with duplicates.
 *   - When an entry exceeds `MAX_ATTEMPTS`, it is moved to the
 *     `cleanup_dead_letter` table with the failure reason intact instead of
 *     being silently dropped, so operators can inspect the failure mode and
 *     re-drive it manually.
 */

export type CleanupKind = "delete_dns" | "remove_ingress";

export type CleanupRow = {
  id: string;
  kind: CleanupKind;
  payload: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export const MAX_ATTEMPTS = 10;

export function enqueueCleanup(ctx: AppContext, kind: CleanupKind, payload: Record<string, unknown>): void {
  const serialised = JSON.stringify(payload);
  // Idempotent on (kind, payload). SQLite has no JSON normalisation, so we
  // rely on JSON.stringify producing stable output for the small payloads
  // we use here ({domain: "..."}).
  const existing = ctx.db
    .prepare("SELECT id FROM cleanup_queue WHERE kind = ? AND payload = ?")
    .get(kind, serialised) as { id: string } | undefined;
  if (existing) return;
  ctx.db
    .prepare(
      "INSERT INTO cleanup_queue (id, kind, payload, attempts, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
    )
    .run(nanoid(), kind, serialised, nowIso(), nowIso());
}

function moveToDeadLetter(ctx: AppContext, row: CleanupRow): void {
  // Only move when the dead-letter table actually exists (older deployments
  // running pre-migration just drop, matching previous behaviour).
  try {
    ctx.db
      .prepare(
        "INSERT INTO cleanup_dead_letter (id, original_id, kind, payload, attempts, last_error, moved_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(nanoid(), row.id, row.kind, row.payload, row.attempts + 1, row.last_error ?? "", nowIso());
  } catch {
    /* table missing: legacy DB without the migration */
  }
  ctx.db.prepare("DELETE FROM cleanup_queue WHERE id = ?").run(row.id);
}

export async function drainCleanupQueue(ctx: AppContext): Promise<{
  done: number;
  remaining: number;
  dead_letter: number;
}> {
  const rows = ctx.db.prepare("SELECT * FROM cleanup_queue ORDER BY created_at ASC").all() as CleanupRow[];
  let done = 0;
  let dead_letter = 0;
  for (const row of rows) {
    let payload: { domain?: string };
    try {
      payload = JSON.parse(row.payload) as { domain?: string };
    } catch {
      ctx.db.prepare("DELETE FROM cleanup_queue WHERE id = ?").run(row.id);
      continue;
    }
    if (!payload.domain) {
      ctx.db.prepare("DELETE FROM cleanup_queue WHERE id = ?").run(row.id);
      continue;
    }
    try {
      if (row.kind === "delete_dns") await deleteDnsRecord(ctx, payload.domain);
      else if (row.kind === "remove_ingress") await removeTunnelIngress(ctx, payload.domain);
      ctx.db.prepare("DELETE FROM cleanup_queue WHERE id = ?").run(row.id);
      done++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.db
        .prepare(
          "UPDATE cleanup_queue SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?"
        )
        .run(message.slice(0, 500), nowIso(), row.id);
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        moveToDeadLetter(ctx, { ...row, attempts: row.attempts + 1, last_error: message.slice(0, 500) });
        dead_letter++;
      }
    }
  }
  const remaining = (ctx.db.prepare("SELECT COUNT(*) as count FROM cleanup_queue").get() as { count: number })
    .count;
  return { done, remaining, dead_letter };
}

/**
 * Operator-facing helper: inspect or re-enqueue dead-letter entries.
 * Returning the rows lets the existing /ops route surface them without
 * having to read SQLite columns directly from the route layer.
 */
export function listDeadLetter(
  ctx: AppContext,
  limit = 100
): Array<{
  id: string;
  original_id: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  moved_at: string;
}> {
  try {
    return ctx.db
      .prepare(
        "SELECT id, original_id, kind, payload, attempts, last_error, moved_at FROM cleanup_dead_letter ORDER BY moved_at DESC LIMIT ?"
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<{
      id: string;
      original_id: string;
      kind: string;
      payload: string;
      attempts: number;
      last_error: string | null;
      moved_at: string;
    }>;
  } catch {
    return [];
  }
}

export function reEnqueueDeadLetter(ctx: AppContext, id: string): boolean {
  const row = ctx.db.prepare("SELECT kind, payload FROM cleanup_dead_letter WHERE id = ?").get(id) as
    | { kind: string; payload: string }
    | undefined;
  if (!row) return false;
  ctx.db
    .prepare(
      "INSERT INTO cleanup_queue (id, kind, payload, attempts, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
    )
    .run(nanoid(), row.kind, row.payload, nowIso(), nowIso());
  ctx.db.prepare("DELETE FROM cleanup_dead_letter WHERE id = ?").run(id);
  return true;
}
