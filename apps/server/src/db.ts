import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataRoot, { recursive: true });
fs.mkdirSync(config.logsDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
fs.mkdirSync(config.certsDir, { recursive: true });
fs.mkdirSync(config.scriptsDir, { recursive: true });
fs.mkdirSync(config.backupsDir, { recursive: true });

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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_routes_domain ON proxy_routes(domain)",
  "ALTER TABLE services ADD COLUMN github_repo_url TEXT",
  "ALTER TABLE services ADD COLUMN github_branch TEXT",
  "ALTER TABLE services ADD COLUMN github_auto_pull INTEGER DEFAULT 1",
  `CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    fullchain TEXT NOT NULL,
    privkey TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "ALTER TABLE services ADD COLUMN ssl_status TEXT DEFAULT 'none'",
  "ALTER TABLE deployments ADD COLUMN started_at TEXT",
  "ALTER TABLE deployments ADD COLUMN finished_at TEXT",
  "ALTER TABLE deployments ADD COLUMN branch TEXT",
  "ALTER TABLE deployments ADD COLUMN trigger_source TEXT DEFAULT 'manual'",
  `CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    cpu_percent REAL NOT NULL,
    memory_mb REAL NOT NULL,
    timestamp TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_metrics_service_ts ON metrics(service_id, timestamp DESC)",
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    service_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_notifications_read_created ON notifications(read, created_at DESC)",
  "ALTER TABLE services ADD COLUMN linked_database_id TEXT",
  "ALTER TABLE databases ADD COLUMN username TEXT",
  "ALTER TABLE databases ADD COLUMN password TEXT",
  "ALTER TABLE databases ADD COLUMN database_name TEXT",
  `CREATE TABLE IF NOT EXISTS database_backups (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "ALTER TABLE services ADD COLUMN depends_on TEXT",
  "ALTER TABLE services ADD COLUMN environment TEXT DEFAULT 'production'",
  "ALTER TABLE services ADD COLUMN compose_service_name TEXT",
  "ALTER TABLE services ADD COLUMN compose_file_hash TEXT",
  `CREATE TABLE IF NOT EXISTS project_env_vars (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_id, key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_project_env_vars_project ON project_env_vars(project_id)",
  "ALTER TABLE services ADD COLUMN tunnel_url TEXT",
  "ALTER TABLE services ADD COLUMN quick_tunnel_enabled INTEGER NOT NULL DEFAULT 0",
  // System-managed env rows are written by the platform (e.g. PUBLIC_URL from
  // the Go-Public wizard) and survive manual env CRUD calls.
  "ALTER TABLE env_vars ADD COLUMN system INTEGER NOT NULL DEFAULT 0",
  // Best-effort retry queue for asynchronous Cloudflare cleanups (DNS records,
  // tunnel ingress) when a service deletion would otherwise leak resources.
  `CREATE TABLE IF NOT EXISTS cleanup_queue (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cleanup_queue_created ON cleanup_queue(created_at)",
  // Sequence 1 — enrich audit_logs so every event records the target object
  // (separate from the URL-derived resource_type/id pair) plus source IP and
  // user agent. Old rows leave the new columns NULL.
  "ALTER TABLE audit_logs ADD COLUMN target_type TEXT",
  "ALTER TABLE audit_logs ADD COLUMN target_id TEXT",
  "ALTER TABLE audit_logs ADD COLUMN source_ip TEXT",
  "ALTER TABLE audit_logs ADD COLUMN user_agent TEXT",
  "CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id)",
  // Sequence 2 — extend deployments with provenance + timing so failures can
  // be traced after the fact and rollbacks know exactly which commit to
  // restore.
  "ALTER TABLE deployments ADD COLUMN git_sha TEXT",
  "ALTER TABLE deployments ADD COLUMN duration_ms INTEGER",
  "ALTER TABLE deployments ADD COLUMN failure_stage TEXT",
  // Sequence 2 — explicit dead-letter retention on the cleanup queue so we
  // can inspect / re-drive failed payloads instead of silently dropping
  // them after 10 attempts.
  `CREATE TABLE IF NOT EXISTS cleanup_dead_letter (
    id TEXT PRIMARY KEY,
    original_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    last_error TEXT,
    moved_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cleanup_dead_letter_moved ON cleanup_dead_letter(moved_at DESC)",
  // Sequence 5 — backup metadata: every snapshot we cut stores a sha256
  // checksum and size so restore can verify integrity before applying.
  `CREATE TABLE IF NOT EXISTS instance_backups (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_instance_backups_created ON instance_backups(created_at DESC)"
];

for (const statement of migrations) {
  try {
    db.exec(statement);
  } catch {
    // No-op: migration already applied.
  }
}
