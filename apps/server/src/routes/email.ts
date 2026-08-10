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

// ---- Receiving (Cloudflare Email Routing) ---------------------------------
// Forwarding is set up against Cloudflare's Email Routing API using a stored
// token (Zone: Read + Email Routing Rules: Edit) + account id.
const CF_BASE = "https://api.cloudflare.com/client/v4";

function routingConfigured(ctx: AppContext): boolean {
  return Boolean(getSecretSetting(ctx, "email_routing_token") && getSecretSetting(ctx, "cloudflare_account_id"));
}

type CfEnvelope = { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };

async function cfApi(ctx: AppContext, apiPath: string, init?: RequestInit): Promise<unknown> {
  const token = getSecretSetting(ctx, "email_routing_token") ?? "";
  const res = await fetch(`${CF_BASE}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  let data: CfEnvelope | null = null;
  try {
    data = (await res.json()) as CfEnvelope;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || !data?.success) {
    const msg = data?.errors?.[0]?.message || `Cloudflare API returned ${res.status}`;
    const e = new Error(`Cloudflare: ${msg}`) as Error & { statusCode?: number };
    e.statusCode = 502;
    throw e;
  }
  return data.result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardDest(actions: any[]): string {
  return actions?.find((a) => a?.type === "forward")?.value?.[0] ?? "";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function literalTo(matchers: any[]): string {
  return matchers?.find((m) => m?.type === "literal" && m?.field === "to")?.value ?? "";
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

  // ---- Receiving (Cloudflare Email Routing) -------------------------------
  ctx.app.get("/email/receiving/config", async () => ({
    configured: routingConfigured(ctx)
  }));

  ctx.app.put("/email/receiving/config", async (req) => {
    const p = z.object({ token: z.string().optional(), accountId: z.string().optional() }).parse(req.body ?? {});
    if (p.token && p.token.trim()) setSecretSetting(ctx, "email_routing_token", p.token.trim());
    if (p.accountId && p.accountId.trim()) setSecretSetting(ctx, "cloudflare_account_id", p.accountId.trim());
    return { ok: true };
  });

  ctx.app.get("/email/receiving/zones", async () => {
    if (!routingConfigured(ctx)) return { configured: false, zones: [] };
    const result = (await cfApi(ctx, "/zones?per_page=50")) as Array<{ id: string; name: string }>;
    return { configured: true, zones: result.map((z) => ({ id: z.id, name: z.name })) };
  });

  ctx.app.get("/email/receiving/:zoneId/rules", async (req) => {
    if (!routingConfigured(ctx)) {
      const e = new Error("Email Routing is not configured") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const { zoneId } = req.params as { zoneId: string };
    const account = getSecretSetting(ctx, "cloudflare_account_id") ?? "";
    const [rulesRes, catchRes, addrRes] = await Promise.all([
      cfApi(ctx, `/zones/${zoneId}/email/routing/rules`),
      cfApi(ctx, `/zones/${zoneId}/email/routing/rules/catch_all`).catch(() => null),
      cfApi(ctx, `/accounts/${account}/email/routing/addresses`).catch(() => [])
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = (rulesRes as any[])
      .filter((r) => !r?.matchers?.some((m: { type?: string }) => m?.type === "all"))
      .map((r) => ({
        id: r.id as string,
        to: literalTo(r.matchers),
        dest: forwardDest(r.actions),
        enabled: Boolean(r.enabled),
        name: (r.name as string) ?? ""
      }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ca = catchRes as any;
    const catch_all = ca
      ? { enabled: Boolean(ca.enabled), dest: forwardDest(ca.actions) }
      : { enabled: false, dest: "" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const destinations = (addrRes as any[]).map((a) => ({ email: a.email as string, verified: Boolean(a.verified) }));
    return { catch_all, rules, destinations };
  });

  ctx.app.post("/email/receiving/:zoneId/forward", async (req) => {
    if (!routingConfigured(ctx)) {
      const e = new Error("Email Routing is not configured") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const { zoneId } = req.params as { zoneId: string };
    const body = z.object({ to: z.string().email(), from: z.string().optional() }).parse(req.body ?? {});
    const account = getSecretSetting(ctx, "cloudflare_account_id") ?? "";

    // 1. Ensure the destination exists. Cloudflare rejects a forward rule whose
    // destination isn't verified yet, so on a brand-new (or still-unverified)
    // destination we create it (which fires the verification email) and STOP —
    // the operator clicks the emailed link, then adds the forward again to finish.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addrs = (await cfApi(ctx, `/accounts/${account}/email/routing/addresses`).catch(() => [])) as any[];
    const existing = addrs.find((a) => String(a?.email).toLowerCase() === body.to.toLowerCase());
    if (!existing) {
      await cfApi(ctx, `/accounts/${account}/email/routing/addresses`, {
        method: "POST",
        body: JSON.stringify({ email: body.to })
      }).catch(() => null);
    }
    if (!existing?.verified) {
      return {
        ok: true,
        destination_verified: false,
        message: `Almost there — check ${body.to} for a Cloudflare verification link, then add this forward again to switch it on.`
      };
    }

    // 2. Destination is verified — enable routing (idempotent; ignore failure).
    await cfApi(ctx, `/zones/${zoneId}/email/routing/enable`, {
      method: "POST",
      body: JSON.stringify({})
    }).catch(() => null);

    // 3. Specific address rule, or the catch-all.
    const from = body.from?.trim();
    if (from) {
      await cfApi(ctx, `/zones/${zoneId}/email/routing/rules`, {
        method: "POST",
        body: JSON.stringify({
          actions: [{ type: "forward", value: [body.to] }],
          matchers: [{ type: "literal", field: "to", value: from }],
          enabled: true,
          name: `${from} -> ${body.to}`
        })
      });
    } else {
      await cfApi(ctx, `/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify({
          actions: [{ type: "forward", value: [body.to] }],
          matchers: [{ type: "all" }],
          enabled: true
        })
      });
    }

    return { ok: true, destination_verified: true, message: "Forwarding is live." };
  });

  ctx.app.delete("/email/receiving/:zoneId/rules/:ruleId", async (req) => {
    if (!routingConfigured(ctx)) {
      const e = new Error("Email Routing is not configured") as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    const { zoneId, ruleId } = req.params as { zoneId: string; ruleId: string };
    if (ruleId === "catch_all") {
      await cfApi(ctx, `/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify({ actions: [{ type: "drop" }], matchers: [{ type: "all" }], enabled: false })
      });
    } else {
      await cfApi(ctx, `/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: "DELETE" });
    }
    return { ok: true };
  });
}
