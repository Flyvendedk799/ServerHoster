# Changelog

All notable changes to LocalSURV are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

> Production-readiness sequence in flight. See [ROADMAP.md](ROADMAP.md) for the full plan.

### Added

- (none yet)

### Changed

- README repositioned around the self-hosted PaaS model with pluggable public-exposure adapters; explicit platform-support matrix added.

### Pending verification (claimed in 0.1.0-alpha but not independently re-tested)

- Live build log streaming end-to-end (deploy.ts emits `type: "build_log"` events; UI consumption to be re-verified).
- Service ↔ database `linked_database_id` auto-injection of `DATABASE_URL` at service boot.
- Cloudflare named-tunnel ingress mutation serialization under concurrent edits.

### Planned for 0.2.0

- GitHub webhook HMAC signature verification (`X-Hub-Signature-256`).
- CORS lockdown to same-origin by default.
- Hardened `install.sh` (variable quoting, `LOCALSURV_VERSION` pin, SHA256 verification).
- `localsurv reset-admin` CLI subcommand for password recovery.
- Per-endpoint rate limits on `/auth/*` and `/webhooks/*`.
- Windows support via PowerShell installer + `node-windows` service wrapper.
- macOS notarization in tagged-release CI.
- Pluggable `TunnelAdapter` interface with ngrok and Tailscale Funnel adapters.
- Tag-driven release workflow producing signed npm/Docker/Homebrew/.pkg/.msi artifacts (cosign keyless OIDC).
- Request inspector (per-service inbound traffic log).
- Optional `/metrics` Prometheus endpoint.
- Auto-update version-check banner (opt-out via `LOCALSURV_NO_UPDATE_CHECK=1`).
- Scheduled DB backups via `node-cron`.

---

## [0.1.0-alpha] - 2026-05-03

First public-readiness milestone — feature-complete for single-machine self-host on macOS and Linux. Not yet recommended for untrusted networks; security hardening and signed releases land in 0.2.0.

### Added

- **Phase 1** — Host-based reverse proxy, service deletion endpoint + UI, React error boundary, global toast-based API error handling, ACME HTTP-01 reachability preflight.
- **Phase 2** — Build log streaming via WebSocket (`type: "build_log"` events), deployment progress phases (`cloning → installing → building → done`), `started_at` / `finished_at` / `branch` / `trigger_source` columns, dedicated service logs page with filter/search/download/auto-scroll, deployments page with duration, branch, trigger source, redeploy, color-coded status, PATCH validation with inline field errors.
- **Phase 3** — Encrypted GitHub PAT storage, private repo cloning via URL injection, SSH key config with public-key display, paginated GitHub repo listing, idempotent webhook registration.
- **Phase 4** — Cloudflared managed child process with auto-restart, Cloudflare Tunnel + DNS CNAME + ingress rule auto-registration, DNS-01 ACME challenge via Cloudflare DNS API, Settings UI with live tunnel output.
- **Phase 5** — Dashboard with system score, disk/docker/memory cards, live service grid, recent deployments. Per-service metrics collector (30s) via `ps` / `docker stats`, 24h retention. Notifications table + bell + optional Discord/Slack webhook forwarder. System health loop emitting disk/docker warnings.
- **Phase 6** — CSS design token system, Inter font, dark/light theme toggle with localStorage persistence, collapsible icon sidebar, `confirmDialog()` API replacing `window.confirm`, responsive mobile layout.
- **Phase 7** — Database credentials captured on create, admin panel with live container status, `pg_dump`/`mysqldump`/`mongodump` backups with one-click restore, seed SQL runner, service → database linking that auto-injects `DATABASE_URL`.
- **Phase 8** — Service dependency graph with ordered start + cycle detection, dependent stop warnings, project-level start-all/stop-all/restart-all/deploy-all, project env vars inherited by services, idempotent docker-compose re-import preserving `depends_on`, environment tags (production/staging/development) with filter + color-coded cards.
- **Phase 9** — README, getting-started guide, full API reference, configuration reference, troubleshooting guide, operations guide, QA matrix.
- **Phase 10** — 18 new unit and integration tests, full test suite green (33 passing), ESLint flat config + Prettier config, GitHub Actions CI (build + test + lint + docker build).
- **Phase 11** — Fastify serves the built React dashboard statically, multi-stage Dockerfile bundling web + server with `tini` and Docker CLI, `install.sh` one-liner with systemd/launchd service installation, `survhub` CLI with `init`/`start`/`version`/`help`, Homebrew formula. Single static binary not yet shipped.
- **Phase 12** — LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT, issue/PR templates, release documentation, SVG favicon, landing page scaffold.

### Fixed

- Git poller was matching the literal string `\t` instead of a tab character, so it never detected remote changes.
- `acme-client` was imported with the wrong shape (`{ acme, HttpClient }`); replaced with `import * as acme`.
- `db.ts` had an unterminated multi-line string literal in the certificates migration; converted to a template literal.
- `app.ts` referenced the `tls` namespace without importing it.
- Deploy integration test fixtures now initialize with `git init -b main`, unblocking environments whose `init.defaultBranch` is `master`.

### Security

- AES-256-GCM encryption at rest for service env vars, GitHub PAT, Cloudflare API token, and Cloudflare tunnel token.
- `ENCRYPTED_SETTINGS` whitelist refuses plaintext read of any encrypted key via the HTTP API.
- `/settings/github/pat` and `/cloudflare/api-token` validate tokens against their upstream APIs before persisting.

### Known gaps (do not deploy to untrusted networks until addressed in 0.2.0)

- `/webhooks/github` does not yet validate the `X-Hub-Signature-256` header.
- CORS is configured permissively (`origin: true`).
- `install.sh` does not pin a release tag and does not verify a SHA256SUMS file.
- No Windows installer.
- Released artifacts are not signed.

---

## [0.0.1] - initial prototype

- Project/service CRUD
- Process + Docker services
- Git deploy pipeline
- Basic dashboard
- Auth (token + session)
- Backup export/import
