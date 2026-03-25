import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Docker from "dockerode";
import httpProxy from "http-proxy";
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
import { enforceSecretPolicy } from "./services/auth.js";
import { reconcileRuntimeStateOnBoot, startHealthcheckLoop } from "./services/runtime.js";
import { writeAuditLog } from "./services/audit.js";

export async function buildApp(): Promise<AppContext> {
  enforceSecretPolicy({
    app: {} as never,
    db,
    docker: new Docker(),
    proxy: httpProxy.createProxyServer({}),
    wsSubscribers: new Set(),
    runtimeProcesses: new Map(),
    actionLocks: new Set(),
    manuallyStopped: new Set(),
    config,
    shutdownTasks: []
  });

  const httpsOptions = config.enableHttps && fs.existsSync(config.certPath) && fs.existsSync(config.keyPath)
    ? {
        https: {
          cert: fs.readFileSync(config.certPath),
          key: fs.readFileSync(config.keyPath)
        }
      }
    : {};

  const app = Fastify({ logger: true, ...httpsOptions });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  const ctx: AppContext = {
    app,
    db,
    docker: new Docker(),
    proxy: httpProxy.createProxyServer({}),
    wsSubscribers: new Set(),
    runtimeProcesses: new Map(),
    actionLocks: new Set(),
    manuallyStopped: new Set(),
    config,
    shutdownTasks: []
  };

  app.setErrorHandler((error, _request, reply) => {
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
      statusCode: reply.statusCode,
      details: reply.statusCode >= 400 ? "request_failed" : "request_ok"
    });
  });

  reconcileRuntimeStateOnBoot(ctx);
  const stopHealthLoop = startHealthcheckLoop(ctx);
  ctx.shutdownTasks.push(() => stopHealthLoop());
  return ctx;
}
