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

### CI for every repository

Turn on **CI for every repository** at the top of the Pipelines list to stop attaching pipelines one by one.

- Every service linked to a GitHub repo gets a pipeline, and services added later get one within a minute.
- To test a repo, add `.survhub/ci.yml` to it. Before queuing a run, ServerHoster asks GitHub whether the commit has that file. A repo without it is not cloned and gets no commit status. If GitHub cannot be asked (no token, or an API error), the run is queued anyway and ends as **skipped** when the file is missing.
- Automatic pipelines never hold a deploy. Editing one turns it into a normal pipeline that you control, for example to turn on **Hold deploy until CI passes**. Deleting one turns CI off for that service, and the switch does not bring it back.
- Each repo also gets a `push` + `pull_request` webhook. This needs a GitHub token (Settings → GitHub), `SURVHUB_WEBHOOK_SECRET`, and either `SURVHUB_PUBLIC_URL` or a webhook URL saved under Settings. The CI page names whatever is missing. Webhooks respect each service's auto-deploy switch, so adding one never starts deploys on a service that has auto-deploy off.
- `POST /api/ci/auto/sync` runs the sync immediately. Pass `{"force": true}` to re-register every webhook, for example after you change the secret.
- New repos need only `.survhub/ci.yml`. Delete `.github/workflows/` (or disable Actions for the repo), or GitHub keeps running and billing those workflows too.

### Triggers

- By default a pipeline runs on pushes to the service's deploy branch and on pull requests that target it (`opened`, `synchronize`, `reopened`). Closing a pull request cancels its run.
- **Other branches** takes a comma-separated list of branch names or globs (`feature/*`, `release-*`, `*`). Names are compared against the full ref, so `refs/heads/feature/main` is `feature/main`, not `main`. Tag pushes are ignored.
- Only the deploy branch deploys. Branch and pull request runs never deploy, even with **Hold deploy until CI passes** on.
- Pull requests from forks are skipped. Their code and `.survhub/ci.yml` come from someone without push access, and a job can read the secrets it lists. Same-repository pull requests get those secrets, the same as a branch push.
- A newer push to the same branch, or a new commit on the same pull request, supersedes the older run. A queued run is dropped; a running run on a non-deploy branch or pull request is cancelled.
- Triggers are set on the pipeline. The `on:` key of a GitHub Actions workflow is not read, because the trigger is decided before the repository is checked out.
- Pull request and branch CI need `SURVHUB_WEBHOOK_SECRET`. With `SURVHUB_WEBHOOK_INSECURE=1` and no secret, they are refused and the CI page says so; deploy-branch pushes behave as before.
- Webhooks created before this version only send `push`. Press **Set up webhook** on the service again to add `pull_request`.

### Commit statuses

Each run reports a commit status named `survhub-ci/<pipeline>`: pending while queued or running, then success, failure (a step failed, timed out, or hit the disk cap), or error (cancelled, superseded, or a setup problem). With `SURVHUB_PUBLIC_URL` set, the status links to `/ci?run=<id>`.

Statuses use the GitHub token saved under Settings. A classic token needs `repo` (or `repo:status`); a fine-grained token needs **Commit statuses: Read and write**. If GitHub refuses, the run still finishes, and the reason is shown on the run and in the service log. The token is never written to logs.

### Limits and speed

- Each job gets a hard memory cap with no swap, a CPU cap, 512 processes, a 16384 open-file limit, and the pipeline timeout. Defaults: 1 CPU, 2048 MB, 20 minutes.
- A job can briefly use up to twice its CPUs (at most 4) when the host is idle. It runs at low CPU and disk priority, so services on the host win under contention.
- **Parallel jobs** is automatic: about one job per 2 CPU cores and per 2.5 GB of free RAM, between 1 and 4. A further job starts only while all running jobs fit in the **host budget** (50% of CPUs and RAM by default) and 1 GB of RAM stays free. Otherwise it waits in line, in order. One job always runs, even if it is larger than the budget.
- npm, pnpm, yarn, pip and Go caches are kept per repository under the data directory (5 GB per repository by default, oldest files pruned; 0 turns caching off). **Clear cache** on a pipeline removes it.
- Checkouts are shallow. Pull requests fetch only `refs/pull/<n>/head`. A local image is not pulled again.
- A workspace that grows past **Workspace MB** (10 GB by default) stops the job.

### Isolation

- The container runs as a non-root user, with no new privileges, all capabilities dropped, and no Docker socket. Its own log driver is off; output is kept in the run.
- The root filesystem is read-only by default. Only `/workspace`, `/cache`, and `/tmp` (a RAM disk of up to half the memory cap) are writable. Turn **Read-only container filesystem** off for an image that writes elsewhere, for example a global `npm install -g`.
- Jobs use their own Docker network, `survhub-ci`, with no `host.docker.internal`. When ServerHoster runs as root on Linux with Docker's iptables enabled, it also blocks jobs from reaching the host and private networks (DNS is allowed). Otherwise the CI page shows that this block is not in place.

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
