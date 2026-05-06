import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { buildHttpsTrustGuide, generateHttpsCerts, getInstallScripts } from "../services/ops.js";

const exec = promisify(execFile);

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

  /**
   * Sequence 6 — first-run wizard diagnostics.
   *
   * Runs a non-destructive sweep of every external dependency the dashboard
   * relies on, so the onboarding screen can light up "Docker missing", "git
   * missing", "port 80 in use", "DNS not set" with actionable suggestions
   * before the user files a support issue.
   *
   * Each entry returns:
   *   - id:        stable identifier the UI maps to a copy/paste hint
   *   - label:     human-readable
   *   - status:    "ok" | "warn" | "fail"
   *   - detail:    short message
   *   - hint:      actionable next step (only set when status != "ok")
   */
  ctx.app.get("/ops/diagnostics", async () => {
    const checks: Array<{
      id: string;
      label: string;
      status: "ok" | "warn" | "fail";
      detail: string;
      hint?: string;
    }> = [];

    // Docker
    try {
      const { stdout } = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
      const version = stdout.trim();
      if (version.length === 0) throw new Error("empty version");
      checks.push({
        id: "docker",
        label: "Docker daemon",
        status: "ok",
        detail: `Docker server ${version} is responding.`
      });
    } catch (error) {
      checks.push({
        id: "docker",
        label: "Docker daemon",
        status: "warn",
        detail: error instanceof Error ? error.message : String(error),
        hint: "Install Docker (https://docs.docker.com/engine/install/) if you plan to deploy container services or managed databases."
      });
    }

    // git
    try {
      const { stdout } = await exec("git", ["--version"]);
      checks.push({
        id: "git",
        label: "git CLI",
        status: "ok",
        detail: stdout.trim()
      });
    } catch (error) {
      checks.push({
        id: "git",
        label: "git CLI",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        hint: "git is required to clone repositories. Install it from https://git-scm.com/downloads."
      });
    }

    // Port availability for the proxy
    const proxyPortFree = await isPortFree(ctx.config.proxyPort);
    checks.push({
      id: "proxy_port",
      label: `Reverse-proxy port :${ctx.config.proxyPort}`,
      status: proxyPortFree ? "ok" : "warn",
      detail: proxyPortFree
        ? `Port ${ctx.config.proxyPort} is currently free.`
        : `Port ${ctx.config.proxyPort} is in use by another process.`,
      hint: proxyPortFree
        ? undefined
        : "Stop the conflicting service or change SURVHUB_PROXY_PORT before binding domains."
    });

    // API port availability (informational — we know our own port is bound)
    const apiPortFree = await isPortFree(ctx.config.apiPort);
    checks.push({
      id: "api_port",
      label: `API port :${ctx.config.apiPort}`,
      status: apiPortFree ? "warn" : "ok",
      detail: apiPortFree
        ? `Port ${ctx.config.apiPort} appears free — is LocalSURV bound on a different host?`
        : `Port ${ctx.config.apiPort} is in use (this is the API itself).`
    });

    // DNS sanity: confirm we can resolve a stable public hostname.
    try {
      await dns.resolve4("github.com");
      checks.push({
        id: "dns",
        label: "DNS resolution",
        status: "ok",
        detail: "DNS resolver is reachable (github.com resolved)."
      });
    } catch (error) {
      checks.push({
        id: "dns",
        label: "DNS resolution",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        hint: "Check the host's resolv.conf / network configuration; LocalSURV needs DNS to clone repos and reach Cloudflare/Let's Encrypt."
      });
    }

    // Secret key configuration
    if (ctx.config.secretKey) {
      checks.push({
        id: "secret_key",
        label: "SURVHUB_SECRET_KEY",
        status: "ok",
        detail: "Secret key is configured. Encrypted settings will round-trip across restarts."
      });
    } else {
      checks.push({
        id: "secret_key",
        label: "SURVHUB_SECRET_KEY",
        status: "fail",
        detail: "SURVHUB_SECRET_KEY is not set.",
        hint: "Run `survhub init` to generate one, or export SURVHUB_SECRET_KEY before restarting."
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      platform: os.platform(),
      checks
    };
  });
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    try {
      server.listen(port, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}
