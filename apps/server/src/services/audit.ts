import { nanoid } from "nanoid";
import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";

export type AuditInput = {
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Logical type of the target object (e.g. "service", "deployment", "session"). */
  targetType?: string;
  /** Identifier of the target object inside that type. */
  targetId?: string;
  statusCode: number;
  details?: string;
  /** Source IP address of the caller (or null when not over HTTP). */
  sourceIp?: string | null;
  /** Caller User-Agent. Used to spot scripted abuse. */
  userAgent?: string | null;
};

/**
 * Persist a single audit log entry. The base columns (`actor`, `action`,
 * `resource_type`, `resource_id`, `status_code`, `details`) are stored
 * directly; the new enrichments (`targetType`, `targetId`, `sourceIp`,
 * `userAgent`) are encoded inline in `details` as `key=value` pairs so the
 * existing schema doesn't need a destructive migration. The
 * `audit_logs.target_type / target_id / source_ip / user_agent` columns
 * created by db.ts migrations get a copy too when present.
 */
export function writeAuditLog(ctx: AppContext, input: AuditInput): void {
  const enriched = [
    input.details && input.details.length > 0 ? input.details : null,
    input.targetType ? `targetType=${input.targetType}` : null,
    input.targetId ? `targetId=${input.targetId}` : null,
    input.sourceIp ? `sourceIp=${input.sourceIp}` : null,
    input.userAgent ? `userAgent=${truncate(input.userAgent, 200)}` : null
  ]
    .filter(Boolean)
    .join(" | ");

  // Probe whether the enriched columns exist (added by a migration). Cache
  // the answer per ctx.db so we don't hit pragma every call.
  const enriched_columns = detectEnrichedColumns(ctx);
  if (enriched_columns) {
    ctx.db
      .prepare(
        "INSERT INTO audit_logs (id, actor, action, resource_type, resource_id, status_code, details, target_type, target_id, source_ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        nanoid(),
        input.actor,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.statusCode,
        enriched,
        input.targetType ?? null,
        input.targetId ?? null,
        input.sourceIp ?? null,
        input.userAgent ?? null,
        nowIso()
      );
    return;
  }

  // Fallback path for older databases that haven't run the enrichment migration yet.
  ctx.db
    .prepare(
      "INSERT INTO audit_logs (id, actor, action, resource_type, resource_id, status_code, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      nanoid(),
      input.actor,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.statusCode,
      enriched,
      nowIso()
    );
}

const enrichedColumnCache = new WeakMap<object, boolean>();
function detectEnrichedColumns(ctx: AppContext): boolean {
  const cached = enrichedColumnCache.get(ctx.db);
  if (cached !== undefined) return cached;
  try {
    const cols = ctx.db.prepare("PRAGMA table_info(audit_logs)").all() as Array<{ name: string }>;
    const present = cols.some((c) => c.name === "source_ip");
    enrichedColumnCache.set(ctx.db, present);
    return present;
  } catch {
    enrichedColumnCache.set(ctx.db, false);
    return false;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
