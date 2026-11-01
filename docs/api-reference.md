# API Reference

All endpoints are served by the Fastify API on `SURVHUB_PORT` (default `8787`).


## Model Context Protocol (MCP)

ServerHoster provides an MCP endpoint to allow AI bots (like Grok Bot or Claude) to control the server.

- **Endpoint:** POST /mcp
- **Spec:** Model Context Protocol (JSON-RPC 2.0 over HTTP/SSE)
- **Authentication:** Requires Authorization: Bearer <SURVHUB_AUTH_TOKEN>
- **More Info:** See [MCP Documentation](./mcp.md) for a complete list of tools and client setup instructions.

## Authentication

Every request outside the unauthenticated routes carries `Authorization: Bearer <token>`, where the token is one of:

- **Dashboard session** — returned by `POST /auth/login`. Expires after `SURVHUB_SESSION_TTL_MS` (default 12 h) and is gone when the `sessions` table is cleared. Meant for the dashboard, not for automation.
- **Automation API token** (`shk_…`) — long-lived, revocable machine credential for scripts and agents. Minted in **Settings → API tokens**, via `POST /auth/tokens`, or on the host with `survhub token create` (see [operations.md](./operations.md#automation-api-tokens)). Survives restarts; stops working when revoked or past its optional expiry. Only its SHA-256 hash is stored, so it is shown exactly once. Scope `admin` = the whole API **except** managing API tokens (`/auth/tokens*` answers `403` with `code: "API_TOKEN_SCOPE_DENIED"`). Mutating requests made with a token are written to the audit log as actor `apitoken:<id>`.
- **Durable API / MCP token** (legacy, single shared value in Settings → Dev Tools) or `SURVHUB_AUTH_TOKEN`.

- Unauthenticated routes: `/health`, `/onboarding`, `/auth/bootstrap`, `/auth/login`, `/.well-known/acme-challenge/*`, `/webhooks/github`

Errors are returned as `{ "error": "message" }` with the appropriate HTTP status code. Validation failures from route schemas return `400` with `{ "error": "Validation failed", "fields": { "fieldName": "reason" } }`.

---

## Health & system

| Method | Path                               | Description                                                  |
| ------ | ---------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/health`                          | Liveness probe, returns `{ ok: true }`                       |
| `GET`  | `/health/system`                   | Disk, Docker daemon, memory, load avg, score 0–100, warnings |
| `GET`  | `/metrics/system`                  | Host uptime, memory, CPU count, platform                     |
| `GET`  | `/metrics/services`                | Latest CPU/memory sample per running service                 |
| `GET`  | `/metrics/services/:id?minutes=60` | Metrics history for a service                                |
| `GET`  | `/onboarding`                      | Whether any projects exist and if auth is enabled            |

## Auth

| Method | Path              | Body                      | Notes                                    |
| ------ | ----------------- | ------------------------- | ---------------------------------------- |
| `POST` | `/auth/bootstrap` | `{ username, password }`  | Creates the first user; 8+ char password |
| `POST` | `/auth/login`     | `{ username?, password }` | Returns `{ token }`                      |
| `POST` | `/auth/logout`    | —                         | Invalidates the current session          |

### Automation API tokens

Session-only: callable with a dashboard session (or `SURVHUB_AUTH_TOKEN`), never with an API token, the legacy durable token or a paired companion device — so a leaked token cannot mint itself a successor.

| Method   | Path               | Body                                | Notes                                                                                                                    |
| -------- | ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/auth/tokens`     | —                                   | `{ tokens: [{ id, name, tokenPrefix, scopes, createdAt, lastUsedAt, expiresAt, revokedAt, status }] }` — never the secret |
| `POST`   | `/auth/tokens`     | `{ name, expiresInDays? }`          | `expiresInDays` 1–3650 or omitted/`null` for no expiry. Returns the token metadata plus `token` (plaintext, **once**)     |
| `DELETE` | `/auth/tokens/:id` | —                                   | Revoke; effective immediately. `404` for an unknown id. Revoking twice is a no-op                                         |

`status` is `active`, `expired` or `revoked`. `last_used_at` is updated at most once a minute per token.

## Projects

| Method   | Path                        | Body                               | Description                                                  |
| -------- | --------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/projects`                 |                                    | List projects                                                |
| `POST`   | `/projects`                 | `{ name, description?, gitUrl? }`  | Create a project                                             |
| `PUT`    | `/projects/:id`             | partial update                     | Update project                                               |
| `DELETE` | `/projects/:id`             |                                    | Delete project + cascade services/databases                  |
| `POST`   | `/projects/from-template`   | `{ name, template, projectName? }` | Scaffold a `node-api` / `python-api` / `static-site` project |
| `POST`   | `/projects/:id/start-all`   |                                    | Start every service in the project                           |
| `POST`   | `/projects/:id/stop-all`    |                                    | Stop every service                                           |
| `POST`   | `/projects/:id/restart-all` |                                    | Restart every service                                        |
| `POST`   | `/projects/:id/deploy-all`  |                                    | Redeploy every service with a configured `github_repo_url`   |
| `GET`    | `/projects/:id/env`         |                                    | List project-level env vars (inherited by all services)      |
| `POST`   | `/projects/:id/env`         | `{ key, value, isSecret? }`        | Upsert project env var                                       |
| `DELETE` | `/projects/:id/env/:key`    |                                    | Remove a project env var                                     |

## Services

| Method   | Path                               | Body                                                                                                                                  | Description                                                                             |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/services`                        |                                                                                                                                       | List with joined domain, latest commit, and latest successful Git update metadata       |
| `POST`   | `/services`                        | `{ projectId, name, type, command?, workingDir?, dockerImage?, port?, autoRestart?, maxRestarts?, startMode?, healthcheckPath? }`     | Create service                                                                          |
| `PATCH`  | `/services/:id`                    | `{ name?, type?, command?, workingDir?, dockerfile?, githubRepoUrl?, githubBranch?, port?, domain?, githubAutoPull?, autoRestart?, dependsOn?, environment?, linkedDatabaseId? }` | Validated update — returns 400 with `fields` map on validation errors                   |
| `DELETE` | `/services/:id?purgeDisk=true`     |                                                                                                                                       | Stop + cascade delete; optional working-dir removal                                     |
| `POST`   | `/services/:id/start`              |                                                                                                                                       | Start (with dependency resolution)                                                      |
| `POST`   | `/services/:id/stop`               |                                                                                                                                       | Stop; warns dependents via service log                                                  |
| `POST`   | `/services/:id/restart`            |                                                                                                                                       | Restart                                                                                 |
| `GET`    | `/services/:id/github-sync-status` |                                                                                                                                       | Compare tracked GitHub branch HEAD against the latest local deployment hash             |
| `POST`   | `/services/:id/redeploy`           |                                                                                                                                       | Redeploy current branch HEAD from `github_repo_url`                                     |
| `GET`    | `/services/:id/env`                |                                                                                                                                       | Service env vars (secrets masked)                                                       |
| `POST`   | `/services/:id/env`                | `{ key, value, isSecret? }`                                                                                                           | Add env var                                                                             |
| `DELETE` | `/services/:id/env/:envId`         |                                                                                                                                       | Remove env var                                                                          |
| `GET`    | `/services/:id/logs`               |                                                                                                                                       | Last 1000 log lines                                                                     |
| `POST`   | `/services/import-compose`         | `{ projectId, composeContent? \| composeFilePath?, workingDir? }`                                                                     | Idempotent compose importer (updates by `compose_service_name`, preserves `depends_on`) |
| `POST`   | `/services/deploy-from-github`     | `{ projectId, name, repoUrl, branch?, port?, domain?, startAfterDeploy?, autoPull? }`                                                 | One-shot: create service + deploy from git + optional proxy route                       |

## Deployments

| Method | Path                    | Body                               | Description                                                     |
| ------ | ----------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/deployments`          |                                    | List all deployments (includes in-flight with `status=running`) |
| `POST` | `/deployments/from-git` | `{ serviceId, repoUrl?, branch? }` | Deploy and auto-start                                           |
| `POST` | `/deployments/rollback` | `{ serviceId, deploymentId }`      | Rebuild the target commit hash                                  |

Deployment row columns: `id`, `service_id`, `commit_hash`, `status` (`running`/`success`/`failed`), `build_log`, `created_at`, `started_at`, `finished_at`, `branch`, `trigger_source` (`manual`/`webhook`/`gitops-poller`/`rollback`).

## Databases

| Method   | Path                           | Body                                                                     | Description                                         |
| -------- | ------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `GET`    | `/databases`                   |                                                                          | List with live Docker `container_status`            |
| `GET`    | `/databases/:id`               |                                                                          | Detail with fresh connection string                 |
| `POST`   | `/databases`                   | `{ projectId, name, engine, port, username?, password?, databaseName? }` | Create (pulls image, starts container)              |
| `POST`   | `/databases/:id/start`         |                                                                          | Start container                                     |
| `POST`   | `/databases/:id/stop`          |                                                                          | Stop container                                      |
| `POST`   | `/databases/:id/restart`       |                                                                          | Restart container                                   |
| `DELETE` | `/databases/:id`               |                                                                          | Force-remove container + unlink services            |
| `GET`    | `/databases/:id/logs?tail=500` |                                                                          | Container logs                                      |
| `POST`   | `/databases/:id/backup`        |                                                                          | Run `pg_dump`/`mysqldump`/`mongodump`               |
| `GET`    | `/databases/:id/backups`       |                                                                          | List backups                                        |
| `POST`   | `/databases/:id/restore`       | `{ backupId }`                                                           | Restore from backup                                 |
| `POST`   | `/databases/:id/seed`          | `{ sql }`                                                                | Pipe SQL into the container                         |
| `POST`   | `/databases/link`              | `{ serviceId, databaseId: string \| null }`                              | Link/unlink a service to auto-inject `DATABASE_URL` |

## Resources (dependency-aware provisioning)

Managed resources are local backend stacks — a local Supabase stack, a managed Postgres/MySQL/Mongo container, Redis — provisioned per service based on a dependency scan of its repo. Registered profiles: `supabase`, `postgres`, `mysql`, `mongo`, `redis`, `manual` (`redis` is detect/plan-only — its provisioning stays on `/databases` for now). `postgres`, `mysql`, and `mongo` provision through the same primitive as `POST /databases` — the container is a first-class legacy database too — and inject `DATABASE_URL` into the linked service. Resource secrets are stored AES-256-GCM encrypted; responses only ever contain masked `value_preview`s — the service-role key, JWT secret, and internal DB URL are **never** returned by any route.

| Method   | Path                                      | Body                                                                                                   | Description                                                                                    |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET`    | `/resources/profiles`                     |                                                                                                        | Registered profile ids + labels                                                                |
| `GET`    | `/resources/scans`                        |                                                                                                        | Latest persisted dependency scan per service                                                   |
| `GET`    | `/resources/scans/:serviceId`             |                                                                                                        | Latest scan for one service (errors if never scanned)                                          |
| `POST`   | `/resources/scans/:serviceId/run`         |                                                                                                        | Re-scan the working dir; returns `{ scan, plans, recommended }`                                |
| `POST`   | `/resources/provision`                    | `{ serviceId, profile, mode?, restart?, name?, secrets?, disabledSecrets?, serveFunctions?, config? }` | Provision via the profile; long-running, progress streams over WS                              |
| `GET`    | `/resources`                              |                                                                                                        | List resources with secret previews + service links                                            |
| `GET`    | `/resources/:id`                          |                                                                                                        | Resource detail (config redacted, env values masked)                                           |
| `POST`   | `/resources/:id/start`                    |                                                                                                        | Start — Supabase via CLI (whole stack; start/restart re-reads `supabase status` and re-records ports/URLs/keys), Postgres/MySQL/Mongo act on the backing container |
| `POST`   | `/resources/:id/stop`                     |                                                                                                        | Stop                                                                                           |
| `POST`   | `/resources/:id/restart`                  |                                                                                                        | Restart                                                                                        |
| `DELETE` | `/resources/:id`                          |                                                                                                        | Remove stack + generated files; warns linked services, returns `{ ok, strandedServices }`      |
| `GET`    | `/resources/:id/logs?tail=500&source=all` |                                                                                                        | Container logs + `supabase functions serve` output; `source=containers\|functions\|all`        |
| `GET`    | `/resources/:id/env-requirements`         |                                                                                                        | Per-function + aggregate secret states with referencing source files                           |
| `POST`   | `/resources/:id/secrets`                  | `{ secrets?, disable?, enable? }`                                                                      | Upsert/disable secrets; rewrites the function env file and restarts a live serve process       |
| `POST`   | `/resources/:id/link`                     | `{ serviceId, envMap? }`                                                                               | Link (or re-link) to a service so env injection activates                                      |
| `POST`   | `/resources/:id/unlink`                   | `{ serviceId }`                                                                                        | Deactivate a link; env injection stops immediately                                             |
| `GET`    | `/resources/:id/migrations`               |                                                                                                        | What the next deploy would apply: repo vs recorded versions, `pending_versions`, `auto_migrate` |
| `POST`   | `/resources/:id/auto-migrate`             | `{ enabled }`                                                                                          | Turn deploy-time migration apply on/off for one Supabase stack (default on)                    |
| `GET`    | `/resources/:id/bootstrap/plan`           |                                                                                                        | Introspect the local DB (role enums, profile/org tables, triggers) + ordered operation preview |
| `POST`   | `/resources/:id/bootstrap`                | `{ email, password, fullName?, role?, makePlatformAdmin?, organization? }`                             | Create the first local user/admin/org via the local Auth admin API                             |

**Provisioning modes** (`mode`, Supabase): `schema-only` (default — `supabase migration up`, never runs seeds, never imports hosted data), `schema-and-seed` (`supabase db reset`, re-applies migrations then runs `supabase/seed.sql`), `empty` (skip migrations). `config.init=true` is the explicit confirmation to run `supabase init` when the repo has no `supabase/config.toml`.

**Env injection**: a linked Supabase resource injects `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and (non-static services only) `SUPABASE_SERVICE_ROLE_KEY`, plus `APP_URL` when the service has a URL. Precedence: project env → active resource links → legacy linked `DATABASE_URL` → `DATA_DIR` → service env (service env always wins). The same merged env is used at build and runtime, so static/Vite services with a repo are redeployed on provision (baked `VITE_*`) while process/docker services are restarted.

**Secret states** (env-requirements + `POST /resources/:id/secrets`): `generated` (created by LocalSURV), `provided` (user-pasted), `missing-optional` (function runs degraded), `disabled` (intentionally off locally), `missing-required`. Missing optional secrets never fail provisioning — the affected functions are marked `degraded` and the logs name the missing key plus the files referencing it.

**Bootstrap safety**: refuses any non-local target (`127.0.0.1` / `localhost` / `host.docker.internal` / `::1` only), is idempotent for an existing email (promotes the existing user) and an existing org slug (reuses it, with warnings), and returns `{ user_id, user_existed, profile, platform_admin, organization, membership, warnings }`. The password is used only for the local Auth admin call — never stored, never logged.

## Proxy routes

| Method   | Path                                 | Body                                | Description                      |
| -------- | ------------------------------------ | ----------------------------------- | -------------------------------- |
| `GET`    | `/proxy/routes`                      |                                     | List proxy routes                |
| `POST`   | `/proxy/routes`                      | `{ serviceId, domain, targetPort }` | Register route                   |
| `DELETE` | `/proxy/routes/:id`                  |                                     | Remove route                     |
| `GET`    | `/.well-known/acme-challenge/:token` |                                     | Served for Let's Encrypt HTTP-01 |

Host-based routing: any incoming request whose `Host` header matches a `proxy_routes.domain` is forwarded before Fastify's router runs.

## Settings / GitHub / SSH

| Method   | Path                           | Body                      | Description                                                             |
| -------- | ------------------------------ | ------------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/settings`                    |                           | Masked list of all settings                                             |
| `PUT`    | `/settings`                    | `{ key, value }`          | Write (auto-encrypted if in secret whitelist)                           |
| `DELETE` | `/settings/:key`               |                           | Remove                                                                  |
| `GET`    | `/settings/github/status`      |                           | PAT/webhook status, poll interval, saved webhook URL                    |
| `POST`   | `/settings/github/pat`         | `{ token }`               | Validates against `/user`, then stores encrypted                        |
| `DELETE` | `/settings/github/pat`         |                           | Remove                                                                  |
| `PUT`    | `/settings/github/webhook-url` | `{ url }`                 | Save the public GitHub webhook payload URL                              |
| `DELETE` | `/settings/github/webhook-url` |                           | Remove the saved GitHub webhook payload URL                             |
| `GET`    | `/settings/ssh`                |                           | Configured key path + public key (reads `.pub` or runs `ssh-keygen -y`) |
| `PUT`    | `/settings/ssh`                | `{ path }`                | Save SSH key path                                                       |
| `GET`    | `/github/repos`                |                           | Paginated list of the user's GitHub repos via the stored PAT            |
| `POST`   | `/github/webhook/ensure`       | `{ repoUrl, webhookUrl }` | Idempotent webhook registration                                         |

## Stripe

Keys for test and live mode are stored separately, encrypted, and are **never returned**: responses carry only a masked preview (`sk_test_…ab12`) and a non-reversible fingerprint. Every route is under `/api` and needs the dashboard session or an operator token. Test mode is the default everywhere; anything that writes to live Stripe, or injects live keys into an app, needs `confirmLive: true` (the dashboard asks you to type `LIVE`). Writes are audit-logged (`stripe.*`) without key material. Stripe errors surface only Stripe's `type` and `code` (in `meta`), never a message or key, and are never returned as `401`.

| Method   | Path                                  | Body / query                                                                                                     | Description                                                                                                  |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/stripe/status`                  |                                                                                                                  | Per mode: masked key info, last verified account, recorded setup (price/webhook/portal ids)                  |
| `PUT`    | `/api/stripe/keys/:mode`              | `{ secretKey?, publishableKey?, webhookSecret?, orgKey? }`                                                       | Store/replace keys (`mode` = `test`\|`live`). Prefix and mode are validated. Connected apps are updated (an `orgKey` change touches no app) |
| `DELETE` | `/api/stripe/keys/:mode?part=`        | `part` = `secret_key`\|`publishable_key`\|`webhook_secret`\|`org_key`\|`all` (required)                                  | Remove. Removing the secret key disconnects apps connected in that mode                                      |
| `POST`   | `/api/stripe/verify/:mode`            |                                                                                                                  | Calls Stripe `GET /v1/account`; returns name, country, currency, `charges_enabled`, `payouts_enabled`, `details_submitted`, `currently_due` |
| `POST`   | `/api/stripe/org/verify/:mode`        | `{ serviceId? , accountId? }` (one of them)                                                                      | Check the organization key against one member account (`Stripe-Context`). Returns the account state and `credential_path: "org-key"`; a success confirms which mode the key belongs to (required before org-key writes) |
| `GET`    | `/api/stripe/apps`                    |                                                                                                                  | Services with connection state, mode, `account_id`, `credential_path` (`org-key`\|`account-key`), last org verification, `webhook_secret` `{ configured, source: app\|mode }` (never the value), and `restart_needed` |
| `PUT`    | `/api/stripe/apps/:serviceId/account` | `{ accountId }` (`acct_…`, or `null` to clear)                                                                   | Choose the member account an already-connected app belongs to. Changing it drops the app's own webhook secret and verification |
| `POST`   | `/api/stripe/apps/:serviceId/connect` | `{ mode?, takeover?, confirmLive? }`                                                                             | Inject `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (if stored), `STRIPE_MODE` as encrypted system env. `409 env_conflict` if the app defines them itself unless `takeover: true`. Restart the app afterwards |
| `DELETE` | `/api/stripe/apps/:serviceId`         |                                                                                                                  | Remove the injected env                                                                                      |
| `POST`   | `/api/stripe/setup/product-price`     | `{ mode?, name, unitAmount, currency, interval, taxBehavior, lookupKey, serviceId?, priceEnvName?, confirmLive? }` | Idempotent product + recurring price (`unitAmount` in minor units, 900 = 9.00). `409 price_conflict` if the lookup key exists with other terms. Optionally writes the price id into a connected app |
| `POST`   | `/api/stripe/setup/webhook`           | `{ mode?, url, events?, serviceId?, confirmLive? }`                                                              | Idempotent webhook endpoint (https only). The signing secret Stripe returns at creation is stored encrypted, never returned, and pushed to connected apps. With `serviceId` on the org path it is kept for that app alone |
| `POST`   | `/api/stripe/setup/portal`            | `{ mode?, returnUrl?, serviceId?, confirmLive? }`                                                                | Idempotent Customer Portal configuration: cancel at period end, payment-method update, invoice history       |

Merchant verification, payout details and tax registration cannot be done with an API key; `verify` reports what is still missing. The same actions exist as MCP tools (see [MCP](./mcp.md)); there is deliberately no tool that accepts a key.

### Organization master key (optional)

If your accounts are grouped in a Stripe organization, one `sk_org_…` key (one per mode slot) can do setup inside any member account. It is **used only by ServerHoster** (dashboard, REST, MCP), is **never injected into an app** (apps keep receiving account-level keys), and is never returned; the status shows a masked preview and fingerprint like any other key.

- **Choosing the credential.** A setup call (`setup/*` with `serviceId`, and `org/verify`) uses the org key when the app has an account id (`PUT /api/stripe/apps/:id/account`) and an org key is stored for the app's mode. Otherwise it uses the account-level key exactly as before. Every result says which: `credential_path` (`org-key` or `account-key`) plus `account`. On the org path ServerHoster sends `Stripe-Version` (default `2026-10-28.endive`, the newest GA version on Stripe's changelog when this was written; override with the `stripe_org_api_version` setting) and `Stripe-Context: acct_…`. Calls on the account-key path carry neither header.
- **The slot's mode must be verified first.** Stripe does not put test/live in an org key's prefix, so the slot you chose is trusted only after `POST /api/stripe/org/verify/:mode` has seen `livemode` agree with it. Until then org-path writes fail with `409 org_key_unverified` and make no Stripe call. Replacing or removing the key clears the verification. `confirmLive` is still required for any live write, and a response reporting the wrong mode is refused.
- **Verify errors.** `org_key_invalid` (Stripe answered 401), `org_key_permission` (valid key, but it lacks the *Account: read* permission or the account is not in its organization), `mode_mismatch`, `account_mismatch`, `account_required`, `invalid_account`. None echoes Stripe's text or any key.
- **Per-app webhook secret.** On the org path the signing secret returned when an endpoint is created is stored encrypted *per app link* and injected as that app's `STRIPE_WEBHOOK_SECRET`. The per-mode secret (entered by hand) stays as the fallback; `secret_source` (`app`\|`mode`) says which is in use. Changing an app's account, or reconnecting it in another mode, drops its own secret.
- **Accounts.** Only a plain member account id (`acct_…`) is supported; the `platform/connected` form is refused as a possible follow-up.
- **Dashboard-only.** Creating the organization, new accounts and the API keys themselves has no documented API and is done in the Stripe Dashboard. Stripe advises using an org key only for work across several accounts.

Permissions to give the org key (restricted in Dashboard → Organization → API keys). The list is served by `GET /api/stripe/status` (`org.permissions`) and a test checks it against the calls the helpers make:

| Resource | Access | Used by |
| -------- | ------ | ------- |
| Account | read | Verify (`GET /v1/account`) |
| Products | write | Product + price |
| Prices | write | Product + price |
| Webhook endpoints | write | Webhook |
| Customer portal configuration | write | Customer portal |

## Cloudflare

| Method   | Path                        | Body                                                         | Description                                             |
| -------- | --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `GET`    | `/cloudflare/status`        |                                                              | Detailed tunnel state + recent `cloudflared` output     |
| `GET`    | `/cloudflare/detect`        |                                                              | Binary + version detection                              |
| `PUT`    | `/cloudflare/config`        | `{ accountId?, tunnelId?, zoneId?, cloudflaredBinaryPath? }` | Save IDs                                                |
| `PUT`    | `/cloudflare/api-token`     | `{ token }`                                                  | Validate against `/user/tokens/verify`, store encrypted |
| `DELETE` | `/cloudflare/api-token`     |                                                              | Remove                                                  |
| `PUT`    | `/cloudflare/tunnel-token`  | `{ token }`                                                  | Store encrypted                                         |
| `DELETE` | `/cloudflare/tunnel-token`  |                                                              | Remove                                                  |
| `POST`   | `/cloudflare/start`         |                                                              | Spawn managed `cloudflared tunnel run`                  |
| `POST`   | `/cloudflare/stop`          |                                                              | SIGTERM the child process                               |
| `POST`   | `/cloudflare/routes/ensure` | `{ domain, targetPort }`                                     | DNS CNAME + tunnel ingress rule                         |
| `POST`   | `/cloudflare/routes/remove` | `{ domain }`                                                 | Remove ingress rule                                     |

## Notifications

| Method | Path                                       | Body                                | Description                       |
| ------ | ------------------------------------------ | ----------------------------------- | --------------------------------- |
| `GET`  | `/notifications?unreadOnly=true&limit=100` |                                     | List notifications + unread count |
| `POST` | `/notifications/:id/read`                  |                                     | Mark one read                     |
| `POST` | `/notifications/read-all`                  |                                     | Mark all read                     |
| `PUT`  | `/notifications/webhook`                   | `{ url, kind: 'discord'\|'slack' }` | Configure external forwarder      |

## Backup / migration / ops

| Method | Path                                | Description                                         |
| ------ | ----------------------------------- | --------------------------------------------------- |
| `GET`  | `/backup/export`                    | Full DB snapshot as JSON                            |
| `POST` | `/backup/import`                    | `{ data }` restore                                  |
| `POST` | `/migrations/railway/import`        | Railway JSON import (supports `dryRun`)             |
| `POST` | `/migrations/pythonanywhere/import` | PythonAnywhere JSON import                          |
| `GET`  | `/ops/audit-logs?limit=100`         | Recent audit log rows                               |
| `GET`  | `/ops/https/status`                 | Local cert/key status                               |
| `POST` | `/ops/https/generate`               | `{ commonName?, altNames? }` self-signed generation |
| `GET`  | `/ops/install-scripts`              | systemd/launchd/winSC templates                     |

## Webhooks

| Method | Path               | Description                                             |
| ------ | ------------------ | ------------------------------------------------------- |
| `POST` | `/webhooks/github` | GitHub push event handler — redeploys matching services |

## WebSocket (`ws://host:port/ws?token=…`)

Events streamed to all authenticated subscribers:

| `type`                  | Shape                                                  | When                                                                                                                 |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `log`                   | `{ serviceId, level, message, timestamp }`             | New log line from a service                                                                                          |
| `service_status`        | `{ serviceId, status, lastExitCode }`                  | Status transition                                                                                                    |
| `build_log`             | `{ serviceId, deploymentId, line, stream, timestamp }` | Live build output chunk                                                                                              |
| `build_progress`        | `{ serviceId, deploymentId, phase }`                   | Phase transitions: cloning → installing → building → done / failed                                                   |
| `deployment_started`    | `{ serviceId, deploymentId, branch, trigger }`         | New deployment row created                                                                                           |
| `deployment_finished`   | `{ serviceId, deploymentId, status, durationMs }`      | Deployment row finalized                                                                                             |
| `metrics_sample`        | `{ serviceId, cpu, memoryMb, timestamp }`              | Metrics collector recorded a sample                                                                                  |
| `notification`          | `{ notification: { … } }`                              | New notification created                                                                                             |
| `tunnel_log`            | `{ line, timestamp }`                                  | Line from managed `cloudflared`                                                                                      |
| `tunnel_status`         | `{ running, pid?, reason? }`                           | Cloudflare Tunnel state change                                                                                       |
| `resource_status`       | `{ resourceId, status, profile }`                      | Managed resource transition (provisioning → running / failed / removed)                                              |
| `resource_provisioning` | `{ resourceId, step, message }`                        | Provisioning progress: preflight → init → start → status → migrate → functions → restart → bootstrap → done / failed |

## Example `curl`

```bash
# Bootstrap + log in
curl -s http://localhost:8787/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"super-secret-1234"}'

TOKEN=$(curl -s http://localhost:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"super-secret-1234"}' \
  | jq -r .token)

# Create a project
curl -s http://localhost:8787/projects \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"my-stack"}'
```

