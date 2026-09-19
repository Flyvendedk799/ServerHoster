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

### MCP client timeouts (ops bots)

External agents (e.g. Grok Bot via `mcp-remote` → `POST http://<host>:8787/mcp`) should:

1. Use the **Settings → Dev Tools → API / MCP Token** value as `Authorization: Bearer …` (same token as REST).
2. Set a **client timeout of ≥ 30s** (60s is comfortable for health/log tools; raise further for `redeploy_service`).
3. Treat client `-32001 Request timed out` as “no response in time” — not as an auth error. Auth failures return **401** with JSON-RPC `-32000` immediately. See [docs/mcp.md](./mcp.md).

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
