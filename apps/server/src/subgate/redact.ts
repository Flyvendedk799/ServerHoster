/**
 * Credential scrubbing.
 *
 * Every string that can reach a client, a log line, or an audit row goes
 * through `redact()` first. This is the last line of defence behind
 * §7 "never leak" — the code should never hand a credential to an error
 * message in the first place, but upstream SDKs and Node itself happily
 * echo request headers into thrown errors, so we scrub unconditionally.
 *
 * Two mechanisms, deliberately both:
 *   1. An explicit registry — anything the gateway *knows* is a credential
 *      (provider API keys, consumer tokens) is registered at load time and
 *      replaced by exact match.
 *   2. Shape patterns — credential formats we may never have been handed
 *      directly (an upstream echoing a key we didn't configure, a JWT in a
 *      proxied error body).
 *
 * Framework-free: no imports. Part of the portable core.
 */

const registered = new Set<string>();

/** Anything shorter than this is too generic to mask without eating real text. */
const MIN_SECRET_LENGTH = 12;

export const REDACTED = "[redacted]";

/**
 * Register a value as a credential. Idempotent. Values shorter than
 * MIN_SECRET_LENGTH are ignored — masking them would corrupt ordinary prose.
 */
export function registerSecret(value: string | null | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  registered.add(trimmed);
}

/** Drop a value from the registry (e.g. after a consumer token is revoked). */
export function forgetSecret(value: string | null | undefined): void {
  if (!value) return;
  registered.delete(value.trim());
}

/** Test seam — clears the registry between test cases. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/**
 * Credential shapes. Ordered longest-prefix-first so `sk-ant-…` is consumed by
 * its own rule rather than half-matched by the generic `sk-` rule.
 */
const PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  // OpenAI API keys (incl. project/service-account variants sk-proj-, sk-svcacct-)
  /sk-(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{20,}/g,
  // SubGate consumer tokens
  /sgk_[A-Za-z0-9_-]{16,}/g,
  // Anything shaped like a JWT (OAuth access tokens, Supabase keys)
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // `Authorization: Bearer <anything>` — catches formats we don't recognise
  /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi,
  // Header-cased API key fields in serialised request dumps
  /(x-api-key\s*[:=]\s*)\S+/gi
];

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub credentials from an arbitrary value and return a safe string.
 *
 * Non-string input is JSON-stringified first (falling back to String()) so
 * error objects and response bodies can be passed straight in.
 */
export function redact(input: unknown): string {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Error) {
    text = input.stack ?? `${input.name}: ${input.message}`;
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }

  // Exact registered values first — these are certain, patterns are heuristic.
  for (const secret of registered) {
    if (text.includes(secret)) {
      text = text.split(secret).join(REDACTED);
    }
  }

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, ...groups) => {
      // The `authorization:`/`x-api-key:` rules capture the field name so it
      // survives; everything after it is replaced.
      const prefix = typeof groups[0] === "string" ? groups[0] : "";
      return prefix ? `${prefix}${REDACTED}` : REDACTED;
    });
  }

  return text;
}

/**
 * True when `text` still contains any registered credential. Used by the
 * never-leak test suite to assert on real responses rather than trusting
 * that every call site remembered to redact.
 */
export function containsRegisteredSecret(text: string): boolean {
  for (const secret of registered) {
    if (text.includes(secret)) return true;
  }
  return false;
}

/**
 * Mask for display: first two and last two characters, middle elided.
 * Mirrors ServerHoster's `maskSecret` so the two surfaces agree, but lives
 * here to keep the core free of app imports.
 */
export function maskCredential(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/**
 * Redact a value and additionally scrub the literal `extra` strings. Used when
 * a credential is in scope locally but was never registered globally (e.g. a
 * token being minted, which must not be registered because it is returned to
 * the caller exactly once).
 */
export function redactWith(input: unknown, extra: Array<string | null | undefined>): string {
  let text = redact(input);
  for (const value of extra) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    text = text.replace(new RegExp(escapeForRegex(value), "g"), REDACTED);
  }
  return text;
}
