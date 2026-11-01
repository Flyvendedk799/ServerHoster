import crypto from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Automation API tokens — long-lived, revocable machine credentials.
 *
 * A dashboard session is the wrong credential for a script or an agent: it
 * expires after SURVHUB_SESSION_TTL_MS and is gone whenever the sessions table
 * is cleared, which locks the automation out until a human logs in again. An
 * API token is a row of its own that survives restarts and lives until it is
 * revoked or reaches its optional expiry.
 *
 * Same storage rules as ai_gateway_tokens and companion_devices: only the
 * SHA-256 hash is persisted (a leaked database must not yield a working
 * credential), the plaintext is shown exactly once at creation, and
 * `token_prefix` is display-only so an operator can tell tokens apart.
 *
 * This module deliberately depends on nothing but a better-sqlite3 handle (no
 * AppContext, no config, no db.ts import) so the `survhub token …` CLI can use
 * it against survhub.db while the server is stopped.
 */

/** Every token starts with this, so a leaked one is greppable in logs and repos. */
export const API_TOKEN_PREFIX = "shk_";

/** Characters of the plaintext kept for display ("shk_" + 8 random characters). */
const DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 8;

/** last_used_at is written at most this often per token, not on every request. */
export const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Scopes a token can carry. Only "admin" (the full API, minus managing API
 * tokens) exists today; the column holds a space-separated list so a narrower
 * scope such as "read" can be added later without a migration.
 */
export const API_TOKEN_SCOPES = ["admin"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKENS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at INTEGER,
    revoked_at TEXT
  )`;
export const API_TOKENS_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)";

/** Create the table if it is missing. Idempotent; used by the CLI, which may run before the server has migrated. */
export function ensureApiTokensTable(db: Database.Database): void {
  db.exec(API_TOKENS_TABLE_SQL);
  db.exec(API_TOKENS_INDEX_SQL);
}

type ApiTokenRow = {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: number | null;
  revoked_at: string | null;
};

/** What the API, the dashboard and the CLI may show. Never carries the secret or its hash. */
export type ApiTokenInfo = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  /** ISO timestamp, or null for a token that does not expire. */
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

export type ResolvedApiToken = {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
};

export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** True for anything shaped like one of our tokens; cheap pre-check before touching the database. */
export function looksLikeApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX) && token.length > DISPLAY_PREFIX_LENGTH;
}

function generatePlaintext(): string {
  // 32 random bytes → 43 base64url characters, 256 bits of entropy.
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function parseScopes(raw: string): ApiTokenScope[] {
  return raw
    .split(/\s+/)
    .filter((s): s is ApiTokenScope => (API_TOKEN_SCOPES as readonly string[]).includes(s));
}

function toInfo(row: ApiTokenRow, now: number): ApiTokenInfo {
  const status: ApiTokenInfo["status"] = row.revoked_at
    ? "revoked"
    : row.expires_at !== null && row.expires_at <= now
      ? "expired"
      : "active";
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at,
    status
  };
}

export type CreateApiTokenInput = {
  name: string;
  /** Whole days until expiry; omit/null for a token that never expires. */
  expiresInDays?: number | null;
  scopes?: ApiTokenScope[];
};

/**
 * Mint a token. Returns the plaintext — the only time it exists outside the
 * caller's hands — together with the stored metadata.
 */
export function createApiToken(
  db: Database.Database,
  input: CreateApiTokenInput,
  now: number = Date.now()
): { token: string; info: ApiTokenInfo } {
  const name = input.name.trim();
  if (!name) throw new Error("Token name is required");
  if (name.length > 100) throw new Error("Token name must be at most 100 characters");
  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    throw new Error("expiresInDays must be a whole number between 1 and 3650");
  }
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : (["admin"] as ApiTokenScope[]);
  for (const scope of scopes) {
    if (!(API_TOKEN_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  }

  const token = generatePlaintext();
  const row: ApiTokenRow = {
    id: crypto.randomUUID(),
    name,
    token_hash: hashApiToken(token),
    token_prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    scopes: [...new Set(scopes)].join(" "),
    created_at: new Date(now).toISOString(),
    last_used_at: null,
    expires_at: days === null ? null : now + days * 24 * 60 * 60 * 1000,
    revoked_at: null
  };
  db.prepare(
    `INSERT INTO api_tokens (id, name, token_hash, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at)
     VALUES (@id, @name, @token_hash, @token_prefix, @scopes, @created_at, @last_used_at, @expires_at, @revoked_at)`
  ).run(row);
  return { token, info: toInfo(row, now) };
}

export function listApiTokens(db: Database.Database, now: number = Date.now()): ApiTokenInfo[] {
  const rows = db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC").all() as ApiTokenRow[];
  return rows.map((row) => toInfo(row, now));
}

export function getApiToken(
  db: Database.Database,
  id: string,
  now: number = Date.now()
): ApiTokenInfo | null {
  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as ApiTokenRow | undefined;
  return row ? toInfo(row, now) : null;
}

export type RevokeResult =
  | { ok: true; info: ApiTokenInfo; alreadyRevoked: boolean }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: ApiTokenInfo[] };

/**
 * Revoke by id, or (for the CLI) by the displayed prefix. A prefix that
 * matches more than one token is refused rather than guessed at.
 */
export function revokeApiToken(
  db: Database.Database,
  idOrPrefix: string,
  opts: { allowPrefix?: boolean } = {},
  now: number = Date.now()
): RevokeResult {
  const needle = idOrPrefix.trim();
  if (!needle) return { ok: false, reason: "not_found" };
  let rows = db.prepare("SELECT * FROM api_tokens WHERE id = ?").all(needle) as ApiTokenRow[];
  if (rows.length === 0 && opts.allowPrefix) {
    rows = (db.prepare("SELECT * FROM api_tokens").all() as ApiTokenRow[]).filter(
      (r) => r.token_prefix.startsWith(needle) || (needle.length >= 4 && r.id.startsWith(needle))
    );
  }
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous", matches: rows.map((r) => toInfo(r, now)) };
  const row = rows[0];
  const alreadyRevoked = Boolean(row.revoked_at);
  if (!alreadyRevoked) {
    row.revoked_at = new Date(now).toISOString();
    db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(row.revoked_at, row.id);
  }
  return { ok: true, info: toInfo(row, now), alreadyRevoked };
}

/**
 * Resolve a bearer value to a live API token, or null. Revoked and expired
 * tokens resolve to null. On success last_used_at is bumped, at most once per
 * LAST_USED_THROTTLE_MS so a busy agent does not turn every read into a write.
 */
export function resolveApiToken(
  db: Database.Database,
  token: string,
  now: number = Date.now()
): ResolvedApiToken | null {
  if (!looksLikeApiToken(token)) return null;
  const hash = hashApiToken(token);
  let row: ApiTokenRow | undefined;
  try {
    row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash) as ApiTokenRow | undefined;
  } catch {
    // Table missing (a database the migrations have not reached yet): no tokens exist.
    return null;
  }
  if (!row) return null;
  // The lookup is by hash, but compare the full digests in constant time as
  // well so the accept decision itself never short-circuits on content.
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hash, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (row.revoked_at) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!lastUsed || now - lastUsed >= LAST_USED_THROTTLE_MS) {
    try {
      db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(
        new Date(now).toISOString(),
        row.id
      );
    } catch {
      /* bookkeeping only — never fail a request over it */
    }
  }
  return { id: row.id, name: row.name, scopes: parseScopes(row.scopes) };
}

/** Paths an API token may never call, whatever its scope: managing API tokens is session-only. */
export function isApiTokenManagementPath(path: string): boolean {
  return path === "/auth/tokens" || path.startsWith("/auth/tokens/");
}

/**
 * Settings keys that hold a credential the control plane itself accepts (or,
 * for the dashboard password, whose removal can switch auth off entirely).
 * Writing or deleting one through the generic settings API would let a token
 * leave behind a credential that outlives its own revocation.
 */
export const CREDENTIAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  "api_token",
  "saas_api_token",
  "dashboard_password"
]);

/**
 * Endpoints that reveal, rotate or mint *another* long-lived credential. An
 * API token is barred from them for the same reason it cannot mint API
 * tokens: revoking a leaked token must actually end that access, which it
 * would not if the token could first copy the shared durable token, rotate
 * the SaaS machine token or pair a companion device.
 */
function isCredentialEscalationPath(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (path === "/settings/api-token/reveal" || path === "/settings/api-token/rotate") return true;
  if (path === "/saas/token/rotate") return true;
  if (verb === "POST" && path === "/companion/pairings") return true;
  if (verb === "DELETE" && path.startsWith("/settings/")) {
    let key = path.slice("/settings/".length);
    try {
      key = decodeURIComponent(key);
    } catch {
      return true; // malformed escape: refuse rather than guess
    }
    if (CREDENTIAL_SETTING_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * The authorization decision for an API token. `path` must already have its
 * query string stripped. `body` is the parsed request body when known (the
 * preHandler pass); the onRequest pass runs before parsing and omits it.
 * "admin" is the whole API except token management and credential
 * escalation; future narrower scopes slot in here.
 */
export function apiTokenRequestAllowed(
  scopes: ApiTokenScope[],
  method: string,
  path: string,
  body?: unknown
): boolean {
  if (isApiTokenManagementPath(path)) return false;
  if (isCredentialEscalationPath(method, path)) return false;
  if (method.toUpperCase() === "PUT" && path === "/settings" && body && typeof body === "object") {
    const key = (body as { key?: unknown }).key;
    if (typeof key === "string" && CREDENTIAL_SETTING_KEYS.has(key)) return false;
  }
  return scopes.includes("admin");
}
