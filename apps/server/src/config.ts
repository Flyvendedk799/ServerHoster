import path from "node:path";
import os from "node:os";

const homeDir = os.homedir();
const dataRoot = process.env.SURVHUB_DATA_DIR ?? path.join(homeDir, ".survhub");

const isProduction = (process.env.NODE_ENV ?? "development") === "production";

/**
 * Production-safe defaults: when NODE_ENV=production we lock cookies down
 * (Secure, HttpOnly, SameSite=Strict) and refuse cross-origin requests
 * unless the operator opts in via SURVHUB_TRUSTED_ORIGINS.
 *
 * In development we allow common localhost origins so the Vite dashboard at
 * :5173 can talk to the API at :8787 without manual configuration.
 */
function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const defaultDevOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
];

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  apiPort: Number(process.env.SURVHUB_PORT ?? 8787),
  host: process.env.SURVHUB_HOST ?? "0.0.0.0",
  webSocketPath: process.env.SURVHUB_WS_PATH ?? "/ws",
  dataRoot,
  dbPath: path.join(dataRoot, "survhub.db"),
  logsDir: path.join(dataRoot, "logs"),
  projectsDir: path.join(dataRoot, "projects"),
  certsDir: path.join(dataRoot, "certs"),
  scriptsDir: path.join(dataRoot, "scripts"),
  backupsDir: path.join(dataRoot, "backups"),
  authToken: process.env.SURVHUB_AUTH_TOKEN ?? "",
  secretKey: process.env.SURVHUB_SECRET_KEY ?? "",
  webhookSecret: process.env.SURVHUB_WEBHOOK_SECRET ?? "",
  webhookInsecure: process.env.SURVHUB_WEBHOOK_INSECURE === "1",
  /**
   * Maximum acceptable skew (in seconds) between a webhook's signed
   * timestamp and the receiver's clock. Replays older than this window are
   * rejected even when the HMAC is otherwise valid.
   */
  webhookMaxSkewSeconds: Number(process.env.SURVHUB_WEBHOOK_MAX_SKEW_SECONDS ?? 300),
  sessionTtlMs: Number(process.env.SURVHUB_SESSION_TTL_MS ?? 1000 * 60 * 60 * 12),
  /**
   * In production cookies are flagged Secure + HttpOnly + SameSite=Strict.
   * Operators can override via SURVHUB_SECURE_COOKIES=0 only if they really
   * mean it (e.g. running over plain HTTP behind a trusted reverse proxy).
   */
  secureCookies:
    process.env.SURVHUB_SECURE_COOKIES === "1" ||
    (isProduction && process.env.SURVHUB_SECURE_COOKIES !== "0"),
  /**
   * Comma-separated list of origins (scheme://host[:port]) allowed to call
   * the API in production. Empty list means same-origin only.
   */
  trustedOrigins: parseTrustedOrigins(process.env.SURVHUB_TRUSTED_ORIGINS),
  defaultDevOrigins,
  /**
   * Token-gated /admin/reset-admin endpoint. When set, lets operators rotate
   * the admin password over a localhost-bound API call without dropping into
   * `survhub reset-admin` on the host shell.
   */
  adminResetToken: process.env.SURVHUB_ADMIN_RESET_TOKEN ?? "",
  enableHttps: process.env.SURVHUB_ENABLE_HTTPS === "1",
  certPath: process.env.SURVHUB_CERT_PATH ?? path.join(dataRoot, "certs", "server-cert.pem"),
  keyPath: process.env.SURVHUB_KEY_PATH ?? path.join(dataRoot, "certs", "server-key.pem"),
  healthcheckIntervalMs: Number(process.env.SURVHUB_HEALTHCHECK_INTERVAL_MS ?? 15000),
  gitPollIntervalMs: Number(process.env.SURVHUB_GIT_POLL_INTERVAL_MS ?? 60000),
  proxyPort: Number(process.env.SURVHUB_PROXY_PORT ?? 80)
};
