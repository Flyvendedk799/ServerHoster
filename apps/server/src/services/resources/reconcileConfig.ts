import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../../types.js";
import { getSetting, getSecretSetting } from "../settings.js";
import { getResource, listLinksForService, resourceConfig } from "./lifecycle.js";
import { applyPortOffsetToToml, setTomlValues } from "./supabasePorts.js";
import { publicOriginForLinkedResource } from "./publicExposure.js";
import {
  applyAuthMailToToml,
  writeDefaultAuthMailTemplates,
  type AuthMailSmtp
} from "./supabaseAuthMail.js";

/**
 * Re-apply ServerHoster-managed Supabase config to a service's freshly-reset
 * checkout.
 *
 * A git deploy hard-resets the working tree to remote state (`git checkout -f`
 * + `reset --hard`), which silently strips anything ServerHoster wrote into
 * `supabase/config.toml` at provision or from the Email tab — the host-port
 * block, the real JWT secret, the email/SMTP config and its templates. Until now
 * those only survived if the operator hand-committed them to the app repo; miss
 * that and the stack's next restart binds default ports, signs with the public
 * demo secret, or mails dead links.
 *
 * This runs right after the reset on every deploy and re-materialises that
 * managed config from ServerHoster's own state, so committing it to the app repo
 * is no longer required. Idempotent: a checkout that already carries the managed
 * values (e.g. because it *is* committed) comes out unchanged.
 */

export type ReconcileResult = {
  resourceId: string;
  name: string;
  /** Human-readable list of what was (re)applied, for the build log. */
  applied: string[];
  error?: string;
};

const JWT_SECRET_ENV = "env(SUPABASE_AUTH_JWT_SECRET)";

export type ReconcileEmailInput = {
  /** Public origin the SiteURL email links are built against. */
  origin: string;
  smtp: AuthMailSmtp;
  /** Whether GoTrue should require a signup confirmation step. */
  confirmations: boolean;
};

/**
 * Pure core: compute the reconciled config.toml and what changed. No DB, no file
 * writes — so it is fully unit-testable. The DB-and-fs wrapper below gathers the
 * inputs and persists the result (including the template files).
 */
export function reconciledConfigToml(
  toml: string,
  opts: { portOffset: number; email: ReconcileEmailInput | null }
): { toml: string; applied: string[] } {
  const applied: string[] = [];
  let out = toml;

  const withPorts = applyPortOffsetToToml(out, opts.portOffset);
  if (withPorts !== out) {
    out = withPorts;
    applied.push(`ports +${opts.portOffset}`);
  }

  const withJwt = setTomlValues(out, [{ section: "auth", key: "jwt_secret", value: JWT_SECRET_ENV }]);
  if (withJwt !== out) {
    out = withJwt;
    applied.push("jwt secret");
  }

  if (opts.email) {
    const before = out;
    out = applyAuthMailToToml(out, opts.email.origin, opts.email.smtp);
    if (opts.email.confirmations) {
      out = setTomlValues(out, [{ section: "auth.email", key: "enable_confirmations", value: true }]);
    }
    if (out !== before) applied.push("email + templates");
  }

  return { toml: out, applied };
}

function emailEnabledForProject(ctx: AppContext, projectId: string): boolean {
  const row = ctx.db
    .prepare("SELECT value FROM project_env_vars WHERE project_id = ? AND key = 'EMAIL_ENABLED'")
    .get(projectId) as { value?: string } | undefined;
  return row?.value === "true";
}

function smtpConfigured(ctx: AppContext): boolean {
  return Boolean(getSetting(ctx, "smtp_host") && getSecretSetting(ctx, "smtp_password"));
}

/** A project's own SMTP override, if the Email tab set one for this app. */
function projectEnv(ctx: AppContext, projectId: string, key: string): string | undefined {
  const row = ctx.db
    .prepare("SELECT value FROM project_env_vars WHERE project_id = ? AND key = ?")
    .get(projectId, key) as { value?: string } | undefined;
  return row?.value?.trim() || undefined;
}

/**
 * SMTP for a stack: the shared relay host/user, but the FROM prefers the app's
 * own address. Each app sends from its OWN domain (the relay authorises per
 * domain, so the shared default rarely works), so the per-project SMTP_FROM the
 * Email tab stored must win — exactly the precedence `/email/apply` uses. Using
 * the central From here was the bug that made a signup 550 "not authorized to
 * send from domain".
 */
function smtpForProject(ctx: AppContext, projectId: string): AuthMailSmtp {
  return {
    host: getSetting(ctx, "smtp_host") ?? "",
    port: Number(getSetting(ctx, "smtp_port") ?? "465") || 465,
    user: getSetting(ctx, "smtp_user") ?? "api_token",
    from: projectEnv(ctx, projectId, "SMTP_FROM") ?? getSetting(ctx, "smtp_from") ?? "",
    fromName: projectEnv(ctx, projectId, "SMTP_FROM_NAME") ?? getSetting(ctx, "smtp_from_name") ?? ""
  };
}

export function reconcileManagedSupabaseConfig(
  ctx: AppContext,
  serviceId: string,
  targetPath: string
): ReconcileResult[] {
  const results: ReconcileResult[] = [];
  for (const link of listLinksForService(ctx, serviceId)) {
    const resource = getResource(ctx, link.resource_id);
    if (!resource || resource.profile !== "supabase") continue;

    const configPath = path.join(targetPath, "supabase", "config.toml");
    let toml: string;
    try {
      toml = fs.readFileSync(configPath, "utf8");
    } catch {
      continue; // this checkout has no config.toml — nothing to reconcile
    }

    try {
      const cfg = resourceConfig(resource);
      const offset = typeof cfg.port_offset === "number" ? cfg.port_offset : 0;

      // Email is reconciled only when the project has it enabled, the relay is
      // configured, and the app has a public origin to mail links against. The
      // confirmations preference is stored on the resource so it survives a reset
      // too. Missing any of these → managed ports + JWT only, never email config.
      let email: ReconcileEmailInput | null = null;
      if (resource.project_id && emailEnabledForProject(ctx, resource.project_id) && smtpConfigured(ctx)) {
        const origin = publicOriginForLinkedResource(ctx, serviceId, resource.id, "supabase");
        if (origin) {
          email = {
            origin,
            smtp: smtpForProject(ctx, resource.project_id),
            confirmations: cfg.email_confirmations === true
          };
        }
      }

      const { toml: reconciled, applied } = reconciledConfigToml(toml, { portOffset: offset, email });
      // The config references template files; write the ones it points at (never
      // overwriting a custom one) so GoTrue can fetch them.
      if (email) writeDefaultAuthMailTemplates(targetPath);
      if (reconciled !== toml) fs.writeFileSync(configPath, reconciled, "utf8");
      results.push({ resourceId: resource.id, name: resource.name, applied });
    } catch (error) {
      results.push({
        resourceId: resource.id,
        name: resource.name,
        applied: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
