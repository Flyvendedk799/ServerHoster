import { z } from "zod";
import type { AppContext } from "../types.js";
import { createSession, getConfiguredPassword, hashPassword, isAuthorizedToken, resolveActorFromToken, revokeSession, verifyPassword } from "../services/auth.js";
import { nanoid } from "nanoid";
import { nowIso } from "../lib/core.js";

const loginSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1)
});
const bootstrapSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8)
});

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

export function registerAuthRoutes(ctx: AppContext): void {
  ctx.app.addHook("onRequest", async (req, reply) => {
    const path = requestPath(req.url);
    if (path === "/health" || path === "/auth/login" || path === "/onboarding" || path === "/auth/bootstrap") return;
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
    if (!isAuthorizedToken(ctx, token)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    (req as { actor?: string }).actor = resolveActorFromToken(ctx, token) ?? "unknown";
  });

  ctx.app.post("/auth/login", async (req, reply) => {
    const parsed = loginSchema.parse(req.body);
    if (parsed.username) {
      const user = ctx.db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(parsed.username) as
        | { id: string; password_hash: string }
        | undefined;
      if (!user || !verifyPassword(parsed.password, user.password_hash)) {
        reply.code(401).send({ error: "Invalid credentials" });
        return;
      }
      const token = nanoid(40);
      const expiresAt = Date.now() + ctx.config.sessionTtlMs;
      ctx.db.prepare("INSERT INTO sessions (id, token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(nanoid(), token, user.id, expiresAt, nowIso());
      return { token, expiresInMs: ctx.config.sessionTtlMs };
    } else {
      const configured = getConfiguredPassword(ctx);
      if (!configured || parsed.password !== configured) {
        reply.code(401).send({ error: "Invalid credentials" });
        return;
      }
      return createSession(ctx);
    }
  });

  ctx.app.post("/auth/logout", async (req) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
    revokeSession(ctx, token);
    return { ok: true };
  });

  ctx.app.post("/auth/bootstrap", async (req, reply) => {
    const existingUser = ctx.db.prepare("SELECT id FROM users LIMIT 1").get();
    if (existingUser) {
      reply.code(409).send({ error: "Bootstrap already completed" });
      return;
    }
    const parsed = bootstrapSchema.parse(req.body);
    ctx.db.prepare("INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(nanoid(), parsed.username, hashPassword(parsed.password), "admin", nowIso(), nowIso());
    return { ok: true };
  });
}
