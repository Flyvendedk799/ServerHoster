# Changelog

All notable changes to LocalSURV are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

> Production-readiness sequence in flight. See [ROADMAP.md](ROADMAP.md) for the full plan.

### Added

- **Emailer — two-way email conversations per service** at `/emailer`. Mailboxes (`support@app.com` or `*@app.com` catch-alls) are linked to services; inbound mail arrives at the token-guarded, rate-limited `POST /emailer/inbound` (one-click Cloudflare Email Worker relay with fallback forward, or any JSON / raw-RFC 822 relay) and is threaded by `In-Reply-To`/`References` with a counterparty + subject fallback. Replies and new mail go out through the shared SMTP. Services can send through `POST /emailer/api/send` with a hashed per-mailbox token (one-click inject of `EMAILER_API_URL`/`EMAILER_API_TOKEN`/`EMAILER_FROM`), and receive inbound mail as a webhook. Folders, search, star/archive/spam, failed-send retry, sandboxed HTML view with remote images blocked by default. Per-service inbox via `/emailer?service=<id>`, an Inbox button with unread count on every service card, sidebar unread badge, live updates over the WebSocket, and n8n `email.received` / `email.sent` events.
- **n8n console.** The n8n tab is rebuilt around day-to-day use: Overview (health, CPU/memory, uptime, getting-started checklist), Workflows (activate/deactivate, import, per-workflow and bulk JSON export, delete, webhook URLs), Executions (filter, inspect in editor, retry, delete), LocalSURV events (one-click install creates and activates the receiving workflow through the n8n API, test-fire), Settings (public URL, timezone, execution pruning, task runners, shared SMTP for invites, extra env, image channel, AI Gateway) and Logs (filter/follow). Image updates via pull + recreate, and a "restart to apply" banner when saved settings differ from the running container.
- **n8n managed add-on (Plex-class).** Lifecycle, public `WEBHOOK_URL`, encryption/API-key bootstrap, one-click AI Gateway consumer-token wiring, workflow list, LocalSURV event webhook starters (including `license.*`), and diagnostics. Command Palette entry; `/n8n` gated in auth prefixes.
- **License Server v1** at `/license`. SQLite products/keys/activations/audit; public rate-limited `POST /license/v1/validate` (SHA-256 keys only); admin mint/revoke/extend; Email key send; `LICENSE_SERVER_URL` project inject; Domains/Secrets helpers; n8n `license.*` webhooks.
- **Durable API/MCP token.** ServerHoster now persists a single 40-character Bearer token in encrypted settings storage (survives restarts and redeploys). Operators copy it from `Settings → Dev Tools → API / MCP Token` once and use it in MCP clients (Grok Bot, Claude Desktop) or REST API calls. On first start, seeds from `SURVHUB_AUTH_TOKEN` if set; after that, the persisted token is the source of truth. Rotatable from the UI (invalidates old token immediately). See [docs/mcp.md](docs/mcp.md) and [docs/operations.md](docs/operations.md).
- **Companion app pairing.** `Settings → Companion` on the dashboard mints a short-lived, single-use QR pairing code; a phone redeems it at `POST /companion/pair/claim` for a scoped device token. Codes and tokens are stored as SHA-256 hashes only. Paired devices reach an explicit allowlist of fleet-status, log and metrics reads, and may start, stop, restart, redeploy and roll back — never secrets, env, database contents, terminals, backups or a second pairing. Revocable instantly from the dashboard. See [docs/companion-app.md](docs/companion-app.md).
- **`companion/`** — the companion mobile app itself: an installable, offline-aware React PWA with QR scanning, multi-machine pairing, live logs and service controls. Self-contained project with its own dependencies and CI; `companion/scripts/split-to-own-repo.sh` splits it into a standalone repository with history.
- `SURVHUB_PUBLIC_URL` and `SURVHUB_COMPANION_APP_URL` configuration. The latter is also allowed through CORS automatically and switches the pairing QR to a deep link.
- `SURVHUB_TRUST_PROXY` — believe `X-Forwarded-For` from a proxy you run. Without it, everything behind cloudflared/nginx shares one `req.ip`: per-IP rate limits become a single global bucket and a paired device's last-seen address is the tunnel's.
- Companion device writes are recorded in the audit log as `companion:<device-id>`, with the method, path, resulting status, source IP and User-Agent — refused writes included.

### Fixed

- **n8n workflow listing never authenticated.** The add-on injected an `N8N_API_KEY` env var that n8n does not read; the Public API key has to be created in n8n (Settings → n8n API). The tab now asks for that key, verifies it against the API before storing it, and always calls the API on loopback. Login over plain http (no https public URL) works again via `N8N_SECURE_COOKIE=false`; `N8N_PROXY_HOPS=1` is set behind a public URL.
- **Global MCP reliability for external agents.** `POST /mcp` now uses Streamable HTTP **JSON responses** (stateless), bounds Docker/disk probes and tool work so ops bots no longer hang until client `-32001`, and returns auth failures as fast **401** with JSON-RPC `-32000` (no longer reuses the timeout error code). See [docs/mcp.md](docs/mcp.md).

### Changed

- **Companion reads are now an allowlist, not a denylist.** The denylist named `/secrets`, `/backup` and `/services/:id/env` and read as complete, while still serving a paired phone `GET /databases/:id` (every managed database's connection string in the clear), `/databases/:id/tables/:schema/:table/preview` (any row of any table), `/databases/:id/backups/:backupId/download` (the whole dump) and `/services/:id/requests` (the request inspector's captured Authorization headers). A device now reaches only the named fleet-status, log and metrics routes; everything else answers `403 COMPANION_SCOPE_DENIED`.
- A wrong pairing code is charged to the caller, not to the pairing. Previously five bad guesses deleted the pending pairing — and since `POST /companion/pair/claim` is unauthenticated by necessity, anyone able to reach it could destroy the operator's on-screen QR at will. The pairing now survives, a caller is cut off after 8 wrong guesses in 5 minutes, and the failed-attempt count is shown next to the QR so the operator can decide to cancel.
- `POST /companion/{heartbeat,unpair}` no longer require `control` scope. Self-revocation is not a privilege: a read-only phone left in a taxi is exactly the case where "forget this server" has to work from the phone.
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
