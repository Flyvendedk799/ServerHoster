# SURVHub QA Matrix

## Scope

Validate critical paths on Windows, macOS, and Linux.

## Checklist

### Core Startup

- `npm install` succeeds
- `npm run build` succeeds
- API and dashboard boot successfully

### Auth and Security

- Login with `SURVHUB_AUTH_TOKEN` works
- API rejects unauthenticated protected routes
- WebSocket connection requires token
- Secret env vars are masked in UI and stored encrypted

### Runtime

- Process service start/stop/restart works
- Docker service start/stop/restart works
- `start_mode=auto` services start after daemon boot
- Healthcheck failure triggers restart flow

### Deploy

- Deploy from git creates deployment row
- Rollback reverts to selected deployment

### Proxy and HTTPS

- Proxy route creation blocks duplicate domain/port
- Proxy routing reaches target service
- HTTPS cert generation works
- HTTPS runtime works with trusted cert

### Backup

- Backup export produces valid payload
- Backup import restores payload without errors

### UI Parity

- Projects CRUD available
- Services env var management available
- Proxy route management available
- Backup import/export available
