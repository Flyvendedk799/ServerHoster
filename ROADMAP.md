# LocalSURV — Comprehensive Production Roadmap

> **Goal**: Transform SURVHub from a working prototype into a polished, self-hostable deployment platform that a developer can `git clone`, configure in under 5 minutes, and trust to run production workloads on their own hardware.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Phase 1 — Critical Fixes & Hardening](#2-phase-1--critical-fixes--hardening)
3. [Phase 2 — Core Experience Polish](#3-phase-2--core-experience-polish)
4. [Phase 3 — Private Repository & Auth Integration](#4-phase-3--private-repository--auth-integration)
5. [Phase 4 — Cloudflare Tunnel Integration](#5-phase-4--cloudflare-tunnel-integration)
6. [Phase 5 — Observability & Monitoring](#6-phase-5--observability--monitoring)
7. [Phase 6 — Dashboard UI/UX Overhaul](#7-phase-6--dashboard-uiux-overhaul)
8. [Phase 7 — Database Management Enhancement](#8-phase-7--database-management-enhancement)
9. [Phase 8 — Multi-Service Orchestration](#9-phase-8--multi-service-orchestration)
10. [Phase 9 — Documentation & Developer Experience](#10-phase-9--documentation--developer-experience)
11. [Phase 10 — Testing & CI/CD](#11-phase-10--testing--cicd)
12. [Phase 11 — Distribution & Packaging](#12-phase-11--distribution--packaging)
13. [Phase 12 — Community & Open Source Readiness](#13-phase-12--community--open-source-readiness)
14. [Priority Matrix](#14-priority-matrix)
15. [Architecture Decisions](#15-architecture-decisions)

---

## 1. Current State Assessment

### What Works Today

| Feature | Status | Notes |
|---------|--------|-------|
| Project/Service CRUD | ✅ Working | Basic create, list, delete |
| Process Services (node/python) | ✅ Working | spawn-based with auto-restart |
| Docker Services | ✅ Working | Via dockerode, container lifecycle |
| Git Deployment Pipeline | ✅ Working | Clone → detect → build → deploy |
| GitHub Auto-Pull (GitOps Poller) | ✅ Working | 60s interval `git ls-remote` checks |
| GitHub Webhooks | ✅ Working | Push events trigger redeploy |
| Reverse Proxy | ✅ Working | Domain → port routing via `http-proxy` |
| ACME/Let's Encrypt SSL | ✅ Scaffolded | HTTP-01 challenges, needs Cloudflare DNS |
| Dynamic SNI | ✅ Scaffolded | Cert lookup per-domain on TLS handshake |
| WebSocket Live Logs | ✅ Working | Real-time log streaming |
| Auth (Token + User + Session) | ✅ Working | Bootstrap + login + bearer auth |
| Encrypted Env Vars | ✅ Working | AES-256-GCM at rest |
| Backup Export/Import | ✅ Working | Full DB snapshot as JSON |
| Railway/PA Migration | ✅ Working | Dry-run + execute import |
| Service Settings Modal | ✅ Working | Edit name/port/domain/command live |
| Auto-Pull Toggle per Service | ✅ Working | Checkbox on card, PATCH endpoint |

### What's Missing or Broken

| Gap | Severity | Notes |
|-----|----------|-------|
| No service deletion via UI | 🔴 High | Can create services but never clean them up |
| No deployment log streaming | 🔴 High | Build output only visible after completion |
| SSL `acme-client` import may fail | 🟡 Medium | Uses named import `{ acme, HttpClient }` — needs verification against actual package exports |
| Git poller `split("\\t")` bug | 🟡 Medium | Uses escaped literal `\\t` instead of actual tab `\t` |
| Proxy doesn't actually intercept Host-based traffic | 🟡 Medium | Only matches `/proxy/*` prefix, not bare domain requests |
| Dashboard is minimal | 🟡 Medium | Shows only CPU/RAM/uptime, no service overview |
| No error boundaries in React | 🟡 Medium | Unhandled API errors crash the whole UI |
| No favicon/branding | 🟢 Low | Default Vite favicon |
| No mobile responsiveness | 🟢 Low | Sidebar layout breaks on small screens |
| README doesn't mention new features | 🟢 Low | GitHub deploy, auto-pull, SSL not documented |

---

## 2. Phase 1 — Critical Fixes & Hardening

> **Priority**: 🔴 MUST DO FIRST — bugs that will cause failures in real use.

### 1.1 Fix Git Poller Tab Split Bug

**File**: `apps/server/src/services/poller.ts` line 27

```diff
- const remoteHash = remotes.split("\\t")[0]?.trim();
+ const remoteHash = remotes.split("\t")[0]?.trim();
```

The escaped literal string `"\\t"` matches the two characters backslash-t, not a tab. `git ls-remote` outputs tab-separated values. This means the poller **never detects changes** and is silently broken.

### 1.2 Fix SSL Import Path

**File**: `apps/server/src/services/ssl.ts` line 2

The `acme-client` package's actual export structure needs verification. The current import `{ acme, HttpClient }` may not match the package's real API. Verify with:

```bash
node -e "const m = require('acme-client'); console.log(Object.keys(m))"
```

Expected fix (if default export):
```diff
- import { acme, HttpClient } from "acme-client";
+ import acme from "acme-client";
```

### 1.3 Fix Reverse Proxy Host-Based Routing

**File**: `apps/server/src/routes/proxy.ts`

The current proxy only catches requests under `/proxy/*`. Real domain-based routing should intercept **all** requests based on the `Host` header, not a URL prefix. This needs to happen at the HTTP server level before Fastify routes:

- Register a Fastify `onRequest` hook that checks the incoming `Host` header against `proxy_routes`.
- If matched, proxy the entire request to the target port.
- If not matched, let Fastify continue to API routes.

### 1.4 Add Service Deletion

**Files**: `apps/server/src/routes/services.ts`, `apps/web/src/pages/Services.tsx`

- Add `DELETE /services/:id` endpoint that:
  1. Stops the service if running
  2. Removes container if Docker
  3. Deletes all env vars, deployments, logs, proxy routes for this service
  4. Optionally removes the cloned project directory from disk
  5. Deletes the service row
- Add a "Delete" button to the service card with confirmation dialog

### 1.5 Add Error Boundaries & API Error Handling

**File**: `apps/web/src/components/ErrorBoundary.tsx` (NEW)

- Wrap the entire app in a React ErrorBoundary that catches render crashes
- Add a global `api()` error handler that shows toast notifications instead of silently failing
- Add loading states to all pages (currently they flash empty content)

### 1.6 Validate ACME Challenge Reachability

Before attempting SSL provisioning, add a pre-flight self-check:

```typescript
// In ssl.ts, before starting ACME flow:
const selfCheck = await fetch(`http://${domain}/.well-known/acme-challenge/self-test`);
if (!selfCheck.ok) {
  throw new Error(`Domain ${domain} is not reachable on port 80. SSL cannot be provisioned.`);
}
```

This prevents confusing Let's Encrypt rate-limit burns when the domain isn't actually pointed at the server.

---

## 3. Phase 2 — Core Experience Polish

> **Priority**: 🟡 Required for the "it just works" feeling.

### 2.1 Live Build Log Streaming

Currently, deployment builds run synchronously and the user sees nothing until complete. This is the single biggest UX gap.

**Implementation**:
- During `runBuildPipeline`, stream stdout/stderr lines through the existing WebSocket broadcast system
- Add a new event type `{ type: "build_log", serviceId, deploymentId, line }` 
- In the UI, show a live terminal-style output panel during deployment
- Persist the full log to the deployment record on completion

### 2.2 Deployment Status & Progress

- Add a `progress` field to the WebSocket broadcast: `cloning`, `installing`, `building`, `starting`
- Show a progress indicator on the service card during active deployments
- Add deployment duration tracking (`started_at` + `finished_at` on deployments table)

### 2.3 Service Logs Page

- Add a dedicated `/services/:id/logs` page with:
  - Full historical log viewer with infinite scroll
  - Log level filtering (info/warn/error)
  - Search/grep within logs
  - Download logs as `.txt`
  - Auto-scroll toggle

### 2.4 Deployment History Enhancement

- Show deployment duration, branch, and trigger source (manual/webhook/gitops-poller)
- Add "Redeploy" button (re-run current branch HEAD)
- Show build log expandable/collapsible per deployment
- Color-code success/failed deployments

### 2.5 Configuration Validation on Save

When saving service settings via the modal:
- Validate port is not already in use by another service
- Validate domain is syntactically correct
- Validate working directory exists on disk
- Show inline validation errors, not just alerts

---

## 4. Phase 3 — Private Repository & Auth Integration

> **Priority**: 🟡 Required for real-world use — most repos are private.

### 3.1 GitHub Personal Access Token (PAT) Storage

- Add a `settings` key `github_pat` (encrypted with `SURVHUB_SECRET_KEY`)
- UI: Add a "GitHub" section to Settings page with PAT input (masked after save)
- When cloning/pulling, inject the PAT into the URL:
  ```
  https://<PAT>@github.com/user/repo.git
  ```
- Also use PAT for `git ls-remote` in the poller so private repos can be polled

### 3.2 SSH Key Support

- Allow configuring an SSH key path in Settings
- Use `simple-git`'s `GIT_SSH_COMMAND` env to point at the key
- Display the server's public key in Settings for easy GitHub deploy key setup

### 3.3 GitHub OAuth App (Stretch Goal)

- Register a GitHub OAuth App for the instance
- Allow users to log in with GitHub
- List their repos in a searchable dropdown instead of pasting URLs
- Auto-configure webhooks via the GitHub API

---

## 5. Phase 4 — Cloudflare Tunnel Integration

> **Priority**: 🟡 The user specifically wants Cloudflare Tunnel support.

### 4.1 Cloudflare Tunnel Daemon Management

- Add `cloudflared` binary detection (check if installed)
- Add Settings UI to configure Cloudflare Tunnel token
- Start/stop `cloudflared tunnel run` as a managed child process
- Monitor tunnel health via `cloudflared tunnel info`

### 4.2 Automatic Tunnel Route Registration

When a domain is added to a service:
1. Check if Cloudflare Tunnel is configured
2. If yes, automatically register the domain as a Cloudflare DNS record pointing to the tunnel
3. Use the Cloudflare API to configure `ingress` rules mapping the domain to the local service port
4. Since Cloudflare handles SSL at the edge, skip Let's Encrypt for tunneled domains (set `ssl_status = "cloudflare"`)

### 4.3 Tunnel Status in Dashboard

- Show tunnel connection status (connected/disconnected/error)
- Show which domains are routed through the tunnel vs. direct
- Log tunnel events to the service logs

### 4.4 DNS Challenge for SSL (Alternative)

If the user prefers Let's Encrypt over Cloudflare's edge SSL:
- Implement DNS-01 ACME challenge using Cloudflare DNS API
- This avoids the need for port 80 to be open
- Requires a Cloudflare API token with DNS edit permissions

---

## 6. Phase 5 — Observability & Monitoring

> **Priority**: 🟢 Nice to have, but transformative for trust.

### 5.1 Enhanced Dashboard

Replace the current minimal dashboard with a real overview:

- **Service Status Grid**: All services with live status indicators (green/yellow/red dots)
- **Recent Deployments**: Last 5 deployments across all services with status
- **Resource Usage**: Per-service CPU and memory (via `/proc` on Linux, `ps` on macOS)
- **Uptime Tracking**: How long each service has been running continuously
- **Quick Actions**: Start/stop/restart from dashboard without navigating to Services

### 5.2 Service Resource Monitoring

- Track per-process memory/CPU at healthcheck intervals
- Store in a `metrics` table: `service_id, cpu_percent, memory_mb, timestamp`
- Show sparkline graphs on service cards (last 1h)
- Alert (via log + UI badge) when a service exceeds configurable thresholds

### 5.3 Notification System

- Add a `notifications` table for important events
- Events: deployment complete/failed, service crashed, SSL provisioned/failed, disk space low
- Show notification bell in the sidebar with unread count
- Optional: Webhook notifications to Discord/Slack (configurable URL in Settings)

### 5.4 System Health Checks

- Monitor disk space usage at intervals
- Warn when `~/.survhub` data directory exceeds configurable threshold
- Monitor Docker daemon health
- Show overall system health score on dashboard

---

## 7. Phase 6 — Dashboard UI/UX Overhaul

> **Priority**: 🟡 The UI needs to feel premium, not utilitarian.

### 6.1 Design System Foundation

The current CSS is functional but sparse. Implement:

- **Color tokens**: Define a proper dark theme palette with semantic tokens (`--bg-primary`, `--text-muted`, `--accent`, `--success`, `--danger`)
- **Typography**: Import a clean font (Inter/Geist) via Google Fonts
- **Component library**: Standardize button variants (primary/secondary/danger/ghost), input styling, card variants
- **Spacing system**: Use consistent rem-based spacing scale

### 6.2 Sidebar & Navigation

- Add icons to nav items (use inline SVGs or a lightweight icon set)
- Show active service count badge on "Services" nav
- Add a "Quick Deploy" button in the sidebar for fast GitHub deploys
- Collapsible sidebar for more content space
- Add user avatar/name in sidebar footer when logged in

### 6.3 Card Redesign

Service cards should show more information at a glance:

```
┌─────────────────────────────────────┐
│ ● my-api                     ⚙️  ⋮ │
│ Status: ■ Running   SSL: 🔒       │
│ Port: 3000  →  api.example.com     │
│ user/repo [main] @ abc1234         │
│ Auto-Pull: ✓   Last deploy: 2m ago │
│                                     │
│ [Start] [Stop] [Restart] [Deploy]  │
└─────────────────────────────────────┘
```

### 6.4 Toast Notifications

- Replace `alert()` calls with a proper toast system
- Toast types: success (green), error (red), info (blue), warning (yellow)
- Auto-dismiss after 5s with manual close
- Stack position: bottom-right

### 6.5 Confirmation Dialogs

- Replace `confirm()` with styled modal dialogs
- Use for: service deletion, rollback, stop all services
- Show what will be affected (e.g., "This will delete 3 deployments and 2 env vars")

### 6.6 Dark/Light Theme Toggle

- Default to dark (current)
- Persist preference in localStorage
- Use CSS custom properties for easy theme switching

### 6.7 Responsive / Mobile Layout

- Stack sidebar to bottom nav on mobile
- Make service grid single-column on narrow screens
- Ensure modals are full-screen on mobile

---

## 8. Phase 7 — Database Management Enhancement

> **Priority**: 🟢 Currently databases are created but barely managed.

### 7.1 Database Connection Injection

When a database is created, automatically inject its connection string into linked services:

- Add a `linked_database_id` column to `services`
- When a service starts, auto-inject `DATABASE_URL` env var
- UI: Add a "Link Database" dropdown on service cards

### 7.2 Database Admin Panel

- Show container status (running/stopped) for each database
- Show connection details with copy-to-clipboard
- Add start/stop/restart buttons for database containers
- Show container logs

### 7.3 Database Backups

- Add `pg_dump` / `mysqldump` integration for managed databases
- Schedule periodic backups (daily by default)
- Store in `~/.survhub/backups/`
- One-click restore from backup

### 7.4 Seed Data Support

- Allow uploading a `.sql` file to seed a database
- Run seed on first creation or on-demand

---

## 9. Phase 8 — Multi-Service Orchestration

> **Priority**: 🟢 Needed for real applications with multiple components.

### 8.1 Service Dependencies

- Add a `depends_on` field to services (array of service IDs)
- When starting a service, ensure its dependencies are running first
- When stopping a dependency, warn about downstream services
- Visualize dependency graph on project page (Mermaid or D3)

### 8.2 Project-Level Actions

- "Start All" / "Stop All" / "Restart All" buttons per project
- "Deploy All" to trigger redeployments of all git-connected services in a project
- Project-level env vars (inherited by all services in the project)

### 8.3 Docker Compose Native Support

Currently compose import converts to individual services. Enhance to:
- Preserve compose networks and volumes
- Support `depends_on` ordering
- Support compose healthchecks
- Allow re-importing updated compose files to update existing services

### 8.4 Service Groups / Environments

- Allow tagging services as `production`, `staging`, `development`
- Filter service grid by environment
- Color-code cards by environment

---

## 10. Phase 9 — Documentation & Developer Experience

> **Priority**: 🟡 No one will use the project if they can't set it up.

### 9.1 README Rewrite

The current README is functional but doesn't sell the project. Rewrite to include:

- **Hero section**: One-line pitch + screenshot
- **Feature list**: With status badges (implemented/planned)
- **5-minute quickstart**: From zero to deployed service
- **Architecture diagram**: Mermaid diagram showing components
- **Comparison table**: vs Railway, vs Coolify, vs CapRover

### 9.2 Getting Started Guide

**File**: `docs/getting-started.md` (NEW)

Step-by-step walkthrough:
1. Prerequisites (Node 20+, Docker, Git)
2. Clone and install
3. First boot and bootstrap admin
4. Deploy your first service from GitHub
5. Connect a domain
6. Set up Cloudflare Tunnel (optional)
7. Enable SSL

### 9.3 API Reference

**File**: `docs/api-reference.md` (NEW)

Full endpoint documentation:
- Every route with method, path, request body schema, response shape
- Authentication requirements
- Example `curl` commands
- Error codes and meanings

### 9.4 Configuration Reference

**File**: `docs/configuration.md` (NEW)

- All environment variables with types, defaults, and descriptions
- Database schema reference
- File system layout (`~/.survhub/` structure)
- Network port requirements

### 9.5 Troubleshooting Guide

**File**: `docs/troubleshooting.md` (NEW)

Common issues and fixes:
- "Service won't start" (check command, working dir, port conflicts)
- "Git deploy fails" (auth, branch doesn't exist, build errors)
- "SSL provisioning fails" (port 80 not reachable, DNS not pointed)
- "Proxy not routing" (domain mismatch, service not running)
- "Docker service fails" (Docker daemon not running, image pull fails)

---

## 11. Phase 10 — Testing & CI/CD

> **Priority**: 🟡 Required for confident shipping and iteration.

### 10.1 Unit Test Coverage

Current tests are minimal. Add:

- **`lib/core.ts`**: Test `detectBuildType`, `parsePortMapping`, `normalizeOutput`
- **`security.ts`**: Test encrypt/decrypt roundtrip, mask edge cases
- **`services/auth.ts`**: Test session creation, token validation, password hashing
- **`services/poller.ts`**: Test hash comparison logic (mock `git ls-remote`)
- **`services/ssl.ts`**: Mock ACME client, test challenge flow
- **`routes/webhooks.ts`**: Test payload parsing, service matching, URL normalization

Target: **80% line coverage on `lib/` and `services/`**.

### 10.2 Integration Tests

Expand existing integration tests:

- Full deployment lifecycle: create service → deploy from git → verify running → redeploy → rollback
- Proxy routing: create route → verify traffic reaches service
- Auth flow: bootstrap → login → use token → logout → verify rejection
- Webhook flow: send GitHub payload → verify deployment triggered
- Settings flow: create service → update via PATCH → verify changes persisted

### 10.3 E2E / Smoke Tests

- Use Playwright or Cypress for browser-based testing
- Critical flows: Login → Create Project → Deploy from GitHub → Verify Running → Check Logs
- Run against a real server instance in CI

### 10.4 CI Pipeline

**File**: `.github/workflows/ci.yml` (NEW)

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - run: npm run test -w @survhub/server
      - run: npm run test:smoke -w @survhub/web
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx eslint apps/ --ext .ts,.tsx
```

### 10.5 Linting & Formatting

- Add ESLint with strict TypeScript rules
- Add Prettier for consistent formatting
- Add `lint-staged` + `husky` for pre-commit hooks
- Fix all existing lint issues

---

## 12. Phase 11 — Distribution & Packaging

> **Priority**: 🟢 Makes the project accessible to non-developers.

### 11.1 Single Binary Distribution

- Use `pkg` or `bun build` to compile the server into a single binary
- Bundle the built web dashboard into the server (serve static files from Fastify)
- Result: one file that runs the entire platform

### 11.2 Docker Image

**File**: `Dockerfile` (NEW, project root)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
EXPOSE 8787
CMD ["npm", "start"]
```

Publish to Docker Hub / GitHub Container Registry.

### 11.3 One-Line Install Script

```bash
curl -fsSL https://localSURV.dev/install.sh | bash
```

Script that:
1. Detects OS and architecture
2. Downloads the binary or Docker image
3. Creates `~/.survhub/` directory
4. Generates a random `SURVHUB_SECRET_KEY`
5. Creates a systemd/launchd service
6. Starts SURVHub and opens the dashboard

### 11.4 npm Global Install

```bash
npm install -g survhub
survhub start
```

- Register the `survhub` CLI via the `bin` field in package.json
- Ensure the CLI works globally with proper path resolution

### 11.5 Homebrew Formula (macOS)

```bash
brew install survhub
```

---

## 13. Phase 12 — Community & Open Source Readiness

> **Priority**: 🟢 Only relevant if open-sourcing.

### 12.1 Repository Hygiene

- Add `LICENSE` (MIT or Apache-2.0)
- Add `CONTRIBUTING.md` with development setup, PR guidelines, code style
- Add `CODE_OF_CONDUCT.md`
- Add `CHANGELOG.md` (start tracking from current version)
- Add `.github/ISSUE_TEMPLATE/` templates for bugs and features
- Add `.github/PULL_REQUEST_TEMPLATE.md`

### 12.2 Branding

- Design a logo (simple, recognizable icon)
- Create a favicon
- Add og:image for GitHub social preview
- Consistent naming: decide on "LocalSURV" vs "SURVHub" and use it everywhere

### 12.3 Landing Page

- Simple static site explaining what LocalSURV is
- Demo video/GIF showing the deploy flow
- Comparison with alternatives
- Link to GitHub, docs, install

### 12.4 Versioning & Releases

- Use semantic versioning
- Tag releases on GitHub
- Generate changelog from conventional commits
- Publish Docker images and binaries per release

---

## 14. Priority Matrix

### 🔴 Do Now (Blockers)

| Item | Phase | Effort |
|------|-------|--------|
| Fix git poller tab split bug | 1.1 | 5 min |
| Fix SSL import path | 1.2 | 15 min |
| Fix reverse proxy Host routing | 1.3 | 2 hours |
| Add service deletion | 1.4 | 1 hour |
| Add error boundaries | 1.5 | 1 hour |

### 🟡 Do Next (Core Quality)

| Item | Phase | Effort |
|------|-------|--------|
| Live build log streaming | 2.1 | 3 hours |
| GitHub PAT storage for private repos | 3.1 | 2 hours |
| Cloudflare Tunnel integration | 4.1-4.3 | 1 day |
| Dashboard overhaul | 5.1 + 6.1-6.4 | 2 days |
| README rewrite + getting started | 9.1-9.2 | 3 hours |
| CI pipeline | 10.4 | 2 hours |
| Toast notifications (replace alert) | 6.4 | 2 hours |

### 🟢 Do Later (Nice to Have)

| Item | Phase | Effort |
|------|-------|--------|
| Database connection injection | 7.1 | 3 hours |
| Service dependencies | 8.1 | 4 hours |
| Resource monitoring + sparklines | 5.2 | 1 day |
| Docker packaging | 11.2 | 2 hours |
| Notification system | 5.3 | 4 hours |
| GitHub OAuth App | 3.3 | 1 day |
| Landing page | 12.3 | 1 day |

---

## 15. Architecture Decisions

### Current Architecture

```
┌──────────────┐     ┌──────────────┐
│   Web App    │────▶│  Fastify API │
│  React SPA   │     │  Port 8787   │
│  Port 5173   │     │              │
└──────────────┘     │  ┌────────┐  │
                     │  │ SQLite │  │
                     │  └────────┘  │
                     │  ┌────────┐  │
                     │  │ Docker │  │
                     │  └────────┘  │
                     │  ┌────────┐  │
                     │  │http-prx│  │
                     │  └────────┘  │
                     └──────────────┘
```

### Target Architecture

```
┌─────────────────────────────────────────────────┐
│                  LocalSURV                       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │Dashboard │  │ API      │  │ Proxy Server │   │
│  │(bundled) │──│ Fastify  │  │ Host-based   │   │
│  └──────────┘  │          │  │ routing      │   │
│                │  ┌─────┐ │  └──────────────┘   │
│                │  │SQLite│ │                      │
│                │  └─────┘ │  ┌──────────────┐   │
│                │          │  │ Cloudflare   │   │
│                │  ┌─────┐ │  │ Tunnel       │   │
│                │  │Docker│ │  └──────────────┘   │
│                │  └─────┘ │                      │
│                │          │  ┌──────────────┐   │
│                │  ┌─────┐ │  │ Let's Encrypt│   │
│                │  │ Git │ │  │ ACME Client  │   │
│                │  └─────┘ │  └──────────────┘   │
│                └──────────┘                      │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │           Background Workers             │    │
│  │  ┌──────┐  ┌──────────┐  ┌───────────┐  │    │
│  │  │Health│  │Git Poller│  │SSL Renewal│  │    │
│  │  │Check │  │  (60s)   │  │  (daily)  │  │    │
│  │  └──────┘  └──────────┘  └───────────┘  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### Key Decisions

1. **Keep SQLite** — It's the right choice for a single-machine deployment tool. No external DB dependency. Fast, embedded, zero-config.

2. **Bundle the dashboard** — For production distribution, the React SPA should be built and served by Fastify as static files. No separate web server needed.

3. **Proxy should be standalone** — The reverse proxy should run on port 80/443 as a separate listener (or the main listener), not behind a `/proxy/*` prefix. This is required for real domain routing.

4. **Cloudflare Tunnel over direct port forwarding** — Safer, simpler, and doesn't require touching router config. Should be the recommended setup path.

5. **acme-client for SSL** — Already installed. Works well for HTTP-01 and DNS-01 challenges. Keep it.

6. **No external daemons** — Everything should run in the main Node.js process (or child processes managed by it). No Redis, no external queue. Keep it simple.

---

## Estimated Total Effort

| Phase | Effort | Dependency |
|-------|--------|------------|
| Phase 1 — Critical Fixes | 1 day | None |
| Phase 2 — Core Polish | 2 days | Phase 1 |
| Phase 3 — Private Repos | 1 day | Phase 1 |
| Phase 4 — Cloudflare Tunnel | 1-2 days | Phase 1 |
| Phase 5 — Observability | 2 days | Phase 2 |
| Phase 6 — UI Overhaul | 3 days | Phase 2 |
| Phase 7 — Database Mgmt | 1 day | Phase 2 |
| Phase 8 — Orchestration | 2 days | Phase 7 |
| Phase 9 — Documentation | 1 day | Phase 2 |
| Phase 10 — Testing & CI | 2 days | Phase 1 |
| Phase 11 — Distribution | 1 day | Phase 9 |
| Phase 12 — Open Source | 1 day | Phase 11 |
| **Total** | **~18-20 days** | |

---

*This document is the living roadmap for LocalSURV. Update it as phases are completed and priorities shift.*
