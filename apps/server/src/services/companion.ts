import crypto from "node:crypto";
import os from "node:os";
import { nanoid } from "nanoid";
import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";

/**
 * Companion pairing — how a phone gets a token for this control plane.
 *
 * The operator is already authenticated on the desktop dashboard. They mint a
 * short-lived *pairing code* there (rendered as a QR); the phone posts that
 * code to `/companion/pair/claim` and gets back a long-lived *device token*.
 *
 * Two properties matter and shape everything below:
 *
 *  1. The claim endpoint is unauthenticated by necessity — the phone has no
 *     credential yet. So the code is short-lived (5 min), single-use, attempt
 *     capped per caller, and rate limited at the route. Lookup is by SHA-256
 *     hash, so the code itself is never compared byte by byte.
 *  2. A phone is a device that gets lost on a bus. Its token is therefore
 *     *scoped* to an explicit allowlist on both reads and writes: it sees fleet
 *     state and service logs and can press start/stop/restart/redeploy, and
 *     nothing else reaches it — no secrets, no env, no database contents, no
 *     terminal, no backup, no second pairing. See `companionRequestAllowed`.
 *
 * Only the SHA-256 hash of a code or token is persisted, so a stolen database
 * file does not yield working credentials.
 */

/** Excludes I/L/O/0/1/U — misread on a screen, mistyped from a photo. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60 * 1000;

/** One year. Long-lived on purpose: re-pairing from a bus is not an option. */
const DEVICE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type CompanionScope = "read" | "control";

export type CompanionDevice = {
  id: string;
  name: string;
  platform: string | null;
  scope: CompanionScope;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: number;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
  revokedAt: string | null;
};

type DeviceRow = {
  id: string;
  name: string;
  platform: string | null;
  scope: string;
  token_prefix: string;
  created_at: string;
  expires_at: number;
  last_seen_at: string | null;
  last_seen_ip: string | null;
  revoked_at: string | null;
};

type PairingRow = {
  id: string;
  code_hash: string;
  scope: string;
  label: string | null;
  server_url: string;
  expires_at: number;
  attempts: number;
  claimed_at: string | null;
  device_id: string | null;
  created_at: string;
};

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeScope(value: unknown): CompanionScope {
  return value === "read" ? "read" : "control";
}

/** `ABCD-EFGH`. The dash is cosmetic — `normalizePairingCode` strips it back out. */
function generatePairingCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Accept what a human actually types: lowercase, spaces, a missing or extra
 * dash. Anything outside `[A-Z0-9]` is noise from the keyboard, not signal.
 */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function rowToDevice(row: DeviceRow): CompanionDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    scope: normalizeScope(row.scope),
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    lastSeenIp: row.last_seen_ip,
    revokedAt: row.revoked_at
  };
}

// --- Device tokens ---------------------------------------------------------

/**
 * Resolve a bearer token to a live companion device, or null. Deliberately
 * cheap and side-effect free apart from the expiry sweep — it runs on every
 * request through the auth hook.
 */
export function resolveCompanionDevice(ctx: AppContext, token: string): CompanionDevice | null {
  if (!token) return null;
  const row = ctx.db
    .prepare("SELECT * FROM companion_devices WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(sha256(token), Date.now()) as DeviceRow | undefined;
  return row ? rowToDevice(row) : null;
}

export function isCompanionToken(ctx: AppContext, token: string): boolean {
  return resolveCompanionDevice(ctx, token) !== null;
}

/**
 * Record that a device is alive. Throttled to once a minute: the mobile app
 * polls, and a write per poll would turn the dashboard's "last seen" column
 * into a hot write path on a Raspberry Pi's SD card.
 */
export function touchCompanionDevice(ctx: AppContext, deviceId: string, ip: string | null): void {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  ctx.db
    .prepare(
      "UPDATE companion_devices SET last_seen_at = ?, last_seen_ip = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)"
    )
    .run(nowIso(), ip, deviceId, cutoff);
}

export function listCompanionDevices(ctx: AppContext): CompanionDevice[] {
  const rows = ctx.db
    .prepare("SELECT * FROM companion_devices WHERE revoked_at IS NULL ORDER BY created_at DESC")
    .all() as DeviceRow[];
  return rows.map(rowToDevice);
}

export function revokeCompanionDevice(ctx: AppContext, deviceId: string): boolean {
  const result = ctx.db
    .prepare("UPDATE companion_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(nowIso(), deviceId);
  return result.changes > 0;
}

// --- Pairing ---------------------------------------------------------------

export type PairingRecord = {
  id: string;
  code: string;
  scope: CompanionScope;
  label: string | null;
  serverUrl: string;
  expiresAt: number;
};

export function createPairing(
  ctx: AppContext,
  input: { scope?: CompanionScope; label?: string | null; serverUrl: string }
): PairingRecord {
  const id = nanoid();
  const code = generatePairingCode();
  const scope = normalizeScope(input.scope);
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  ctx.db
    .prepare(
      `INSERT INTO companion_pairings (id, code_hash, scope, label, server_url, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      id,
      sha256(normalizePairingCode(code)),
      scope,
      input.label ?? null,
      input.serverUrl,
      expiresAt,
      nowIso()
    );
  cleanupExpiredPairings(ctx);
  return { id, code, scope, label: input.label ?? null, serverUrl: input.serverUrl, expiresAt };
}

export type PairingStatus = {
  id: string;
  status: "pending" | "claimed" | "expired";
  scope: CompanionScope;
  serverUrl: string;
  expiresAt: number;
  device: CompanionDevice | null;
  /**
   * Wrong codes submitted while this pairing was live. A stray one or two is a
   * typo; a wall of them means someone is guessing, and since a guesser can no
   * longer kill the code themselves, the operator is the one who decides to
   * cancel. That only works if the number is on screen.
   */
  failedAttempts: number;
};

export function getPairingStatus(ctx: AppContext, pairingId: string): PairingStatus | null {
  const row = ctx.db.prepare("SELECT * FROM companion_pairings WHERE id = ?").get(pairingId) as
    | PairingRow
    | undefined;
  if (!row) return null;
  const device = row.device_id
    ? ((ctx.db.prepare("SELECT * FROM companion_devices WHERE id = ?").get(row.device_id) as
        | DeviceRow
        | undefined) ?? null)
    : null;
  const status = row.claimed_at ? "claimed" : row.expires_at <= Date.now() ? "expired" : "pending";
  return {
    id: row.id,
    status,
    scope: normalizeScope(row.scope),
    serverUrl: row.server_url,
    expiresAt: row.expires_at,
    device: device ? rowToDevice(device) : null,
    failedAttempts: row.attempts
  };
}

export function cancelPairing(ctx: AppContext, pairingId: string): boolean {
  const result = ctx.db
    .prepare("DELETE FROM companion_pairings WHERE id = ? AND claimed_at IS NULL")
    .run(pairingId);
  return result.changes > 0;
}

export function cleanupExpiredPairings(ctx: AppContext): void {
  // Keep claimed rows for an hour so the desktop's "phone connected" poll can
  // still resolve after the code's own TTL has passed.
  ctx.db
    .prepare("DELETE FROM companion_pairings WHERE claimed_at IS NULL AND expires_at <= ?")
    .run(Date.now());
  ctx.db
    .prepare("DELETE FROM companion_pairings WHERE claimed_at IS NOT NULL AND expires_at <= ?")
    .run(Date.now() - 60 * 60 * 1000);
}

export class PairingError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "PairingError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type ClaimResult = {
  token: string;
  device: CompanionDevice;
  serverUrl: string;
  server: { name: string; platform: string };
};

/**
 * Wrong guesses are charged to the *caller*, never to the pairing.
 *
 * The obvious design — five bad attempts and the code dies — hands anyone who
 * can reach this endpoint a button that destroys the operator's in-flight QR,
 * and the endpoint is unauthenticated by necessity. Five junk codes and the
 * pairing on screen is dead; repeat and pairing becomes impossible. So a miss
 * costs the caller their own budget, the pairing survives, and the failure
 * count is surfaced on the pairing status so a human can decide to cancel.
 *
 * Kept in memory deliberately: the window is no longer than the code's own
 * 5-minute TTL, so a restart cannot hand an attacker more reach than simply
 * waiting would have.
 */
const CLAIM_FAILURE_WINDOW_MS = 5 * 60 * 1000;
/**
 * Deliberately below the route's 10-per-minute rate limit. The two controls
 * bound different things — the rate limit stops a burst, this stops sustained
 * guessing across minutes — and keeping this the tighter of the two means a
 * guesser meets `PAIRING_LOCKED`, which the app can explain, rather than a bare
 * "too many requests".
 */
const MAX_CLAIM_FAILURES_PER_CALLER = 8;

type FailureBucket = { count: number; resetAt: number };
const claimFailures = new Map<string, FailureBucket>();

function callerBucket(caller: string, now: number): FailureBucket {
  const existing = claimFailures.get(caller);
  if (existing && existing.resetAt > now) return existing;
  const fresh: FailureBucket = { count: 0, resetAt: now + CLAIM_FAILURE_WINDOW_MS };
  claimFailures.set(caller, fresh);
  return fresh;
}

/** Swept only when the map has grown, so a spray of forged callers cannot leak it. */
function pruneClaimFailures(now: number): void {
  if (claimFailures.size < 1000) return;
  for (const [key, bucket] of claimFailures) {
    if (bucket.resetAt <= now) claimFailures.delete(key);
  }
}

/** Test seam — the buckets are process-global, so cases would bleed into each other. */
export function resetClaimFailures(): void {
  claimFailures.clear();
}

/**
 * Exchange a pairing code for a device token. Single-use: the row is marked
 * claimed inside the same transaction that mints the device, so two phones
 * racing on the same photographed QR cannot both win.
 *
 * `caller` identifies who is guessing — `req.ip`, which is only meaningful if
 * the app trusts its proxy (see `config.trustProxy`).
 */
export function claimPairing(
  ctx: AppContext,
  input: { code: string; deviceName: string; platform?: string | null; caller: string }
): ClaimResult {
  const now = Date.now();
  pruneClaimFailures(now);
  const bucket = callerBucket(input.caller, now);
  if (bucket.count >= MAX_CLAIM_FAILURES_PER_CALLER) {
    throw new PairingError("Too many failed attempts from this device", 429, "PAIRING_LOCKED");
  }
  cleanupExpiredPairings(ctx);
  const codeHash = sha256(normalizePairingCode(input.code));
  const row = ctx.db.prepare("SELECT * FROM companion_pairings WHERE code_hash = ?").get(codeHash) as
    | PairingRow
    | undefined;

  if (!row) {
    bucket.count += 1;
    // Record the miss against every live pairing as a signal for the operator —
    // the dashboard renders it next to the QR — but never act on it. Acting on
    // it is precisely the denial of service this counter used to be.
    ctx.db
      .prepare(
        "UPDATE companion_pairings SET attempts = attempts + 1 WHERE claimed_at IS NULL AND expires_at > ?"
      )
      .run(now);
    throw new PairingError("Invalid or expired pairing code", 401, "PAIRING_INVALID");
  }
  if (row.claimed_at) throw new PairingError("Pairing code already used", 409, "PAIRING_USED");
  if (row.expires_at <= now) throw new PairingError("Pairing code expired", 410, "PAIRING_EXPIRED");

  // The right code clears the caller's budget: a fat-fingered operator who
  // finally types it correctly should not stay locked out of their next pairing.
  claimFailures.delete(input.caller);

  const token = nanoid(48);
  const deviceId = nanoid();
  const createdAt = nowIso();
  const expiresAt = now + DEVICE_TOKEN_TTL_MS;
  const name = input.deviceName.trim().slice(0, 60) || "Phone";
  const platform = input.platform?.trim().slice(0, 60) || null;

  const commit = ctx.db.transaction(() => {
    // Re-check inside the transaction: this is the row that makes the claim
    // single-use, so the guard has to run under the same lock as the write.
    const claimed = ctx.db
      .prepare(
        "UPDATE companion_pairings SET claimed_at = ?, device_id = ? WHERE id = ? AND claimed_at IS NULL"
      )
      .run(createdAt, deviceId, row.id);
    if (claimed.changes === 0) throw new PairingError("Pairing code already used", 409, "PAIRING_USED");
    ctx.db
      .prepare(
        `INSERT INTO companion_devices
           (id, name, platform, token_hash, token_prefix, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(deviceId, name, platform, sha256(token), token.slice(0, 6), row.scope, createdAt, expiresAt);
  });
  commit();

  const device = ctx.db.prepare("SELECT * FROM companion_devices WHERE id = ?").get(deviceId) as DeviceRow;
  return {
    token,
    device: rowToDevice(device),
    serverUrl: row.server_url,
    server: { name: serverDisplayName(ctx), platform: os.platform() }
  };
}

export function serverDisplayName(ctx: AppContext): string {
  const configured = (
    ctx.db.prepare("SELECT value FROM settings WHERE key = 'instance_name'").get() as
      | { value?: string }
      | undefined
  )?.value;
  return configured?.trim() || os.hostname();
}

// --- Scope enforcement -----------------------------------------------------

/**
 * Endpoints a `control`-scoped device may POST to. Everything not listed is
 * refused — an allowlist, because the failure mode of a forgotten denylist
 * entry is a lost phone deleting a production service.
 */
const CONTROL_WRITE_PATTERNS: RegExp[] = [
  /^\/services\/[^/]+\/(start|stop|restart|force-restart|redeploy)$/,
  /^\/projects\/[^/]+\/(start-all|stop-all|restart-all|deploy-all)$/,
  /^\/service-groups\/[^/]+\/(start-all|stop-all|restart-all)$/,
  /^\/databases\/[^/]+\/(start|stop|restart)$/,
  /^\/deployments\/rollback$/,
  /^\/notifications\/[^/]+\/read$/,
  /^\/notifications\/read-all$/
];

/**
 * Reads a companion device may perform. An allowlist for the same reason the
 * write list is one, and the reason is not symmetry — it is that a denylist
 * widens the phone's reach every time someone adds a route, silently and in a
 * commit that has nothing to do with pairing.
 *
 * The first draft of this file used a denylist. It named `/secrets`, `/backup`
 * and `/services/:id/env`, and it looked complete. It still handed a paired
 * phone `/databases/:id` (every managed database's password, in the clear),
 * `/databases/:id/tables/:schema/:table/preview` (any row of any table) and
 * `/databases/:id/backups/:backupId/download` (the whole dump), because none
 * of those paths start with `/backup` or end in `/env`.
 *
 * `/services/:id/logs` IS on this list, deliberately. Reading logs from a phone
 * is the app's reason to exist, and logs are the one allowed surface that can
 * carry a secret — not because the control plane leaks it, but because an
 * application printed it. That trade-off is stated in docs/companion-app.md
 * where an operator will see it, rather than buried here.
 */
const READ_ALLOW_PATTERNS: RegExp[] = [
  // The app's own surface. `/companion/summary` is the aggregate the home
  // screen loads; it selects named columns, so it cannot grow a secret the way
  // a `SELECT *` route can.
  /^\/companion\/(summary|me)$/,
  // Fleet state. Rows in `services` and `projects` carry no credentials — env
  // lives in its own table behind /services/:id/env, which is not on this list.
  /^\/services$/,
  // `/services/:id` — but not the sibling collection route
  // `/services/env-requirements`, which reports which variables a service is
  // missing and is not something any companion screen asks for.
  /^\/services\/(?!env-requirements$)[^/]+$/,
  /^\/services\/[^/]+\/logs$/,
  /^\/services\/[^/]+\/deployments\/timeline$/,
  /^\/services\/[^/]+\/github-sync-status$/,
  /^\/projects$/,
  /^\/service-groups$/,
  /^\/notifications$/,
  // Host vitals behind the home screen's header.
  /^\/health$/,
  /^\/health\/(system|docker)$/,
  /^\/metrics\/system$/,
  /^\/metrics\/services(\/[^/]+)?$/
];

/**
 * Requests a device may make about *itself*, at any scope. Checking in and —
 * above all — revoking itself must not depend on holding `control`: a read-only
 * phone left in a taxi is precisely the case where "forget this server" has to
 * work from the phone.
 */
const SELF_SERVICE_PATTERN = /^\/companion\/(heartbeat|unpair)$/;

/**
 * The authorization decision for a companion device token. `path` must already
 * have its query string stripped — the auth hook does this in `requestPath`.
 */
export function companionRequestAllowed(scope: CompanionScope, method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "POST" && SELF_SERVICE_PATTERN.test(path)) return true;
  if (verb === "GET" || verb === "HEAD") {
    return READ_ALLOW_PATTERNS.some((re) => re.test(path));
  }
  if (scope !== "control") return false;
  return CONTROL_WRITE_PATTERNS.some((re) => re.test(path));
}
