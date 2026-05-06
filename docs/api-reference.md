# API Reference

All endpoints are served by the Fastify API on `SURVHUB_PORT` (default `8787`).

## Authentication

- Bearer token in `Authorization: Bearer <token>`, or
- Cookie session after `POST /auth/login`
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

| Method   | Path                           | Body                                                                                                                                  | Description                                                                             |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/services`                    |                                                                                                                                       | List with joined domain + latest commit                                                 |
| `POST`   | `/services`                    | `{ projectId, name, type, command?, workingDir?, dockerImage?, port?, autoRestart?, maxRestarts?, startMode?, healthcheckPath? }`     | Create service                                                                          |
| `PATCH`  | `/services/:id`                | `{ name?, type?, command?, workingDir?, port?, domain?, githubAutoPull?, autoRestart?, dependsOn?, environment?, linkedDatabaseId? }` | Validated update — returns 400 with `fields` map on validation errors                   |
| `DELETE` | `/services/:id?purgeDisk=true` |                                                                                                                                       | Stop + cascade delete; optional working-dir removal                                     |
| `POST`   | `/services/:id/start`          |                                                                                                                                       | Start (with dependency resolution)                                                      |
| `POST`   | `/services/:id/stop`           |                                                                                                                                       | Stop; warns dependents via service log                                                  |
| `POST`   | `/services/:id/restart`        |                                                                                                                                       | Restart                                                                                 |
| `POST`   | `/services/:id/redeploy`       |                                                                                                                                       | Redeploy current branch HEAD from `github_repo_url`                                     |
| `GET`    | `/services/:id/env`            |                                                                                                                                       | Service env vars (secrets masked)                                                       |
| `POST`   | `/services/:id/env`            | `{ key, value, isSecret? }`                                                                                                           | Add env var                                                                             |
| `DELETE` | `/services/:id/env/:envId`     |                                                                                                                                       | Remove env var                                                                          |
| `GET`    | `/services/:id/logs`           |                                                                                                                                       | Last 1000 log lines                                                                     |
| `POST`   | `/services/import-compose`     | `{ projectId, composeContent? \| composeFilePath?, workingDir? }`                                                                     | Idempotent compose importer (updates by `compose_service_name`, preserves `depends_on`) |
| `POST`   | `/services/deploy-from-github` | `{ projectId, name, repoUrl, branch?, port?, domain?, startAfterDeploy?, autoPull? }`                                                 | One-shot: create service + deploy from git + optional proxy route                       |

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

## Proxy routes

| Method   | Path                                 | Body                                | Description                      |
| -------- | ------------------------------------ | ----------------------------------- | -------------------------------- |
| `GET`    | `/proxy/routes`                      |                                     | List proxy routes                |
| `POST`   | `/proxy/routes`                      | `{ serviceId, domain, targetPort }` | Register route                   |
| `DELETE` | `/proxy/routes/:id`                  |                                     | Remove route                     |
| `GET`    | `/.well-known/acme-challenge/:token` |                                     | Served for Let's Encrypt HTTP-01 |

Host-based routing: any incoming request whose `Host` header matches a `proxy_routes.domain` is forwarded before Fastify's router runs.

## Settings / GitHub / SSH

| Method   | Path                      | Body                      | Description                                                             |
| -------- | ------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/settings`               |                           | Masked list of all settings                                             |
| `PUT`    | `/settings`               | `{ key, value }`          | Write (auto-encrypted if in secret whitelist)                           |
| `DELETE` | `/settings/:key`          |                           | Remove                                                                  |
| `GET`    | `/settings/github/status` |                           | `{ configured, tokenPrefix }`                                           |
| `POST`   | `/settings/github/pat`    | `{ token }`               | Validates against `/user`, then stores encrypted                        |
| `DELETE` | `/settings/github/pat`    |                           | Remove                                                                  |
| `GET`    | `/settings/ssh`           |                           | Configured key path + public key (reads `.pub` or runs `ssh-keygen -y`) |
| `PUT`    | `/settings/ssh`           | `{ path }`                | Save SSH key path                                                       |
| `GET`    | `/github/repos`           |                           | Paginated list of the user's GitHub repos via the stored PAT            |
| `POST`   | `/github/webhook/ensure`  | `{ repoUrl, webhookUrl }` | Idempotent webhook registration                                         |

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

| `type`                | Shape                                                  | When                                                               |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `log`                 | `{ serviceId, level, message, timestamp }`             | New log line from a service                                        |
| `service_status`      | `{ serviceId, status, lastExitCode }`                  | Status transition                                                  |
| `build_log`           | `{ serviceId, deploymentId, line, stream, timestamp }` | Live build output chunk                                            |
| `build_progress`      | `{ serviceId, deploymentId, phase }`                   | Phase transitions: cloning → installing → building → done / failed |
| `deployment_started`  | `{ serviceId, deploymentId, branch, trigger }`         | New deployment row created                                         |
| `deployment_finished` | `{ serviceId, deploymentId, status, durationMs }`      | Deployment row finalized                                           |
| `metrics_sample`      | `{ serviceId, cpu, memoryMb, timestamp }`              | Metrics collector recorded a sample                                |
| `notification`        | `{ notification: { … } }`                              | New notification created                                           |
| `tunnel_log`          | `{ line, timestamp }`                                  | Line from managed `cloudflared`                                    |
| `tunnel_status`       | `{ running, pid?, reason? }`                           | Cloudflare Tunnel state change                                     |

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
