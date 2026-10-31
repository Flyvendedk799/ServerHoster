/**
 * Per-app email branding (From address + From name).
 *
 * Transport (host/port/user/password) stays shared on the Email tab. Branding
 * is per project: each enabled app stores SMTP_FROM / SMTP_FROM_NAME in
 * project_env_vars. The global smtp_from / smtp_from_name settings remain as a
 * fallback for new enables, SMTP test sends, and platform mail that isn't tied
 * to an app — that is the migration path for existing installs that only had
 * the shared values.
 */

export type EmailBranding = {
  from: string;
  fromName: string;
};

export type ResolveEmailBrandingInput = {
  /** Explicit override from the Email tab apply body. `undefined` = omitted. */
  from?: string | null;
  fromName?: string | null;
  /** Already stored on the project (SMTP_FROM / SMTP_FROM_NAME). */
  existingFrom?: string | null;
  existingFromName?: string | null;
  /** Global smtp_from / smtp_from_name fallback. */
  defaultFrom?: string | null;
  defaultFromName?: string | null;
};

/**
 * Resolve From + From name for a project that has (or is getting) email.
 *
 * Precedence for `from`:
 *   non-empty explicit → existing project value → global default
 *
 * Precedence for `fromName`:
 *   explicit (including empty, so the UI can clear a display name) →
 *   existing project value → global default
 *
 * Omitting `fromName` on apply must NOT wipe a custom project name by falling
 * straight through to the global default — that was how every "Update" from the
 * old UI (which never sent fromName) re-shared branding across apps.
 */
export function resolveEmailBranding(input: ResolveEmailBrandingInput): EmailBranding {
  const from =
    (input.from && input.from.trim()) ||
    (input.existingFrom && input.existingFrom.trim()) ||
    (input.defaultFrom && input.defaultFrom.trim()) ||
    "";

  let fromName: string;
  if (input.fromName !== undefined && input.fromName !== null) {
    fromName = input.fromName.trim();
  } else {
    fromName =
      (input.existingFromName && input.existingFromName.trim()) ||
      (input.defaultFromName && input.defaultFromName.trim()) ||
      "";
  }

  return { from, fromName };
}
