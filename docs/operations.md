# SURVHub Operations Guide

## Installation and Startup

### Linux/macOS/Windows

1. Install Node.js 20+ and Docker Desktop/Engine.
2. Install project dependencies: `npm install`
3. Run API: `npm run dev -w @survhub/server`
4. Run dashboard: `npm run dev -w @survhub/web`

### Service Installer Scripts

Generate scripts from dashboard Settings or API endpoint `GET /ops/install-scripts`.

- Linux: `install-systemd.sh`
- macOS: `install-launchd.sh`
- Windows: `install-windows-service.ps1`

## Security Setup

Recommended minimum:

- Set `SURVHUB_SECRET_KEY` to a long random key (32+ characters).
- In production, never run with empty `SURVHUB_SECRET_KEY`.
- Optionally bootstrap a local admin user via `POST /auth/bootstrap`.

### API / MCP Authentication Token

ServerHoster uses a **durable API token** for MCP and REST API authentication. This token:

- Persists in encrypted settings storage (survives restarts/redeploys)
- Is auto-generated on first start, or seeded from `SURVHUB_AUTH_TOKEN` if set
- Can be viewed, copied, and rotated from **Settings → Dev Tools → API / MCP Token**
- Remains valid indefinitely unless explicitly rotated

**To use the token:**

1. Copy it from the Settings UI (Dev Tools tab)
2. Send it in API requests: `Authorization: Bearer <your-token>`
3. Configure MCP clients (Grok Bot, Claude Desktop) with this same token

**Legacy note:** `SURVHUB_AUTH_TOKEN` is still checked as a fallback, but the persisted durable token is preferred. After initial seed, changing the env var won't rotate the token — use the Settings UI or `POST /settings/api-token/rotate` instead.

### Automation API tokens

For scripts and agents that drive the REST API, use an **automation API token** (`shk_…`) instead of borrowing a dashboard session. Sessions expire and vanish when the `sessions` table is cleared (which locked an agent out after a `systemctl restart localsurv`); an API token is its own row in `survhub.db` and works until it is revoked or reaches its optional expiry.

- Only the SHA-256 hash is stored. The plaintext is printed **once**, at creation.
- Scope `admin`: the full API, except creating/listing/revoking API tokens (session-only) and revealing/rotating/planting other control-plane credentials (durable API token, SaaS machine token, companion pairing, dashboard password) — so revoking a token ends the access it was granted through the API. The scope still includes terminals and deploys, i.e. code execution on the host, so treat a token like root on the box: keep it in a mode-600 file and revoke it on any suspicion of a leak.
- Mutating requests are audit-logged as actor `apitoken:<id>` (`GET /ops/audit-logs`).
- `last_used_at` (shown in the list) is updated at most once a minute.

**Mint one on the host** (works whether or not the server is running, no login needed — the CLI writes straight into `$SURVHUB_DATA_DIR/survhub.db`, default `~/.survhub`). Store it in a root-only file, e.g. `/root/.survhub/automation.token` with mode `600`:

```bash
# On the VPS, as root. The subshell umask makes the file 0600 from the start.
(umask 077; survhub token create --name claude-automation --quiet > /root/.survhub/automation.token)
chmod 600 /root/.survhub/automation.token   # belt and braces
# Optional expiry: add --expires-days 90

# Use it
curl -s -H "Authorization: Bearer $(cat /root/.survhub/automation.token)" http://localhost:8787/projects
```

If `survhub` is not on `PATH`, run the CLI from the checkout: `node apps/server/dist/cli.js token …` (with the same `SURVHUB_DATA_DIR` the service uses).

**List / revoke:**

```bash
survhub token list                      # id, prefix, name, status, created, last used, expiry — never the secret
survhub token revoke shk_AbC1dEf2       # by the displayed prefix, or by the full id
```

Revocation takes effect on the next request. The same create/list/revoke is available in the dashboard under **Settings → API tokens** and over HTTP (`GET`/`POST /auth/tokens`, `DELETE /auth/tokens/:id`; session-only — see [api-reference.md](./api-reference.md#automation-api-tokens)).

### MCP client timeouts (ops bots)

External agents (e.g. Grok Bot via `mcp-remote` → `POST http://<host>:8787/mcp`) should:

1. Use the **Settings → Dev Tools → API / MCP Token** value as `Authorization: Bearer …` (same token as REST).
2. Set a **client timeout of ≥ 30s** (60s is comfortable for health/log tools; raise further for `redeploy_service`).
3. Treat client `-32001 Request timed out` as “no response in time” — not as an auth error. Auth failures return **401** with JSON-RPC `-32000` immediately. See [docs/mcp.md](./mcp.md).

## CI

The CI tab runs test jobs on this machine, in Docker, instead of GitHub Actions. Private repositories therefore do not spend Actions minutes. A pipeline is attached to a service that already deploys from GitHub.

- Put the job in `.survhub/ci.yml` (`steps`, optional `image`, `timeoutMinutes`, `memoryMb`, `secrets`) or paste that YAML into the pipeline.
- Only names listed under `secrets` are copied from the service or project env. Production `DATABASE_URL` is not injected on its own.
- **Hold deploy until CI passes** makes GitOps and the GitHub push webhook wait. A green run deploys only if the branch still points at the tested commit. The Run button checks the commit and does not deploy.
- One job runs at a time. The container is not privileged, drops all capabilities, and does not mount the Docker socket.

## Backups

- Export from dashboard Settings or `GET /backup/export`
- Import from dashboard Settings or `POST /backup/import` with the exported payload.

## Compose Import

Use Services page:

- Paste compose YAML content and import.
- SURVHub maps compose services to Docker services and imports env vars.

## Database Migrations on Deploy

A git deploy applies the repo's pending `supabase/migrations/*.sql` to the service's local
Supabase stack before it builds, so pushing a migration to GitHub is all it takes to move the
live schema. Design and rationale: `docs/supabase-migrations-and-grants.md`.

- **Scope.** One started (`running`/`ready`) local Supabase resource linked to the service.
  Zero linked stacks is a silent no-op; two started stacks skips and warns rather than guessing.
  A stack whose `db_url` is not loopback is never touched.
- **No-op path.** The repo's versions are diffed against
  `supabase_migrations.schema_migrations` first. Nothing pending means the Supabase CLI is
  never invoked.
- **Failure blocks the deploy.** The build log carries the SQL error and the previous build
  keeps serving. Forward-only — there are no down-migrations; recovery is restore-from-backup.
- **Preview:** `GET /resources/:id/migrations` lists repo versions, applied versions, and what
  the next deploy would apply. It runs nothing.
- **Opt out per stack:** `POST /resources/:id/auto-migrate {"enabled": false}`. The stack then
  needs its migrations applied by hand, as before.

## Migration Import Tooling

- Railway payload import: `POST /migrations/railway/import`
- PythonAnywhere payload import: `POST /migrations/pythonanywhere/import`
- Use `dryRun=true` first to validate mappings before applying.

## Audit Logs

- Access latest structured audit logs from `GET /ops/audit-logs`.

## Host Memory Alerts

ServerHoster can push host memory alerts to a webhook when memory usage crosses a configured threshold, eliminating the need for external monitoring cron jobs.

### Setup

1. **Configure via API:**
   - `GET /settings/alerts/memory` — view current configuration
   - `PUT /settings/alerts/memory` — configure alerts with:
     - `enabled`: boolean (default: false)
     - `threshold`: number 1-100 (default: 80)
     - `webhookUrl`: string (required when enabled)
     - `webhookAuth`: string (optional Bearer token or custom Authorization header value)
   - `DELETE /settings/alerts/memory` — remove all alert settings

2. **Example configuration:**
   ```bash
   curl -X PUT http://localhost:8787/settings/alerts/memory \
     -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "enabled": true,
       "threshold": 80,
       "webhookUrl": "https://your-webhook-endpoint.com/alerts",
       "webhookAuth": "Bearer your-webhook-secret"
     }'
   ```

### Webhook Payload

When memory crosses the threshold, ServerHoster POSTs JSON to your webhook:

```json
{
  "event": "host_memory_threshold_crossed",
  "memoryUsedPercent": 85.2,
  "threshold": 80,
  "hostname": "server.example.com",
  "checkedAt": "2026-09-18T23:45:00.000Z",
  "loadAvg1m": 2.5,
  "disk": {
    "path": "/home/user/.survhub",
    "usedPercent": 65.3,
    "freeBytes": 50000000000
  }
}
```

### Anti-Spam Behavior

- Alerts fire **once** when memory crosses the threshold
- No repeated alerts while memory remains elevated
- Alert **re-arms** automatically when memory drops below threshold
- Check interval: every 5 minutes (same as existing health checks)

### Use Cases

- **Email alerts:** Configure a Grok Bot webhook routine to forward to email
- **Chat notifications:** Send to Slack/Discord webhook endpoints
- **Custom integrations:** POST to your own monitoring system

## HTTPS

1. Generate local certs from Settings or `POST /ops/https/generate`
2. Trust cert on your OS (instructions returned by API)
3. Start server with `SURVHUB_ENABLE_HTTPS=1`
4. Optional: set explicit paths using `SURVHUB_CERT_PATH` and `SURVHUB_KEY_PATH`
