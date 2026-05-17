import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataRoot, { recursive: true });
fs.mkdirSync(config.logsDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
fs.mkdirSync(config.certsDir, { recursive: true });
fs.mkdirSync(config.scriptsDir, { recursive: true });
fs.mkdirSync(config.agentHomeDir, { recursive: true });

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
  stop_with_hoster INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  shell_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  provider TEXT,
  profile_id TEXT,
  allow_mutations INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 24,
  cols INTEGER NOT NULL DEFAULT 80,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  install_status TEXT NOT NULL DEFAULT 'not_installed',
  auth_mode TEXT NOT NULL DEFAULT 'cli',
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  isolated_home TEXT NOT NULL,
  version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, provider, name)
);

CREATE TABLE IF NOT EXISTS agent_secrets (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, key)
);

CREATE TABLE IF NOT EXISTS mcp_session_tokens (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  terminal_session_id TEXT,
  token_hash TEXT NOT NULL,
  allow_mutations INTEGER NOT NULL DEFAULT 0,
  tool_policy TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
`);

const migrations = [
  "ALTER TABLE deployments ADD COLUMN artifact_path TEXT",
  "ALTER TABLE services ADD COLUMN healthcheck_path TEXT",
  "ALTER TABLE services ADD COLUMN start_mode TEXT DEFAULT 'manual'",
  "ALTER TABLE services ADD COLUMN stop_with_hoster INTEGER NOT NULL DEFAULT 1",
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
  `CREATE TABLE IF NOT EXISTS terminal_sessions (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    shell_kind TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    provider TEXT,
    profile_id TEXT,
    allow_mutations INTEGER NOT NULL DEFAULT 0,
    rows INTEGER NOT NULL DEFAULT 24,
    cols INTEGER NOT NULL DEFAULT 80,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    exit_signal TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_terminal_sessions_service ON terminal_sessions(service_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    install_status TEXT NOT NULL DEFAULT 'not_installed',
    auth_mode TEXT NOT NULL DEFAULT 'cli',
    auth_status TEXT NOT NULL DEFAULT 'unknown',
    isolated_home TEXT NOT NULL,
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(service_id, provider, name)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_agent_profiles_service ON agent_profiles(service_id, provider)",
  `CREATE TABLE IF NOT EXISTS agent_secrets (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(profile_id, key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_agent_secrets_profile ON agent_secrets(profile_id)",
  `CREATE TABLE IF NOT EXISTS mcp_session_tokens (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    terminal_session_id TEXT,
    token_hash TEXT NOT NULL,
    allow_mutations INTEGER NOT NULL DEFAULT 0,
    tool_policy TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_mcp_session_tokens_service ON mcp_session_tokens(service_id, expires_at)"
];

for (const statement of migrations) {
  try {
    db.exec(statement);
  } catch {
    // No-op: migration already applied.
  }
}
