/**
 * Secret-key bootstrap shared by both launchers (scripts/start-dev.mjs and
 * apps/desktop/main.js).
 *
 * Background: the server encrypts secret settings at rest with
 * SURVHUB_SECRET_KEY (falling back to the insecure built-in "survhub-dev-key"
 * when the env var is empty — see apps/server/src/security.ts). The terminal
 * launcher historically never loaded ~/.survhub/survhub.env, so the server ran
 * on the dev key and persisted secrets under it. The Electron launcher DID load
 * the strong key, which meant an Electron-launched server could not decrypt the
 * dev-key blobs the terminal launcher had written.
 *
 * This module makes BOTH launchers (a) load survhub.env so the strong key is
 * always in effect and (b) one-time re-encrypt any dev-key secret blob under
 * the strong key before the server boots. Idempotent and self-healing: once a
 * value is stored under the strong key it is skipped; with no strong key
 * configured it is a no-op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const DEV_KEY_FALLBACK = "survhub-dev-key";

/** Settings persisted encrypted at rest — mirrors ENCRYPTED_SETTINGS in apps/server/src/services/settings.ts. */
const ENCRYPTED_SETTINGS = [
  "github_pat",
  "cloudflare_api_token",
  "cloudflare_tunnel_token",
  "cloudflare_account_id",
  "saas_api_token"
];

export function dataDir() {
  return process.env.SURVHUB_DATA_DIR || path.join(os.homedir(), ".survhub");
}

function envFilePath() {
  return path.join(dataDir(), "survhub.env");
}

/** Parse survhub.env (KEY="value" lines, # comments) into a plain object. */
export function parseEnvFile() {
  const file = envFilePath();
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Merge survhub.env into process.env WITHOUT clobbering values already set. */
export function loadEnvFileIntoProcess() {
  const fileEnv = parseEnvFile();
  for (const [k, v] of Object.entries(fileEnv)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return fileEnv;
}

function keyBuffer(secretKey) {
  return crypto.createHash("sha256").update(secretKey || DEV_KEY_FALLBACK).digest();
}

function isEncryptedBlob(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  return parts.length === 3 && /^[0-9a-f]+$/i.test(parts[0]) && parts[0].length === 32;
}

/** Returns the plaintext, or null if this key cannot decrypt the blob. */
function tryDecrypt(blob, secretKey) {
  try {
    const [ivHex, tagHex, dataHex] = blob.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", keyBuffer(secretKey), Buffer.from(ivHex, "hex"));
    d.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function encrypt(value, secretKey) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-gcm", keyBuffer(secretKey), iv);
  const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

/**
 * Re-encrypt any secret stored under the legacy dev key into `secretKey`.
 * No-op when secretKey is empty (dev key still in effect) — we never downgrade.
 * Returns the list of setting keys migrated. `log` is an optional sink.
 */
export function migrateSecretsToStrongKey(secretKey, log = () => {}) {
  if (!secretKey) return [];
  const dbPath = path.join(dataDir(), "survhub.db");
  if (!fs.existsSync(dbPath)) return [];

  const require = createRequire(import.meta.url);
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    log(`[secret-key] migration skipped — better-sqlite3 unavailable: ${err.message}`);
    return [];
  }

  const db = new Database(dbPath);
  const migrated = [];
  try {
    const get = db.prepare("SELECT value FROM settings WHERE key = ?");
    const set = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    for (const key of ENCRYPTED_SETTINGS) {
      const row = get.get(key);
      if (!row || !isEncryptedBlob(row.value)) continue; // absent or stored as plaintext
      if (tryDecrypt(row.value, secretKey) !== null) continue; // already under the strong key
      const plain = tryDecrypt(row.value, ""); // legacy dev-key blob?
      if (plain === null) {
        log(`[secret-key] WARNING: ${key} decrypts under neither the configured key nor the dev key; left untouched.`);
        continue;
      }
      set.run(encrypt(plain, secretKey), key);
      migrated.push(key);
    }
  } finally {
    db.close();
  }
  if (migrated.length) {
    log(`[secret-key] re-encrypted ${migrated.length} secret(s) under SURVHUB_SECRET_KEY: ${migrated.join(", ")}`);
  }
  return migrated;
}

/** Convenience: load env file, then migrate. Call once at launcher startup. */
export function bootstrapSecretKey(log = () => {}) {
  loadEnvFileIntoProcess();
  return migrateSecretsToStrongKey(process.env.SURVHUB_SECRET_KEY || "", log);
}
