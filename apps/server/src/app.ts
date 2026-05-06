import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Docker from "dockerode";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import type { AppContext } from "./types.js";
import { serializeError } from "./lib/core.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerDatabaseRoutes } from "./routes/databases.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerMigrationRoutes } from "./routes/migrations.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerCloudflareRoutes } from "./routes/cloudflare.js";
import { registerExposureRoutes } from "./routes/exposure.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerTunnelRoutes } from "./routes/tunnels.js";
import { registerInspectorRoutes } from "./routes/inspector.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCrashReporter } from "./services/crashReporter.js";
import { startMetricsLoop } from "./services/metrics.js";
import { startSystemHealthLoop } from "./services/health.js";
import { startSslRenewalLoop } from "./services/sslRenewal.js";
import { startUpdateCheckLoop } from "./services/updateCheck.js";
import { startScheduledBackupsLoop } from "./services/scheduledBackups.js";
import { enforceSecretPolicy } from "./services/auth.js";
import {
  reconcileRuntimeStateOnBoot,
  startHealthcheckLoop,
  startContainerDriftLoop
} from "./services/runtime.js";
import { startGitPollerLoop } from "./services/poller.js";
import { writeAuditLog } from "./services/audit.js";
import { registerBuiltinTunnelAdapters } from "./services/tunnels/register.js";

const secureContextCache = new Map<string, tls.SecureContext>();

function createDockerClient(): Docker {
  const explicitHost = process.env.DOCKER_HOST;
  if (explicitHost?.startsWith("unix://")) {
    return new Docker({ socketPath: explicitHost.replace("unix://", "") });
  }
  if (explicitHost) {
    return new Docker();
  }

  const defaultSocket = "/var/run/docker.sock";
  if (fs.existsSync(defaultSocket)) {
    return new Docker({ socketPath: defaultSocket });
  }

  const colimaSockets = [
    path.join(os.homedir(), ".colima", "default", "docker.sock"),
    path.join(os.homedir(), ".colima", "docker.sock")
  ];
  const socketPath = colimaSockets.find((candidate) => fs.existsSync(candidate));
  return socketPath ? new Docker({ socketPath }) : new Docker();
}

export async function buildApp(): Promise<AppContext> {
  const docker = createDockerClient();
  enforceSecretPolicy({
    app: {} as never,
    db,
    docker,
    proxy: httpProxy.createProxyServer({}),
    wsSubscribers: new Set(),
    transferSubscribers: new Map(),
    runtimeProcesses: new Map(),
    actionLocks: new Set(),
    manuallyStopped: new Set(),
    config,
    shutdownTasks: []
  });

  const localCert =
    fs.existsSync(config.certPath) && fs.existsSync(config.keyPath)
      ? { cert: fs.readFileSync(config.certPath), key: fs.readFileSync(config.keyPath) }
      : null;

  const httpsOptions = config.enableHttps
    ? {
        https: {
          SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
            const cached = secureContextCache.get(servername);
            if (cached) return cb(null, cached);

            const row = db
              .prepare("SELECT fullchain, privkey FROM certificates WHERE domain = ?")
              .get(servername) as { fullchain: string; privkey: string } | undefined;
            if (row) {
              const sc = tls.createSecureContext({ cert: row.fullchain, key: row.privkey });
              secureContextCache.set(servername, sc);
              return cb(null, sc);
            }

            // Fallback to local self-signed cert
            if (localCert) {
              const sc = tls.createSecureContext(localCert);
              return cb(null, sc);
            }
            cb(new Error("No certificate found for domain"));
          },
          // default keys if SNI fails or is not provided
          cert: localCert?.cert,
          key: localCert?.key
        }
      }
    : {};

  // 50 MiB body limit so backup import (`/backup/import`) can carry a full
  // database snapshot. Default Fastify is 1 MiB which trips even on modest
  // installations once audit_logs accumulates.
  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024, ...httpsOptions });

  // Capture raw request bytes so webhook handlers can verify HMAC signatures.
  // GitHub signs the raw body, so JSON.stringify(req.body) is not byte-equivalent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      const parsed = (body as Buffer).length > 0 ? JSON.parse((body as Buffer).toString("utf8")) : {};
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // CORS:
  //   - Production: same-origin by default (dashboard is bundled and served
  //     by this same Fastify instance). Operators can opt-in to extra
  //     origins via SURVHUB_TRUSTED_ORIGINS=https://app.example.com,...
  //   - Development: allow localhost so the Vite dev server on :5173 can
  //     talk to the API on :8787 without manual configuration.
  const trusted = config.trustedOrigins;
  let corsOrigin: false | string[] | RegExp[];
  if (config.nodeEnv === "production") {
    corsOrigin = trusted.length > 0 ? trusted : false;
  } else {
    corsOrigin = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];
  }
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Cookie-bearing flows (none today, but session migration could add them)
  // should respect production-safe defaults pulled from config.secureCookies
  // — ensure the harden-by-default decision is visible at startup.
  if (config.nodeEnv === "production" && !config.secureCookies) {
    app.log.warn(
      "SURVHUB_SECURE_COOKIES is disabled in production — session cookies will not be flagged Secure."
    );
  }

  const ctx: AppContext = {
    app,
    db,
    docker,
    proxy: httpProxy.createProxyServer({}),
    wsSubscribers: new Set(),
    transferSubscribers: new Map(),
    runtimeProcesses: new Map(),
    actionLocks: new Set(),
    manuallyStopped: new Set(),
    config,
    shutdownTasks: []
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Validation failed",
        fields: error.flatten().fieldErrors,
        details: error.errors
      });
    }
    app.log.error(error);
    reply.code(500).send({ error: serializeError(error) });
  });

  registerAuthRoutes(ctx);
  registerOpsRoutes(ctx);
  registerProjectRoutes(ctx);
  registerServiceRoutes(ctx);
  registerDatabaseRoutes(ctx);
  registerProxyRoutes(ctx);
  registerDeploymentRoutes(ctx);
  registerBackupRoutes(ctx);
  registerMigrationRoutes(ctx);
  registerWebhookRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerCloudflareRoutes(ctx);
  registerExposureRoutes(ctx);
  registerObservabilityRoutes(ctx);
  registerBuiltinTunnelAdapters();
  registerTunnelRoutes(ctx);
  registerInspectorRoutes(ctx);
  registerAdminRoutes(ctx);
  const stopCrashReporter = registerCrashReporter(ctx);
  ctx.shutdownTasks.push(() => stopCrashReporter());

  // --- Static dashboard bundle --------------------------------------------
  // When SURVHub is distributed as a single binary/npm package, the built
  // web dashboard is colocated under `../web-dist` relative to the server's
  // compiled entry. Serve it from the root so users can open one URL.
  // In dev the Vite dev server still handles the UI directly.
  registerDashboardStatic(app);

  app.addHook("onResponse", async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || req.url.startsWith("/health")) return;
    const actor = (req as { actor?: string }).actor ?? "unauthenticated";
    const pathParts = req.url.split("?")[0].split("/").filter(Boolean);
    const resourceType = pathParts[0] ?? "unknown";
    const resourceId = pathParts[1];
    writeAuditLog(ctx, {
      actor,
      action: `${method} ${req.url.split("?")[0]}`,
      resourceType,
      resourceId,
      targetType: resourceType,
      targetId: resourceId,
      statusCode: reply.statusCode,
      details: reply.statusCode >= 400 ? "request_failed" : "request_ok",
      sourceIp: req.ip ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null
    });
  });

  // Fire-and-forget on purpose: Docker query may be slow if the daemon is
  // starting; we don't want to block API readiness on it.
  void reconcileRuntimeStateOnBoot(ctx).catch((err) => {
    app.log.error({ err }, "reconcileRuntimeStateOnBoot failed");
  });
  const stopHealthLoop = startHealthcheckLoop(ctx);
  ctx.shutdownTasks.push(() => stopHealthLoop());
  const stopDriftLoop = startContainerDriftLoop(ctx);
  ctx.shutdownTasks.push(() => stopDriftLoop());
  const stopGitLoop = startGitPollerLoop(ctx);
  ctx.shutdownTasks.push(() => stopGitLoop());
  const stopMetricsLoop = startMetricsLoop(ctx);
  ctx.shutdownTasks.push(() => stopMetricsLoop());
  const stopHealthLoopSys = startSystemHealthLoop(ctx);
  ctx.shutdownTasks.push(() => stopHealthLoopSys());
  const stopSslRenewal = startSslRenewalLoop(ctx);
  ctx.shutdownTasks.push(() => stopSslRenewal());
  const stopUpdateCheck = startUpdateCheckLoop(ctx);
  ctx.shutdownTasks.push(() => stopUpdateCheck());
  const stopScheduledBackups = startScheduledBackupsLoop(ctx);
  ctx.shutdownTasks.push(() => stopScheduledBackups());
  return ctx;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * Serve the built React dashboard from `<serverDist>/../web-dist/` at the
 * site root. Falls back to `index.html` for any unmatched non-API path so
 * client-side routing works. Reserved paths (API namespaces, WebSocket,
 * ACME challenge) are ignored and fall through to the Fastify router.
 */
function registerDashboardStatic(app: ReturnType<typeof Fastify>): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Search up to three candidate locations: alongside dist, one level up,
  // and the repo's apps/web/dist for development convenience.
  const candidates = [
    path.resolve(here, "../web-dist"),
    path.resolve(here, "../../web-dist"),
    path.resolve(here, "../../../apps/web/dist")
  ];
  const webDist = candidates.find((p) => {
    try {
      return fs.existsSync(path.join(p, "index.html"));
    } catch {
      return false;
    }
  });
  if (!webDist) return;

  const reservedPrefixes = [
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
    "/.well-known",
    "/onboarding",
    "/service-templates",
    "/project-templates",
    "/tunnels",
    "/admin",
    "/logs"
  ];

  app.addHook("onRequest", async (req: any, reply: any) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const url = (req.raw.url ?? "/").split("?")[0];
    if (reservedPrefixes.some((p) => url === p || url.startsWith(`${p}/`))) return;

    // Security: strip any path traversal attempts and resolve within webDist
    const clean = path.posix.normalize(url).replace(/^(\.\.(\/|\\|$))+/, "");
    let target = path.join(webDist, clean);
    if (!target.startsWith(webDist)) target = webDist;

    let filePath = target;
    try {
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      if (!stat || stat.isDirectory()) {
        filePath = path.join(webDist, "index.html");
      }
    } catch {
      filePath = path.join(webDist, "index.html");
    }

    if (!fs.existsSync(filePath)) return;
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    reply
      .header("content-type", MIME_TYPES[ext] ?? "application/octet-stream")
      .header("cache-control", ext === ".html" ? "no-cache" : "public, max-age=3600")
      .send(body);
  });
}
