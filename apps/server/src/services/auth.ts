import { nanoid } from "nanoid";
import crypto from "node:crypto";
import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";

export function enforceSecretPolicy(ctx: AppContext): void {
  if (ctx.config.nodeEnv === "production" && !ctx.config.secretKey) {
    throw new Error("SURVHUB_SECRET_KEY is required in production");
  }
}

export function createSession(ctx: AppContext): { token: string; expiresInMs: number } {
  const token = nanoid(40);
  const expiresAt = Date.now() + ctx.config.sessionTtlMs;
  ctx.db
    .prepare("INSERT INTO sessions (id, token, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(nanoid(), token, expiresAt, nowIso());
  return { token, expiresInMs: ctx.config.sessionTtlMs };
}

export function revokeSession(ctx: AppContext, token: string): void {
  ctx.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function cleanupExpiredSessions(ctx: AppContext): void {
  ctx.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

export function isAuthorizedToken(ctx: AppContext, token: string): boolean {
  if (!isAuthEnabled(ctx)) return true;
  if (!token) return false;
  if (ctx.config.authToken && token === ctx.config.authToken) return true;
  cleanupExpiredSessions(ctx);
  const row = ctx.db
    .prepare("SELECT id FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, Date.now());
  return Boolean(row);
}

export function resolveActorFromToken(ctx: AppContext, token: string): string | null {
  if (!isAuthEnabled(ctx)) return "anonymous";
  if (!token) return null;
  if (ctx.config.authToken && token === ctx.config.authToken) return "root-token";
  cleanupExpiredSessions(ctx);
  const row = ctx.db
    .prepare("SELECT id, user_id FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, Date.now()) as { id: string; user_id?: string | null } | undefined;
  if (!row) return null;
  return row.user_id ? `user:${row.user_id}` : `session:${row.id}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const incoming = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(incoming, "hex"), Buffer.from(hash, "hex"));
}

export function getConfiguredPassword(ctx: AppContext): string {
  return (
    ctx.config.authToken ||
    (
      ctx.db.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").get() as
        | { value: string }
        | undefined
    )?.value ||
    ""
  );
}

function isAuthEnabled(ctx: AppContext): boolean {
  const configured = getConfiguredPassword(ctx);
  if (configured) return true;
  const users = ctx.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return users.count > 0;
}
