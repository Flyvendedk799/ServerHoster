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
  /** The app's own name — the From name an app gets when it has none of its own. */
  projectName?: string | null;
};

function clean(value: string | null | undefined): string {
  return (value && value.trim()) || "";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).replace(/>.*$/, "").trim().toLowerCase();
}

/**
 * True when a project's stored From name is just the global default copied in
 * at enable time, not a name chosen for this app: it equals the default name
 * while the app sends from a different domain than the default address.
 *
 * Enabling email used to seed every app with the global smtp_from_name, so the
 * first app's brand ("MetaView") ended up as the GoTrue sender_name of
 * unrelated apps (Awaire, mailing from awaire.dk). Such a name is treated as
 * unset, so the app falls back to its own name.
 */
export function isInheritedDefaultFromName(input: {
  fromName?: string | null;
  from?: string | null;
  defaultFrom?: string | null;
  defaultFromName?: string | null;
}): boolean {
  const name = clean(input.fromName);
  const defaultName = clean(input.defaultFromName);
  if (!name || !defaultName || name !== defaultName) return false;
  const appDomain = domainOf(clean(input.from));
  const defaultDomain = domainOf(clean(input.defaultFrom));
  return Boolean(appDomain && defaultDomain && appDomain !== defaultDomain);
}

/**
 * Resolve From + From name for a project that has (or is getting) email.
 *
 * Precedence for `from`:
 *   non-empty explicit → existing project value → global default
 *
 * Precedence for `fromName`:
 *   explicit (including empty, so the UI can clear a display name) →
 *   existing project value (unless it is the inherited global default, see
 *   isInheritedDefaultFromName) → the app's own name → global default
 *
 * Omitting `fromName` on apply must NOT wipe a custom project name by falling
 * straight through to the global default — that was how every "Update" from the
 * old UI (which never sent fromName) re-shared branding across apps. Likewise a
 * new enable takes the app's own name, not another app's brand.
 */
export function resolveEmailBranding(input: ResolveEmailBrandingInput): EmailBranding {
  const from = clean(input.from) || clean(input.existingFrom) || clean(input.defaultFrom);

  let fromName: string;
  if (input.fromName !== undefined && input.fromName !== null) {
    fromName = input.fromName.trim();
  } else {
    const existing = clean(input.existingFromName);
    const inherited = isInheritedDefaultFromName({
      fromName: existing,
      from,
      defaultFrom: input.defaultFrom,
      defaultFromName: input.defaultFromName
    });
    fromName =
      (existing && !inherited ? existing : "") || clean(input.projectName) || clean(input.defaultFromName);
  }

  return { from, fromName };
}
