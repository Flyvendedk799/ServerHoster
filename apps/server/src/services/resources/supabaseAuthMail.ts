import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../../types.js";
import { getSecretSetting } from "../settings.js";
import { publicOriginForLinkedResource } from "./publicExposure.js";
import { setTomlValues, type TomlValue } from "./supabasePorts.js";

/**
 * Point a local Supabase stack's GoTrue at the shared SMTP relay — the missing
 * half of the Email tab.
 *
 * "Enable email" injects SMTP_* into a project's env, which is all a custom
 * backend needs. A Supabase-backed app ignores them completely: its auth mail is
 * sent by GoTrue, configured from supabase/config.toml, which nothing wrote to.
 * Every self-hosted stack on this host therefore had the CLI's local-dev auth
 * defaults, and three of them are wrong for anything with a domain:
 *
 *   - every confirmation/recovery link GoTrue mails out is a loopback address
 *     that only resolves on the VPS. Silent: the mail sends fine, the link is
 *     dead. GoTrue builds those links from API_EXTERNAL_URL — but we must NOT
 *     set that to the public domain: `supabase start` then health-checks it
 *     (/rest-admin/v1/ready, /functions/v1/_internal/health), paths the tunnel
 *     doesn't route, so the probe 404s and the whole stack fails to start. So
 *     API_EXTERNAL_URL stays loopback and we ship email templates that build the
 *     link from `{{ .SiteURL }}` (the public domain) instead — /auth/v1/verify
 *     IS tunnel-routed, so a SiteURL link resolves from a recipient's inbox.
 *   - GOTRUE_URI_ALLOW_LIST defaults to https://127.0.0.1:3000, so any
 *     emailRedirectTo the app passes is rejected and downgraded to site_url —
 *     which strands people on the marketing page instead of /reset-password.
 *   - site_url itself defaults to localhost.
 *
 * A fourth default, `enable_confirmations = false`, means signup sends NO mail
 * at all (GOTRUE_MAILER_AUTOCONFIRM=true auto-confirms instead). That one is a
 * product decision — an app may deliberately not want a confirmation step — so
 * this module never flips it. It reports it instead, via auditAuthMailToml, so
 * the operator finds out from the Email tab rather than from a user who never
 * got their mail.
 */

export type AuthMailSmtp = {
  host: string;
  port: number;
  user: string;
  /** Sender address; also GoTrue's admin_email. */
  from: string;
  fromName: string;
};

/**
 * The env var the CLI resolves `pass = "env(...)"` against. It is passed into
 * the `supabase start` process (see profiles/supabase.ts) rather than written
 * into the project clone, so the relay password never lands in a repo working
 * tree. CLI 2.109+ REQUIRES the env() form here — a literal is rejected.
 */
export const SMTP_PASS_ENV_KEY = "SUPABASE_AUTH_SMTP_PASS";

/**
 * The auth emails whose link must reach the public domain. We ship a template
 * per type that builds the link from `{{ .SiteURL }}` rather than GoTrue's
 * default `{{ .ConfirmationURL }}` (which is loopback here — see the module doc
 * on why API_EXTERNAL_URL must stay loopback). `verifyType` is the `type=` the
 * `/auth/v1/verify` endpoint expects for that flow.
 */
export const AUTH_MAIL_TEMPLATES = [
  { key: "confirmation", verifyType: "signup", subject: "Confirm your email", heading: "Confirm your email", lead: "Confirm your address to finish creating your account:", cta: "Confirm your email" },
  { key: "recovery", verifyType: "recovery", subject: "Reset your password", heading: "Reset your password", lead: "Follow this link to choose a new password:", cta: "Reset password" },
  { key: "magic_link", verifyType: "magiclink", subject: "Your sign-in link", heading: "Sign in", lead: "Follow this link to sign in:", cta: "Sign in" }
] as const;

type AuthMailTemplate = (typeof AUTH_MAIL_TEMPLATES)[number];

/** The relative content_path GoTrue's template server reads, per type. */
function templateContentPath(key: string): string {
  return `./supabase/templates/${key}.html`;
}

/** A minimal SiteURL-based template body for one auth-email type. */
export function authMailTemplateBody(t: AuthMailTemplate): string {
  return [
    "<!--",
    "  Written by ServerHoster's Email tab. The link is built from the SiteURL",
    "  (the public domain) rather than GoTrue's default loopback link. Edit",
    "  freely — a file that already exists is never overwritten.",
    "-->",
    `<h2>${t.heading}</h2>`,
    `<p>${t.lead}</p>`,
    `<p><a href="{{ .SiteURL }}/auth/v1/verify?token={{ .TokenHash }}&type=${t.verifyType}&redirect_to={{ .RedirectTo }}">${t.cta}</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
    ""
  ].join("\n");
}

/** True when `[section]` already appears in the TOML (so we don't clobber it). */
function tomlHasSection(toml: string, section: string): boolean {
  return new RegExp(`(^|\\n)\\s*\\[${section.replace(/\./g, "\\.")}\\]`).test(toml);
}

/**
 * Remove `external_url = …` from the `[api]` section, if present.
 *
 * A public api.external_url is the footgun this module exists to avoid: it makes
 * `supabase start` health-check unrouted admin paths and abort. Stripping it on
 * every apply means enabling email also *repairs* a stack an older version (or a
 * hand edit) left with a public external_url, rather than only avoiding it on
 * fresh ones. Left absent, GoTrue's API_EXTERNAL_URL falls back to loopback,
 * which is exactly what we want — the SiteURL templates carry the public link.
 */
export function stripApiExternalUrl(toml: string): string {
  const out: string[] = [];
  let inApi = false;
  for (const line of toml.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) inApi = header[1] === "api";
    if (inApi && /^\s*external_url\s*=/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Rewrite config.toml so GoTrue sends through `smtp` and mails PUBLIC links.
 *
 * Deliberately does NOT set `api.external_url` — pointing it at the public domain
 * makes `supabase start` health-check unrouted admin paths and the stack fails to
 * start (see the module doc). Public links come from `site_url` plus the SiteURL
 * templates written by `writeDefaultAuthMailTemplates`; this only references a
 * template section it doesn't already find, so a hand-tuned subject/path (or a
 * localised template) survives a re-apply.
 *
 * Idempotent: re-applying the same values is a no-op, and keys the operator set
 * by hand are replaced in place rather than duplicated.
 */
export function applyAuthMailToToml(toml: string, publicOrigin: string, smtp: AuthMailSmtp): string {
  const origin = publicOrigin.replace(/\/+$/, "");
  const entries: Array<{ section: string; key: string; value: TomlValue }> = [
    { section: "auth", key: "site_url", value: origin },
    // The `/**` form is what the app's own redirects (e.g. /reset-password,
    // /app) match against; the bare origin covers a redirect to the root.
    { section: "auth", key: "additional_redirect_urls", value: { raw: `["${origin}", "${origin}/**"]` } },
    { section: "auth.email.smtp", key: "enabled", value: true },
    { section: "auth.email.smtp", key: "host", value: smtp.host },
    { section: "auth.email.smtp", key: "port", value: smtp.port },
    { section: "auth.email.smtp", key: "user", value: smtp.user },
    { section: "auth.email.smtp", key: "pass", value: `env(${SMTP_PASS_ENV_KEY})` },
    { section: "auth.email.smtp", key: "admin_email", value: smtp.from },
    { section: "auth.email.smtp", key: "sender_name", value: smtp.fromName || smtp.from }
  ];
  // Reference each SiteURL template — but only if the operator hasn't already
  // configured that template section by hand (custom subject / localised copy).
  for (const t of AUTH_MAIL_TEMPLATES) {
    const section = `auth.email.template.${t.key}`;
    if (tomlHasSection(toml, section)) continue;
    entries.push({ section, key: "subject", value: t.subject });
    entries.push({ section, key: "content_path", value: templateContentPath(t.key) });
  }
  return setTomlValues(stripApiExternalUrl(toml), entries);
}

/**
 * Write the SiteURL template files into the stack's checkout, one per type.
 * Never overwrites an existing file, so a hand-edited or localised template is
 * left alone. Returns the paths actually written.
 */
export function writeDefaultAuthMailTemplates(workdir: string): string[] {
  const dir = path.join(workdir, "supabase", "templates");
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const t of AUTH_MAIL_TEMPLATES) {
    const file = path.join(dir, `${t.key}.html`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, authMailTemplateBody(t), "utf8");
    written.push(file);
  }
  return written;
}

export type AuthMailAudit = {
  /** False when signup mail is silently skipped (the CLI default). */
  signup_confirmation_email: boolean;
  smtp_configured: boolean;
  public_links: boolean;
  warnings: string[];
};

/** Read-only report on what a stack's config.toml will actually do with mail. */
export function auditAuthMailToml(toml: string): AuthMailAudit {
  const enabled = (section: string, key: string): string | null => {
    const header = `[${section}]`;
    const start = toml.indexOf(header);
    if (start === -1) return null;
    const rest = toml.slice(start + header.length);
    const end = rest.search(/\n\s*\[/);
    const body = end === -1 ? rest : rest.slice(0, end);
    const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m"));
    return match ? (match[1] ?? "").trim() : null;
  };

  const confirmations = enabled("auth.email", "enable_confirmations") === "true";
  const smtp = enabled("auth.email.smtp", "enabled") === "true";
  const isPublic = (u: string | null): boolean => Boolean(u && !/127\.0\.0\.1|localhost/.test(u));
  // A link is public if the base it's built from is public. Two shapes qualify:
  // GoTrue's default template + a public api.external_url, OR a SiteURL template
  // (the shape this module writes) + a public site_url. The latter is preferred
  // because a public api.external_url breaks `supabase start` (see module doc).
  const externalUrl = enabled("api", "external_url");
  const siteUrl = enabled("auth", "site_url");
  const hasConfirmTemplate = tomlHasSection(toml, "auth.email.template.confirmation");
  const links = isPublic(externalUrl) || (isPublic(siteUrl) && hasConfirmTemplate);

  const warnings: string[] = [];
  if (!confirmations) {
    warnings.push(
      "Signup confirmation email is off (auth.email.enable_confirmations). GoTrue auto-confirms new " +
        "users and sends nothing — set it to true if this app is meant to email people on signup."
    );
  }
  if (!smtp) warnings.push("GoTrue SMTP is not enabled in config.toml — auth mail cannot be sent.");
  if (!links) {
    warnings.push(
      "Auth email links would be dead in the inbox — set site_url to the public domain and enable " +
        "email so a SiteURL confirmation template is written, or the links point at 127.0.0.1."
    );
  }
  return {
    signup_confirmation_email: confirmations,
    smtp_configured: smtp,
    public_links: links,
    warnings
  };
}

/**
 * Extra env for `supabase start`, so the CLI can resolve the `env(...)` call in
 * `[auth.email.smtp] pass`. Kept out of the project clone deliberately: the
 * relay password lives in the encrypted settings table, and a deploy hard-resets
 * a clone anyway. Empty when no SMTP password is configured, which leaves the
 * stack exactly as it was.
 */
export function supabaseStartEnv(ctx: AppContext): Record<string, string> {
  const pass = getSecretSetting(ctx, "smtp_password");
  return pass ? { [SMTP_PASS_ENV_KEY]: pass } : {};
}

/**
 * Read what a stack's on-disk config.toml currently does with auth mail, or
 * null when it has no config.toml yet. Backs the Email tab's per-stack state so
 * the confirmation toggle can render its real position.
 */
export function readStackAuthMailAudit(workdir: string): AuthMailAudit | null {
  try {
    const toml = fs.readFileSync(path.join(workdir, "supabase", "config.toml"), "utf8");
    return auditAuthMailToml(toml);
  } catch {
    return null;
  }
}

/**
 * Flip `[auth.email] enable_confirmations` on a stack's config.toml.
 *
 * Deliberately separate from applyAuthMailToToml: whether signup mails a
 * confirmation step is a product decision, so it is only ever changed by an
 * explicit operator action, never as a side effect of enabling SMTP. Same
 * on-disk, restart-to-apply contract as patchStackAuthMail — `supabase start`
 * reads the file, so a running stack keeps its old GoTrue env until restarted.
 */
export function setStackEmailConfirmations(workdir: string, enabled: boolean): AuthMailPatchResult {
  const configPath = path.join(workdir, "supabase", "config.toml");
  try {
    const before = fs.readFileSync(configPath, "utf8");
    const after = setTomlValues(before, [
      { section: "auth.email", key: "enable_confirmations", value: enabled }
    ]);
    if (after !== before) {
      fs.writeFileSync(`${configPath}.bak-email`, before, "utf8");
      fs.writeFileSync(configPath, after, "utf8");
    }
    return { workdir, changed: after !== before, audit: auditAuthMailToml(after) };
  } catch (error) {
    return {
      workdir,
      changed: false,
      audit: { signup_confirmation_email: false, smtp_configured: false, public_links: false, warnings: [] },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export type ProjectSupabaseStack = {
  resource_id: string;
  service_id: string;
  name: string;
  workdir: string;
  /** null when the app has no public domain yet — nothing sensible to mail. */
  public_origin: string | null;
};

/**
 * Supabase stacks a project's services are actively linked to, with the public
 * origin their auth endpoints are reachable on.
 */
export function projectSupabaseStacks(ctx: AppContext, projectId: string): ProjectSupabaseStack[] {
  const rows = ctx.db
    .prepare(
      `SELECT mr.id AS resource_id, l.service_id, mr.name, mr.config_json
         FROM service_resource_links l
         JOIN managed_resources mr ON mr.id = l.resource_id
         JOIN services s ON s.id = l.service_id
        WHERE l.active = 1 AND mr.profile = 'supabase' AND s.project_id = ?`
    )
    .all(projectId) as Array<{
    resource_id: string;
    service_id: string;
    name: string;
    config_json: string | null;
  }>;

  const stacks = new Map<string, ProjectSupabaseStack>();
  for (const row of rows) {
    let workdir = "";
    try {
      const config = JSON.parse(row.config_json ?? "{}") as { workdir?: unknown };
      workdir = typeof config.workdir === "string" ? config.workdir : "";
    } catch {
      /* unparseable config → treated as no workdir below */
    }
    if (!workdir) continue;
    // One entry per stack: several services can link the same one, and patching
    // its config.toml twice would be pointless (and log a phantom second change).
    if (stacks.has(row.resource_id)) continue;
    stacks.set(row.resource_id, {
      resource_id: row.resource_id,
      service_id: row.service_id,
      name: row.name,
      workdir,
      public_origin: publicOriginForLinkedResource(ctx, row.service_id, row.resource_id, "supabase")
    });
  }
  return Array.from(stacks.values());
}

export type AuthMailPatchResult = {
  workdir: string;
  changed: boolean;
  audit: AuthMailAudit;
  error?: string;
};

/**
 * Apply the block to a stack's config.toml on disk, backing the previous file up
 * once per change. Never throws: a stack we cannot patch is reported, so
 * enabling email for a project with several backends still fixes the others.
 */
export function patchStackAuthMail(
  workdir: string,
  publicOrigin: string,
  smtp: AuthMailSmtp
): AuthMailPatchResult {
  const configPath = path.join(workdir, "supabase", "config.toml");
  try {
    const before = fs.readFileSync(configPath, "utf8");
    const after = applyAuthMailToToml(before, publicOrigin, smtp);
    // The config references SiteURL templates; write the files it points at (a
    // no-op for any the operator already has), so GoTrue can actually fetch them.
    writeDefaultAuthMailTemplates(workdir);
    if (after !== before) {
      fs.writeFileSync(`${configPath}.bak-email`, before, "utf8");
      fs.writeFileSync(configPath, after, "utf8");
    }
    return { workdir, changed: after !== before, audit: auditAuthMailToml(after) };
  } catch (error) {
    return {
      workdir,
      changed: false,
      audit: {
        signup_confirmation_email: false,
        smtp_configured: false,
        public_links: false,
        warnings: []
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
