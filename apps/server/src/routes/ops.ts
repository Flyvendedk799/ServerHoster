import fs from "node:fs";
import os from "node:os";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { buildHttpsTrustGuide, generateHttpsCerts, getInstallScripts } from "../services/ops.js";

const httpsGenerateSchema = z.object({
  commonName: z.string().default("localhost"),
  altNames: z.array(z.string()).default(["localhost", "127.0.0.1"])
});

export function registerOpsRoutes(ctx: AppContext): void {
  ctx.app.get("/health", async () => ({ ok: true }));

  ctx.app.get("/onboarding", async () => {
    const projectCount = ctx.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
    return {
      hasProjects: projectCount.count > 0,
      platform: os.platform(),
      authEnabled: Boolean(ctx.config.authToken)
    };
  });

  ctx.app.get("/metrics/system", async () => ({
    uptime: os.uptime(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAvg: os.loadavg(),
    cpus: os.cpus().length,
    platform: os.platform()
  }));

  ctx.app.get("/service-templates", async () => ({
    linux: `[Unit]
Description=SURVHub
After=network.target
[Service]
ExecStart=survhub server
Restart=always
[Install]
WantedBy=multi-user.target`,
    macos: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.survhub.server</string></dict></plist>`,
    windows: `sc create SURVHub binPath= "survhub server"`
  }));

  ctx.app.get("/ops/https/status", async () => ({
    certExists: fs.existsSync(ctx.config.certPath),
    keyExists: fs.existsSync(ctx.config.keyPath),
    certPath: ctx.config.certPath,
    keyPath: ctx.config.keyPath,
    trustGuide: buildHttpsTrustGuide()
  }));

  ctx.app.post("/ops/https/generate", async (req) => {
    const p = httpsGenerateSchema.parse(req.body ?? {});
    return generateHttpsCerts(ctx, p.commonName, p.altNames);
  });

  ctx.app.get("/ops/install-scripts", async () => getInstallScripts(ctx));

  ctx.app.get("/ops/audit-logs", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return ctx.db
      .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 1000));
  });
}
