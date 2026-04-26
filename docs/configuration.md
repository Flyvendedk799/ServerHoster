# Configuration reference

Every knob LocalSURV reads at startup, every file it writes on disk, every port it opens.

## Environment variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | string | `development` | Fastify log verbosity + build mode |
| `SURVHUB_PORT` | number | `8787` | API + dashboard HTTP port |
| `SURVHUB_HOST` | string | `0.0.0.0` | Bind host |
| `SURVHUB_WS_PATH` | string | `/ws` | WebSocket endpoint path |
| `SURVHUB_DATA_DIR` | path | `~/.survhub` | Root of all persistent state |
| `SURVHUB_AUTH_TOKEN` | string | *(empty)* | Optional static bearer token. When set, `Authorization: Bearer <token>` is always accepted regardless of session state. Useful for CI. |
| `SURVHUB_SECRET_KEY` | string | *(empty)* | **Required in production.** Used as the key for AES-256-GCM encryption of every secret stored at rest (service env vars, GitHub PAT, Cloudflare tokens). Losing this key = losing the data. |
| `SURVHUB_SESSION_TTL_MS` | number | `43200000` (12h) | Session lifetime for logged-in users |
| `SURVHUB_ENABLE_HTTPS` | `0`/`1` | `0` | Bind an HTTPS listener with dynamic SNI. Requires `SURVHUB_CERT_PATH` + `SURVHUB_KEY_PATH` to exist. |
| `SURVHUB_CERT_PATH` | path | `$DATA/certs/server-cert.pem` | Default TLS cert (fallback when SNI lookup fails) |
| `SURVHUB_KEY_PATH` | path | `$DATA/certs/server-key.pem` | Default TLS key |
| `SURVHUB_HEALTHCHECK_INTERVAL_MS` | number | `15000` | How often healthchecks fire against services with `healthcheck_path` set |
| `SURVHUB_GIT_POLL_INTERVAL_MS` | number | `60000` | GitOps polling interval |

Generate a fresh secret key:

```bash
openssl rand -base64 32
```

## Filesystem layout

Everything lives under `SURVHUB_DATA_DIR` (default `~/.survhub`):

```
~/.survhub/
├── survhub.db          # SQLite database (state)
├── survhub.db-shm      # SQLite shared memory
├── survhub.db-wal      # SQLite write-ahead log
├── projects/           # Cloned git repos, one folder per service id
│   └── <serviceId>/    # The service's working directory
├── certs/              # TLS certs (fallback + generated local)
│   ├── server-cert.pem
│   └── server-key.pem
├── backups/            # Database backup dumps (pg_dump / mysqldump / mongodump)
├── logs/               # Reserved for future file logging
└── scripts/            # Generated install scripts from /ops/install-scripts
```

## Database schema reference

**Core tables** (managed by `src/db.ts`, migrations run at startup):

| Table | Key columns |
| --- | --- |
| `projects` | `id`, `name`, `description`, `git_url`, `created_at`, `updated_at` |
| `services` | `id`, `project_id`, `name`, `type`, `command`, `working_dir`, `docker_image`, `port`, `status`, `auto_restart`, `restart_count`, `max_restarts`, `start_mode`, `healthcheck_path`, `github_repo_url`, `github_branch`, `github_auto_pull`, `ssl_status`, `linked_database_id`, `depends_on` (JSON array), `environment`, `compose_service_name`, `compose_file_hash` |
| `env_vars` | `id`, `service_id`, `key`, `value` (encrypted if `is_secret`), `is_secret` |
| `project_env_vars` | `id`, `project_id`, `key`, `value`, `is_secret`, unique `(project_id, key)` |
| `deployments` | `id`, `service_id`, `commit_hash`, `status`, `build_log`, `artifact_path`, `created_at`, `started_at`, `finished_at`, `branch`, `trigger_source` |
| `logs` | `id`, `service_id`, `level`, `message`, `timestamp` (trimmed to 5000/service) |
| `proxy_routes` | `id`, `service_id`, `domain` (unique), `target_port`, `created_at` |
| `certificates` | `id`, `domain` (unique), `fullchain`, `privkey`, `expires_at`, `created_at` |
| `databases` | `id`, `project_id`, `name`, `engine`, `port`, `container_id`, `connection_string`, `username`, `password`, `database_name` |
| `database_backups` | `id`, `database_id`, `filename`, `size_bytes`, `created_at` |
| `metrics` | `id`, `service_id`, `cpu_percent`, `memory_mb`, `timestamp` (trimmed to 24h) |
| `notifications` | `id`, `kind`, `severity`, `title`, `body`, `service_id`, `read`, `created_at` |
| `settings` | `key` (PK), `value` (encrypted when `key ∈ ENCRYPTED_SETTINGS`) |
| `users` | `id`, `username` (unique), `password_hash`, `role`, `created_at` |
| `sessions` | `id`, `token` (unique), `user_id`, `expires_at`, `created_at` |
| `audit_logs` | `id`, `actor`, `action`, `resource_type`, `resource_id`, `status_code`, `details`, `created_at` |

**Encrypted settings keys** (transparent AES-256-GCM at rest via `SURVHUB_SECRET_KEY`):

- `github_pat`
- `cloudflare_api_token`
- `cloudflare_tunnel_token`
- `cloudflare_account_id` *(sensitive; encrypted)*

All other settings keys are stored as plain text.

## Network ports

| Port | Purpose | Required? |
| --- | --- | --- |
| `SURVHUB_PORT` (8787) | API + dashboard + WebSocket | always |
| `80` | Let's Encrypt HTTP-01 challenges + reverse proxy | Only if using HTTP-01 SSL; not needed with Cloudflare Tunnel or DNS-01 |
| `443` | Reverse proxy for HTTPS traffic | Only if serving HTTPS directly |
| Service internal ports | Each service listens on its own port; LocalSURV proxies `domain:80/443 → 127.0.0.1:<port>` | per service |
| Database ports | Postgres 5432, MySQL 3306, Redis 6379, Mongo 27017 (configurable at creation) | per database |

## Secrets lifecycle

1. A secret is POSTed to the API (env var, PAT, Cloudflare token).
2. LocalSURV encrypts it with AES-256-GCM using `SURVHUB_SECRET_KEY` and writes the ciphertext to `env_vars` or `settings`.
3. On read, plaintext is only returned to:
   - The process that launches a service (injected via `spawn` env)
   - An internal service call (`getSecretSetting`)
4. All HTTP responses that could expose a secret either redact it (`maskSecret` — keeps first/last chars) or refuse (403).

**Do not** commit `~/.survhub/survhub.db` to git — it contains ciphertext whose security depends on `SURVHUB_SECRET_KEY` being kept secret.

## Production recommendations

- Run the server as a dedicated non-root user with access to Docker's socket (e.g. in the `docker` group)
- Put `SURVHUB_SECRET_KEY` in a secret manager (1Password, Vault) and export it via a systemd/launchd drop-in
- Enable HTTPS for the dashboard itself (`SURVHUB_ENABLE_HTTPS=1`) or access it via a Cloudflare Tunnel
- Back up `~/.survhub/survhub.db` to the same place you'd back up any production SQLite file (e.g. hourly `litestream replicate`)
- Pin Node to 20 LTS or newer
