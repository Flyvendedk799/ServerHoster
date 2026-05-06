import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  createSession,
  getConfiguredPassword,
  hashPassword,
  isAuthorizedToken,
  resolveActorFromToken,
  revokeSession,
  verifyPassword
} from "../services/auth.js";
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

// Mirror of `reservedPrefixes` in app.ts. Anything NOT under one of these is
// either a dashboard navigation route or a static asset, and is served by
// `registerDashboardStatic` without an Authorization header. The auth hook
// must let those requests through, otherwise the dashboard can't load itself
// before the user has a token.
const API_PREFIXES = [
  "/auth",
  "/projects",
  "/services",
  "/databases",
  "/deployments",
  "/proxy",
  "/settings",
  "/cloudflare",
  "/notifications",
  "/metrics",
  "/health",
  "/ops",
  "/github",
  "/webhooks",
  "/migrations",
  "/backup",
  "/ws",
  "/onboarding",
  "/service-templates",
  "/project-templates",
  "/tunnels"
];

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function registerAuthRoutes(ctx: AppContext): void {
  ctx.app.get("/auth/status", async () => {
    const userCount = ctx.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    const legacy = ctx.db.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").get() as
      | { value?: string }
      | undefined;
    const hasLegacyPassword = Boolean(legacy?.value);
    const hasAuthToken = Boolean(ctx.config.authToken);
    return {
      bootstrapped: userCount.count > 0 || hasLegacyPassword || hasAuthToken,
      hasUsers: userCount.count > 0,
      // The login form uses this to know whether to show the username field.
      requiresUsername: userCount.count > 0
    };
  });

  ctx.app.addHook("onRequest", async (req, reply) => {
    const path = requestPath(req.url);
    if (
      path === "/health" ||
      path === "/auth/login" ||
      path === "/onboarding" ||
      path === "/auth/bootstrap" ||
      path === "/auth/status"
    )
      return;
    // Webhooks authenticate via HMAC signature (verified inside the route),
    // not via Bearer token. Skipping the auth gate here is intentional.
    if (path.startsWith("/webhooks/")) return;
    // ACME HTTP-01 challenges must be reachable from Let's Encrypt without auth.
    if (path.startsWith("/.well-known/acme-challenge/")) return;
    // Dashboard HTML, JS, CSS, and SPA routes (anything NOT under an API
    // prefix) are served by registerDashboardStatic without auth. The
    // dashboard then attaches the Bearer token to its API calls.
    const method = (req.method ?? "GET").toUpperCase();
    if ((method === "GET" || method === "HEAD") && !isApiPath(path)) return;
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
    if (!isAuthorizedToken(ctx, token)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    (req as { actor?: string }).actor = resolveActorFromToken(ctx, token) ?? "unknown";
  });

  ctx.app.post(
    "/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
    },
    async (req, reply) => {
      const parsed = loginSchema.parse(req.body);
      if (parsed.username) {
        const user = ctx.db
          .prepare("SELECT id, password_hash FROM users WHERE username = ?")
          .get(parsed.username) as { id: string; password_hash: string } | undefined;
        if (!user || !verifyPassword(parsed.password, user.password_hash)) {
          reply.code(401).send({ error: "Invalid credentials" });
          return;
        }
        const token = nanoid(40);
        const expiresAt = Date.now() + ctx.config.sessionTtlMs;
        ctx.db
          .prepare("INSERT INTO sessions (id, token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
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
    }
  );

  ctx.app.post("/auth/logout", async (req) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
    revokeSession(ctx, token);
    return { ok: true };
  });

  ctx.app.post(
    "/auth/bootstrap",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
    },
    async (req, reply) => {
      const existingUser = ctx.db.prepare("SELECT id FROM users LIMIT 1").get();
      if (existingUser) {
        reply.code(409).send({ error: "Bootstrap already completed" });
        return;
      }
      const parsed = bootstrapSchema.parse(req.body);
      ctx.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(nanoid(), parsed.username, hashPassword(parsed.password), "admin", nowIso(), nowIso());
      return { ok: true };
    }
  );
}
