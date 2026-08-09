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
 *     capped, rate limited at the route, and compared in constant time.
 *  2. A phone is a device that gets lost on a bus. Its token is therefore
 *     *scoped*: it can look at the fleet and press start/stop/restart/redeploy,
 *     but it can never read secrets, open a terminal, delete a service, export
 *     a backup, or mint another pairing code. See `companionRequestAllowed`.
 *
 * Only the SHA-256 hash of a code or token is persisted, so a stolen database
 * file does not yield working credentials.
 */

/** Excludes I/L/O/0/1/U — misread on a screen, mistyped from a photo. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = 5;

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
    device: device ? rowToDevice(device) : null
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
 * Exchange a pairing code for a device token. Single-use: the row is marked
 * claimed inside the same transaction that mints the device, so two phones
 * racing on the same photographed QR cannot both win.
 */
export function claimPairing(
  ctx: AppContext,
  input: { code: string; deviceName: string; platform?: string | null }
): ClaimResult {
  cleanupExpiredPairings(ctx);
  const codeHash = sha256(normalizePairingCode(input.code));
  const row = ctx.db.prepare("SELECT * FROM companion_pairings WHERE code_hash = ?").get(codeHash) as
    | PairingRow
    | undefined;

  // Burn an attempt against every live pairing on a miss, so a guesser cannot
  // learn anything from the shape of the failure. There is normally at most
  // one live pairing, so this is a no-op in practice.
  if (!row) {
    ctx.db
      .prepare(
        "UPDATE companion_pairings SET attempts = attempts + 1 WHERE claimed_at IS NULL AND expires_at > ?"
      )
      .run(Date.now());
    ctx.db
      .prepare("DELETE FROM companion_pairings WHERE claimed_at IS NULL AND attempts >= ?")
      .run(MAX_CLAIM_ATTEMPTS);
    throw new PairingError("Invalid or expired pairing code", 401, "PAIRING_INVALID");
  }
  if (row.claimed_at) throw new PairingError("Pairing code already used", 409, "PAIRING_USED");
  if (row.expires_at <= Date.now()) throw new PairingError("Pairing code expired", 410, "PAIRING_EXPIRED");
  if (row.attempts >= MAX_CLAIM_ATTEMPTS) {
    throw new PairingError("Too many failed attempts for this code", 429, "PAIRING_LOCKED");
  }

  const token = nanoid(48);
  const deviceId = nanoid();
  const createdAt = nowIso();
  const expiresAt = Date.now() + DEVICE_TOKEN_TTL_MS;
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
  /^\/notifications\/read-all$/,
  /^\/companion\/(heartbeat|unpair)$/
];

/**
 * Reads a companion device may NOT perform, even though its scope covers
 * reading. These leak credentials or host state that a phone has no business
 * holding: secret values, SSH keys, GitHub PATs, database dumps, AI gateway
 * tokens, MCP/agent session bootstrap, and the admin surface.
 */
const READ_DENY_PATTERNS: RegExp[] = [
  /^\/secrets(\/|$)/,
  /^\/backup(\/|$)/,
  /^\/settings\/(ssh|github)(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/agents(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/api\/ai-gateway(\/|$)/,
  /^\/ops\/(audit-logs|diagnostics|install-scripts)$/,
  // Pairing administration stays on the desktop: a lost phone must not be able
  // to enumerate the other paired devices or mint a code for a second one.
  /^\/companion\/(devices|endpoints|pairings)(\/|$)/,
  /\/terminal-sessions(\/|$)/,
  /\/env(\/|$)/,
  /\/certificate(\/|$)/
];

/**
 * The authorization decision for a companion device token. `path` must already
 * have its query string stripped.
 */
export function companionRequestAllowed(scope: CompanionScope, method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") {
    return !READ_DENY_PATTERNS.some((re) => re.test(path));
  }
  if (scope !== "control") return false;
  return CONTROL_WRITE_PATTERNS.some((re) => re.test(path));
}
