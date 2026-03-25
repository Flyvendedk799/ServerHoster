# SURVHub

SURVHub is a local-first hosting control plane for running projects on your own machine (Mac mini, Windows PC, Linux server) with a browser dashboard.

## What It Covers

- Project and service overview dashboard
- Process services (`node`, `python`, static commands)
- Docker-backed services and one-click local databases
- Live logs via WebSocket stream
- Reverse-proxy route management
- Git deploy + build pipeline + rollback endpoint
- Backup export/import
- Structured audit log stream (`/ops/audit-logs`)
- Migration import endpoints for Railway/PythonAnywhere metadata

## Quick Start

1. Install dependencies:
   - `npm install`
2. Start API server:
   - `npm run dev -w @survhub/server`
3. Start dashboard:
   - `npm run dev -w @survhub/web`
4. Open:
   - Dashboard: `http://localhost:5173`
   - API: `http://localhost:8787`

## Environment Variables

- `SURVHUB_PORT` - API port (default `8787`)
- `SURVHUB_HOST` - bind host (default `0.0.0.0`)
- `SURVHUB_AUTH_TOKEN` - shared login password and bearer token
- `SURVHUB_SECRET_KEY` - encryption key for secret env vars (required in production)
- `SURVHUB_ENABLE_HTTPS=1` - enable HTTPS listener when cert/key exist
- `SURVHUB_CERT_PATH` and `SURVHUB_KEY_PATH` - TLS cert/key paths
- `SURVHUB_WS_PATH` - websocket endpoint path (default `/ws`)
- `SURVHUB_DATA_DIR` - data root (db/logs/projects/certs/scripts)

## Security Configuration

- Set `SURVHUB_AUTH_TOKEN` to enforce bearer-token auth on all protected endpoints.
- Set `SURVHUB_SECRET_KEY` to encrypt secret environment variables at rest.
- Login endpoint (`/auth/login`) issues persistent session tokens stored in SQLite.
- Admin bootstrap endpoint: `/auth/bootstrap` (first user only).
- WebSocket logs require the same token parity as API calls.

## Runtime Hardening Implemented

- Service action locking to avoid concurrent start/stop race conditions
- Crash backoff with capped exponential restart delay
- Manual-stop protection to prevent unintended auto-restart loops
- Runtime reconciliation after daemon restart (running -> stopped)
- Log retention trimming per service

## Build and Test

- Build all packages: `npm run build`
- Server tests: `npm run test -w @survhub/server`
- Web smoke tests: `npm run test:smoke -w @survhub/web`

## Operator Docs

- [Operations Guide](docs/operations.md)
- [Cross-Platform QA Matrix](docs/qa-matrix.md)
