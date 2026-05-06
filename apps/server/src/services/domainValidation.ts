import dns from "node:dns/promises";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

/**
 * Sequence 3 — domain ownership / validation workflow.
 *
 * Two complementary checks live here:
 *
 *   1. Pre-bind validation: before the operator wires a domain to a service,
 *      we resolve A / AAAA records and report whether they point at this
 *      host. This is the single piece of advice that catches 90% of failed
 *      first-time SSL provisions ("DNS is parked at GoDaddy").
 *
 *   2. Ownership token issuance: optional, used by anyone who wants to
 *      prove control of a domain before exposing it. We generate a sentinel
 *      token, expect it back via either a DNS TXT record or an
 *      `/.well-known/localsurv-ownership/<token>` HTTP path served by
 *      LocalSURV's proxy, and store the verified-at timestamp in the
 *      `settings` table under `domain_ownership.<domain>`.
 *
 * Diagnostics are surfaced via the routes layer, so the dashboard can show
 * actionable suggestions instead of raw resolver errors.
 */

export type DomainDiagnostics = {
  domain: string;
  resolvable: boolean;
  pointsToHost: boolean | null;
  resolvedAddresses: string[];
  expectedAddresses: string[];
  hint: string;
  checkedAt: string;
};

export async function diagnoseDomain(
  domain: string,
  expectedAddresses: string[]
): Promise<DomainDiagnostics> {
  const trimmed = domain.trim().toLowerCase();
  const result: DomainDiagnostics = {
    domain: trimmed,
    resolvable: false,
    pointsToHost: null,
    resolvedAddresses: [],
    expectedAddresses,
    hint: "",
    checkedAt: nowIso()
  };
  if (!isValidDomain(trimmed)) {
    result.hint = "Invalid domain name. Expected something like example.com or app.example.com.";
    return result;
  }
  try {
    const v4 = await dns.resolve4(trimmed).catch(() => [] as string[]);
    const v6 = await dns.resolve6(trimmed).catch(() => [] as string[]);
    result.resolvedAddresses = [...v4, ...v6];
    result.resolvable = result.resolvedAddresses.length > 0;
  } catch (error) {
    result.hint = `DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }
  if (!result.resolvable) {
    result.hint = `No A/AAAA records found for ${trimmed}. Add a record pointing at this host before deploying SSL.`;
    return result;
  }
  if (expectedAddresses.length === 0) {
    // No expected addresses provided — we can only confirm it resolves.
    result.pointsToHost = null;
    result.hint = "Domain resolves. Set expectedAddresses to verify it points at this host.";
    return result;
  }
  const expectedSet = new Set(expectedAddresses);
  result.pointsToHost = result.resolvedAddresses.some((a) => expectedSet.has(a));
  if (result.pointsToHost) {
    result.hint = "Domain resolves to this host. SSL provisioning should succeed.";
  } else {
    result.hint = `Domain resolves to ${result.resolvedAddresses.join(", ")} but this host expects ${expectedAddresses.join(", ")}. Update DNS before retrying SSL.`;
  }
  return result;
}

export function isValidDomain(value: string): boolean {
  // RFC 1035-ish: labels of 1-63 chars made of [A-Za-z0-9-], full length <=253.
  if (!value || value.length > 253) return false;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    value
  );
}

/**
 * Issue (or refresh) an ownership token for `domain`. Returns the token
 * and the two challenge formats the operator can satisfy.
 */
export function issueOwnershipToken(
  ctx: AppContext,
  domain: string
): { domain: string; token: string; dnsRecord: string; httpPath: string } {
  const token = nanoid(24);
  ctx.db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(`domain_ownership_token.${domain}`, token, token);
  return {
    domain,
    token,
    dnsRecord: `_localsurv-ownership.${domain} TXT "${token}"`,
    httpPath: `/.well-known/localsurv-ownership/${token}`
  };
}

export async function verifyOwnership(
  ctx: AppContext,
  domain: string
): Promise<{ verified: boolean; via: "dns" | "http" | null; checkedAt: string; hint: string }> {
  const token = (
    ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(`domain_ownership_token.${domain}`) as
      | { value: string }
      | undefined
  )?.value;
  if (!token) {
    return {
      verified: false,
      via: null,
      checkedAt: nowIso(),
      hint: "No ownership token issued. Call issueOwnershipToken first."
    };
  }
  // DNS check first.
  try {
    const records = await dns.resolveTxt(`_localsurv-ownership.${domain}`);
    if (records.some((r) => r.join("").trim() === token)) {
      ctx.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
        .run(`domain_ownership_verified.${domain}`, nowIso(), nowIso());
      return { verified: true, via: "dns", checkedAt: nowIso(), hint: "Verified via DNS TXT record." };
    }
  } catch {
    /* fall through to HTTP */
  }
  // HTTP fallback (works only if the proxy is reachable on the domain).
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(`http://${domain}/.well-known/localsurv-ownership/${token}`, {
      signal: ac.signal
    });
    clearTimeout(t);
    if (res.ok) {
      const body = (await res.text()).trim();
      if (body === token) {
        ctx.db
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
          .run(`domain_ownership_verified.${domain}`, nowIso(), nowIso());
        return { verified: true, via: "http", checkedAt: nowIso(), hint: "Verified via HTTP challenge." };
      }
    }
  } catch {
    /* ignored */
  }
  return {
    verified: false,
    via: null,
    checkedAt: nowIso(),
    hint: "No matching DNS TXT record and HTTP challenge did not echo the token. Try again after DNS propagates."
  };
}
