import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { getSetting, setSetting, getSecretSetting, setSecretSetting } from "../services/settings.js";
import { encryptSecret } from "../security.js";

const execFileP = promisify(execFile);

/**
 * Central email (SMTP) settings + per-project "enable email".
 *
 * The shared SMTP credentials (e.g. Cloudflare Email Service) are stored ONCE in
 * the `settings` table — the password encrypted at rest via setSecretSetting.
 * "Enable email" on a project copies them into that project's `project_env_vars`
 * (SMTP_PASSWORD encrypted, like every other project secret), which the runtime
 * layer injects into every service in the project. Callers must redeploy/restart
 * the project's services for the new env to take effect.
 */
const EMAIL_ENV_KEYS = [
  "EMAIL_ENABLED",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_FROM_NAME"
];

function emailConfigured(ctx: AppContext): boolean {
  return Boolean(getSetting(ctx, "smtp_host") && getSecretSetting(ctx, "smtp_password"));
}

export function registerEmailRoutes(ctx: AppContext): void {
  ctx.app.get("/email/settings", async () => ({
    host: getSetting(ctx, "smtp_host") ?? "",
    port: getSetting(ctx, "smtp_port") ?? "465",
    user: getSetting(ctx, "smtp_user") ?? "api_token",
    from: getSetting(ctx, "smtp_from") ?? "",
    from_name: getSetting(ctx, "smtp_from_name") ?? "",
    password_set: Boolean(getSecretSetting(ctx, "smtp_password")),
    configured: emailConfigured(ctx)
  }));

  ctx.app.put("/email/settings", async (req) => {
    const p = z
      .object({
        host: z.string().min(1),
        port: z.string().default("465"),
        user: z.string().default("api_token"),
        from: z.string().min(1),
        fromName: z.string().default(""),
        password: z.string().optional()
      })
      .parse(req.body);
    setSetting(ctx, "smtp_host", p.host);
    setSetting(ctx, "smtp_port", p.port);
    setSetting(ctx, "smtp_user", p.user);
    setSetting(ctx, "smtp_from", p.from);
    setSetting(ctx, "smtp_from_name", p.fromName);
    if (p.password && p.password.trim()) setSecretSetting(ctx, "smtp_password", p.password.trim());
    return { ok: true };
  });

  ctx.app.get("/email/projects", async () => {
    const projects = ctx.db
      .prepare("SELECT id, name FROM projects ORDER BY name ASC")
      .all() as Array<{ id: string; name: string }>;
    return projects.map((pr) => {
      const fromRow = ctx.db
        .prepare("SELECT value FROM project_env_vars WHERE project_id = ? AND key = 'SMTP_FROM' LIMIT 1")
        .get(pr.id) as { value: string } | undefined;
      const applied = Boolean(
        ctx.db
          .prepare("SELECT 1 FROM project_env_vars WHERE project_id = ? AND key = 'SMTP_HOST' LIMIT 1")
          .get(pr.id)
      );
      return { id: pr.id, name: pr.name, applied, from: fromRow?.value ?? "" };
    });
  });

  // Send a test email through the shared SMTP config, so the operator can
  // verify the credentials from the dashboard without deploying an app. Uses
  // curl's SMTP client (already on the host) via a mode-600 config file so the
  // token never lands in the process argv/list.
  ctx.app.post("/email/test", async (req) => {
    if (!emailConfigured(ctx)) {
      const e = new Error("Configure SMTP credentials first") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const host = getSetting(ctx, "smtp_host") ?? "";
    const port = getSetting(ctx, "smtp_port") ?? "465";
    const user = getSetting(ctx, "smtp_user") ?? "api_token";
    const pass = getSecretSetting(ctx, "smtp_password") ?? "";
    const from = getSetting(ctx, "smtp_from") ?? "";
    const fromName = getSetting(ctx, "smtp_from_name") ?? "";
    if (!from) {
      const e = new Error("Set a Default From address first") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const fromHeader = fromName ? `${fromName} <${from}>` : from;
    const message =
      [
        `From: ${fromHeader}`,
        `To: ${to}`,
        `Subject: ServerHoster SMTP test`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `This is a test email sent from your ServerHoster Email settings.`,
        `If you received it, the shared SMTP credentials work.`
      ].join("\r\n") + "\r\n";
    const suffix = nanoid();
    const msgPath = path.join(os.tmpdir(), `sh-mailtest-${suffix}.txt`);
    const cfgPath = path.join(os.tmpdir(), `sh-mailcfg-${suffix}`);
    const q = (s: string) => s.replace(/"/g, '\\"');
    const cfg = [
      `url = "smtps://${q(host)}:${q(port)}"`,
      `user = "${q(user)}:${q(pass)}"`,
      `mail-from = "${q(from)}"`,
      `mail-rcpt = "${q(to)}"`,
      `upload-file = "${q(msgPath)}"`,
      `ssl-reqd`,
      `silent`,
      `show-error`
    ].join("\n");
    try {
      fs.writeFileSync(msgPath, message, "utf8");
      fs.writeFileSync(cfgPath, cfg, { mode: 0o600 });
      await execFileP("curl", ["--config", cfgPath], { timeout: 20000 });
      return { ok: true, message: `Test email sent to ${to}.` };
    } catch (err) {
      const detail = (err as { stderr?: string }).stderr || (err as Error).message || "unknown error";
      const e = new Error(`Send failed: ${detail}`) as Error & { statusCode?: number };
      e.statusCode = 502;
      throw e;
    } finally {
      try { fs.unlinkSync(msgPath); } catch { /* ignore */ }
      try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    }
  });

  ctx.app.post("/email/apply/:projectId", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const project = ctx.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found");
    if (!emailConfigured(ctx)) {
      const e = new Error("Configure SMTP credentials first") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const body = z.object({ from: z.string().optional(), fromName: z.string().optional() }).parse(req.body ?? {});
    const vals: Array<[string, string, boolean]> = [
      ["EMAIL_ENABLED", "true", false],
      ["SMTP_HOST", getSetting(ctx, "smtp_host") ?? "", false],
      ["SMTP_PORT", getSetting(ctx, "smtp_port") ?? "465", false],
      ["SMTP_USER", getSetting(ctx, "smtp_user") ?? "api_token", false],
      ["SMTP_PASSWORD", getSecretSetting(ctx, "smtp_password") ?? "", true],
      ["SMTP_FROM", (body.from && body.from.trim()) || getSetting(ctx, "smtp_from") || "", false],
      ["SMTP_FROM_NAME", (body.fromName && body.fromName.trim()) || getSetting(ctx, "smtp_from_name") || "", false]
    ];
    const up = ctx.db.prepare(
      "INSERT INTO project_env_vars (id, project_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret"
    );
    ctx.db.transaction(() => {
      for (const [k, v, sec] of vals) {
        up.run(nanoid(), projectId, k, sec ? encryptSecret(v, ctx.config.secretKey) : v, sec ? 1 : 0);
      }
    })();
    return {
      ok: true,
      redeploy_required: true,
      applied_keys: vals.map((v) => v[0]),
      message: "Email enabled for this project. Redeploy/restart its services to apply."
    };
  });

  ctx.app.post("/email/remove/:projectId", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const del = ctx.db.prepare("DELETE FROM project_env_vars WHERE project_id = ? AND key = ?");
    ctx.db.transaction(() => {
      for (const k of EMAIL_ENV_KEYS) del.run(projectId, k);
    })();
    return {
      ok: true,
      redeploy_required: true,
      message: "Email removed from this project. Redeploy/restart its services."
    };
  });
}
