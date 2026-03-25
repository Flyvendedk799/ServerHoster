import { nanoid } from "nanoid";
import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";

export function writeAuditLog(ctx: AppContext, input: {
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  statusCode: number;
  details?: string;
}): void {
  ctx.db.prepare(
    "INSERT INTO audit_logs (id, actor, action, resource_type, resource_id, status_code, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    nanoid(),
    input.actor,
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    input.statusCode,
    input.details ?? "",
    nowIso()
  );
}
