import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";
import { deleteDnsRecord, removeTunnelIngress } from "./cloudflare.js";

/**
 * Best-effort retry queue for asynchronous Cloudflare cleanups (DNS records,
 * tunnel ingress) that failed during a service delete or domain change. The
 * SSL renewal loop drains it daily.
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

export function enqueueCleanup(ctx: AppContext, kind: CleanupKind, payload: Record<string, unknown>): void {
  ctx.db
    .prepare(
      "INSERT INTO cleanup_queue (id, kind, payload, attempts, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
    )
    .run(nanoid(), kind, JSON.stringify(payload), nowIso(), nowIso());
}

export async function drainCleanupQueue(ctx: AppContext): Promise<{ done: number; remaining: number }> {
  const rows = ctx.db.prepare("SELECT * FROM cleanup_queue ORDER BY created_at ASC").all() as CleanupRow[];
  let done = 0;
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
      // Drop entries after 10 attempts so the queue doesn't grow forever.
      if (row.attempts + 1 >= 10) ctx.db.prepare("DELETE FROM cleanup_queue WHERE id = ?").run(row.id);
    }
  }
  const remaining = (ctx.db.prepare("SELECT COUNT(*) as count FROM cleanup_queue").get() as { count: number })
    .count;
  return { done, remaining };
}
