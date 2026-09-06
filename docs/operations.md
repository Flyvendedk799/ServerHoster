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

- Set `SURVHUB_AUTH_TOKEN` to a strong value.
- Set `SURVHUB_SECRET_KEY` to a long random key.
- In production, never run with empty `SURVHUB_SECRET_KEY`.
- Optionally bootstrap a local admin user via `POST /auth/bootstrap`.

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

## HTTPS

1. Generate local certs from Settings or `POST /ops/https/generate`
2. Trust cert on your OS (instructions returned by API)
3. Start server with `SURVHUB_ENABLE_HTTPS=1`
4. Optional: set explicit paths using `SURVHUB_CERT_PATH` and `SURVHUB_KEY_PATH`
