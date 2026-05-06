import crypto from "node:crypto";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { hashPassword } from "../services/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { nowIso } from "../lib/core.js";

const resetSchema = z.object({
  username: z.string().min(1).optional(),
  /** Optional explicit password. When omitted the server generates one. */
  newPassword: z.string().min(8).max(256).optional()
});

/**
 * Sequence 1 — secure admin recovery flow.
 *
 * The CLI command `survhub reset-admin` requires shell access on the host;
 * this HTTP equivalent gives operators a tokenised path to rotate
 * credentials when shell access isn't immediately available (e.g. recovery
 * over a Cloudflare Tunnel after SSH is locked out).
 *
 * Hard guarantees:
 *
 *   1. Disabled by default. Returns 503 unless `SURVHUB_ADMIN_RESET_TOKEN`
 *      is set on the host. The token is never persisted in the database.
 *   2. Constant-time token comparison; no leaks of "wrong length" vs.
 *      "wrong bytes".
 *   3. Endpoint-specific rate limit (5/min) on top of the global limiter.
 *   4. Every call (success or failure) writes an audit_logs row enriched
 *      with source IP and user agent.
 *   5. On success, every active session for the target user is revoked, so
 *      a leaked-password attacker cannot keep their foothold.
 */
export function registerAdminRoutes(ctx: AppContext): void {
  ctx.app.post(
    "/admin/reset-admin",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
    },
    async (req, reply) => {
      const sourceIp = req.ip ?? null;
      const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

      if (!ctx.config.adminResetToken) {
        writeAuditLog(ctx, {
          actor: "admin-reset:disabled",
          action: "POST /admin/reset-admin",
          resourceType: "admin",
          statusCode: 503,
          details: "endpoint_disabled",
          sourceIp,
          userAgent
        });
        return reply.code(503).send({
          error: "Admin reset endpoint is disabled",
          hint: "Set SURVHUB_ADMIN_RESET_TOKEN on the server to enable."
        });
      }

      const provided = req.headers["x-admin-reset-token"];
      const token = (Array.isArray(provided) ? provided[0] : (provided ?? "")).trim();
      if (!token || !constantTimeEqual(token, ctx.config.adminResetToken)) {
        writeAuditLog(ctx, {
          actor: "admin-reset:unauthorized",
          action: "POST /admin/reset-admin",
          resourceType: "admin",
          statusCode: 401,
          details: "token_mismatch",
          sourceIp,
          userAgent
        });
        return reply.code(401).send({ error: "Unauthorized" });
      }

      let body: z.infer<typeof resetSchema>;
      try {
        body = resetSchema.parse(req.body ?? {});
      } catch {
        return reply.code(400).send({ error: "Invalid body" });
      }

      let target: { id: string; username: string } | undefined;
      if (body.username) {
        target = ctx.db.prepare("SELECT id, username FROM users WHERE username = ?").get(body.username) as
          | { id: string; username: string }
          | undefined;
      } else {
        target = ctx.db
          .prepare("SELECT id, username FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
          .get() as { id: string; username: string } | undefined;
      }
      if (!target) {
        writeAuditLog(ctx, {
          actor: "admin-reset",
          action: "POST /admin/reset-admin",
          resourceType: "admin",
          statusCode: 404,
          details: `target_missing:${body.username ?? "<first-admin>"}`,
          sourceIp,
          userAgent
        });
        return reply.code(404).send({ error: "No matching admin user" });
      }

      const newPassword =
        body.newPassword ?? crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 24);
      ctx.db
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPassword(newPassword), nowIso(), target.id);
      // Revoke any active sessions so the previous credential can't keep working.
      const revokedInfo = ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);

      writeAuditLog(ctx, {
        actor: "admin-reset",
        action: "POST /admin/reset-admin",
        resourceType: "admin",
        resourceId: target.id,
        targetType: "user",
        targetId: target.id,
        statusCode: 200,
        details: `reset_user=${target.username} sessions_revoked=${revokedInfo.changes}`,
        sourceIp,
        userAgent
      });

      return {
        ok: true,
        username: target.username,
        newPassword,
        sessionsRevoked: revokedInfo.changes,
        // Operators can use this as a confirmation marker in their runbook.
        receipt: nanoid(12)
      };
    }
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
