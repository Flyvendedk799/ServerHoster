import path from "node:path";
import os from "node:os";

const homeDir = os.homedir();
const dataRoot = process.env.SURVHUB_DATA_DIR ?? path.join(homeDir, ".survhub");

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
  authToken: process.env.SURVHUB_AUTH_TOKEN ?? "",
  secretKey: process.env.SURVHUB_SECRET_KEY ?? "",
  sessionTtlMs: Number(process.env.SURVHUB_SESSION_TTL_MS ?? 1000 * 60 * 60 * 12),
  enableHttps: process.env.SURVHUB_ENABLE_HTTPS === "1",
  certPath: process.env.SURVHUB_CERT_PATH ?? path.join(dataRoot, "certs", "server-cert.pem"),
  keyPath: process.env.SURVHUB_KEY_PATH ?? path.join(dataRoot, "certs", "server-key.pem"),
  healthcheckIntervalMs: Number(process.env.SURVHUB_HEALTHCHECK_INTERVAL_MS ?? 15000),
  gitPollIntervalMs: Number(process.env.SURVHUB_GIT_POLL_INTERVAL_MS ?? 60000),
  proxyPort: Number(process.env.SURVHUB_PROXY_PORT ?? 80)
};
