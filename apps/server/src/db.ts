import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataRoot, { recursive: true });
fs.mkdirSync(config.logsDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
fs.mkdirSync(config.certsDir, { recursive: true });
fs.mkdirSync(config.scriptsDir, { recursive: true });
fs.mkdirSync(config.agentHomeDir, { recursive: true });
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
  "CREATE INDEX IF NOT EXISTS idx_mcp_session_tokens_service ON mcp_session_tokens(service_id, expires_at)",
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
  "CREATE INDEX IF NOT EXISTS idx_instance_backups_created ON instance_backups(created_at DESC)",
  // Last commit the GitOps poller attempted to deploy (success OR failure). The
  // poller keys "is this a new commit?" off this so a commit that keeps failing
  // to build isn't redeployed every tick forever.
  "ALTER TABLE services ADD COLUMN last_attempted_commit TEXT",
  // Process-group id of a running process/static service. Persisted so that a
  // child spawned detached (which survives a ServerHoster restart) can be
  // ADOPTED on boot — otherwise it shows as "stopped" while still live, and a
  // force-restart spawns a second instance that collides on the port.
  "ALTER TABLE services ADD COLUMN runtime_pgid INTEGER",
  // Generic resource layer (Database-Tracker Phase 1) — managed resources are
  // provisioned local dependencies (Postgres, Supabase stacks, Redis, …)
  // described by a resource profile. `databases` + `services.linked_database_id`
  // stay untouched for backward compatibility.
  `CREATE TABLE IF NOT EXISTS managed_resources (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    name TEXT NOT NULL,
    profile TEXT NOT NULL,
    status TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    ports_json TEXT NOT NULL DEFAULT '{}',
    containers_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // resource_secrets.value is ALWAYS stored AES-256-GCM encrypted (same path
  // as env_vars secrets); API responses only ever expose a masked preview.
  `CREATE TABLE IF NOT EXISTS resource_secrets (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    is_generated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(resource_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS service_resource_links (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    env_map_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(service_id, resource_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dependency_scans (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    confidence TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    env_requirements_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_managed_resources_project ON managed_resources(project_id)",
  "CREATE INDEX IF NOT EXISTS idx_service_resource_links_service ON service_resource_links(service_id)",
  "CREATE INDEX IF NOT EXISTS idx_dependency_scans_service ON dependency_scans(service_id, created_at DESC)",
  // SaaS tenant domains — hostnames OWNED BY END USERS of a hosted multi-tenant
  // app (e.g. a blog platform's customers), registered as Cloudflare for SaaS
  // custom hostnames. Distinct from proxy_routes, which holds the operator's own
  // zone-resident domains; the two are unioned into the tunnel ingress.
  `CREATE TABLE IF NOT EXISTS saas_domains (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending_dns',
    ssl_status TEXT NOT NULL DEFAULT 'none',
    mode TEXT NOT NULL DEFAULT 'custom_hostname',
    cf_custom_hostname_id TEXT,
    cname_target TEXT,
    verification_txt_name TEXT,
    verification_txt_value TEXT,
    failure_reason TEXT,
    last_checked_at TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_saas_domains_service ON saas_domains(service_id, created_at DESC)",
  // Opt-in production mode for built SPAs: after a successful build, serve the
  // emitted dist/ with the static server instead of launching the framework dev
  // server. Per-service so existing dev-server deployments keep their behavior.
  "ALTER TABLE services ADD COLUMN serve_built_dist INTEGER NOT NULL DEFAULT 0"
];

for (const statement of migrations) {
  try {
    db.exec(statement);
  } catch {
    // No-op: migration already applied.
  }
}
