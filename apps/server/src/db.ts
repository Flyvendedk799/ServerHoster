import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataRoot, { recursive: true });
fs.mkdirSync(config.logsDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
fs.mkdirSync(config.certsDir, { recursive: true });
fs.mkdirSync(config.scriptsDir, { recursive: true });

export const db = new Database(config.dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  git_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  command TEXT,
  working_dir TEXT,
  docker_image TEXT,
  dockerfile TEXT,
  port INTEGER,
  status TEXT NOT NULL,
  auto_restart INTEGER NOT NULL DEFAULT 1,
  restart_count INTEGER NOT NULL DEFAULT 0,
  max_restarts INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_vars (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  port INTEGER NOT NULL,
  container_id TEXT,
  connection_string TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  commit_hash TEXT,
  status TEXT NOT NULL,
  build_log TEXT NOT NULL,
  artifact_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_routes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status_code INTEGER NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
`);

const migrations = [
  "ALTER TABLE deployments ADD COLUMN artifact_path TEXT",
  "ALTER TABLE services ADD COLUMN healthcheck_path TEXT",
  "ALTER TABLE services ADD COLUMN start_mode TEXT DEFAULT 'manual'",
  "ALTER TABLE services ADD COLUMN last_exit_code INTEGER",
  "ALTER TABLE services ADD COLUMN last_started_at TEXT",
  "ALTER TABLE services ADD COLUMN last_stopped_at TEXT",
  "ALTER TABLE sessions ADD COLUMN user_id TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_routes_domain ON proxy_routes(domain)"
];

for (const statement of migrations) {
  try {
    db.exec(statement);
  } catch {
    // No-op: migration already applied.
  }
}
