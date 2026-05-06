# LocalSURV

**Self-hosted deploy platform for your own hardware.** Clone a repo, wire a domain, and ship — without handing your traffic or your wallet to Railway, Render, or Fly.

LocalSURV runs on your Mac mini, Linux box, or Windows PC and gives you a browser dashboard that looks and feels like a hosted PaaS: GitHub deploys, live build logs, reverse proxy, Let's Encrypt or Cloudflare Tunnel SSL, per-service metrics, databases, and push-to-deploy webhooks. One binary, one SQLite file, no external services.

---

## Features

| Area              | What you get                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy**        | GitHub repo → clone → auto-detect build (Node / Python / Docker) → live-streamed build logs → run                                                                          |
| **Git**           | HTTPS PAT auth, SSH keys, GitHub webhooks, 60s GitOps polling, redeploy, rollback                                                                                          |
| **Routing**       | Host-based reverse proxy, dynamic SNI, Let's Encrypt (HTTP-01 + DNS-01), Cloudflare Tunnel by default with pluggable adapters (ngrok / Tailscale Funnel planned)           |
| **Runtime**       | Process services, Docker services, auto-restart with exponential backoff, healthchecks, dependency-ordered start                                                           |
| **Observability** | Live WebSocket logs, build log streaming, CPU/memory metrics per service, system health score, notifications (in-app + Discord/Slack webhook)                              |
| **Databases**     | One-click Postgres/MySQL/Redis/Mongo containers, connection-string copy, auto-injected `DATABASE_URL`, `pg_dump`/`mysqldump` backups with one-click restore, SQL seed      |
| **Projects**      | Project env vars inherited by services, environment tags (production/staging/dev), start-all/stop-all/deploy-all, docker-compose import (idempotent, preserves depends_on) |
| **Security**      | AES-256-GCM encrypted secrets, session auth + bootstrap user, rate-limited API, audit log, encrypted Cloudflare/GitHub token storage                                       |
| **UX**            | Dark/light theme, collapsible sidebar, toast notifications, modal confirms, mobile-responsive layout                                                                       |

---

## 5-minute quickstart

**Prerequisites:** Node 20+, Docker (optional but recommended for container services and databases), Git.

```bash
# 1. clone (replace <GITHUB_OWNER> with the upstream — see docs/forking.md)
git clone https://github.com/<GITHUB_OWNER>/localsurv.git
cd localsurv

# 2. install
npm install

# 3. generate a strong secret key (used to encrypt env vars at rest)
export SURVHUB_SECRET_KEY=$(openssl rand -base64 32)

# 4. build + run
npm run build
npm run dev -w @survhub/server   # API on :8787
npm run dev -w @survhub/web      # dashboard on :5173
```

Open `http://localhost:5173`, click **Settings → Bootstrap admin user**, pick a username and an 8+ character password, log in, and you're running. Deploy your first service from the Services page — paste a GitHub URL, pick a branch, hit Deploy, and watch the build stream in.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 LocalSURV                        │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │Dashboard │  │ API      │  │ Host-based   │   │
│  │ (React)  │──│ Fastify  │──│ reverse proxy│   │
│  └──────────┘  │          │  │ (http-proxy) │   │
│                │  ┌─────┐ │  └──────────────┘   │
│                │  │SQLite│ │                      │
│                │  └─────┘ │  ┌──────────────┐   │
│                │          │  │ Cloudflare   │   │
│                │  ┌─────┐ │  │ Tunnel       │   │
│                │  │Docker│ │  │ (optional)   │   │
│                │  └─────┘ │  └──────────────┘   │
│                │          │                      │
│                │  ┌─────┐ │  ┌──────────────┐   │
│                │  │ Git │ │  │ Let's Encrypt│   │
│                │  └─────┘ │  │ (HTTP-01 /   │   │
│                └──────────┘  │  DNS-01)     │   │
│                              └──────────────┘   │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │           Background workers              │    │
│  │  Healthcheck • Git poll • Metrics •       │    │
│  │  Disk/Docker health • SSL renewal         │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

- Everything runs in a single Node process (plus the child processes and Docker containers your services spawn).
- SQLite for state (`~/.survhub/survhub.db`). No Redis, no external queue.
- The dashboard is a Vite/React SPA; in production it's built and served as static files by the same Fastify instance.

---

## Comparison

|                            | **LocalSURV**  | Railway     | Coolify       | CapRover    |
| -------------------------- | -------------- | ----------- | ------------- | ----------- |
| Self-hosted                | ✅             | ❌          | ✅            | ✅          |
| GitHub auto-deploy         | ✅             | ✅          | ✅            | ✅          |
| SQLite state               | ✅ single file | —           | Postgres req. | LevelDB     |
| Cloudflare Tunnel built-in | ✅             | ❌          | ❌            | ❌          |
| Live build log stream      | ✅             | ✅          | ✅            | ⚠️ tail     |
| Docker + process services  | ✅ both        | Docker only | Docker only   | Docker only |
| Per-service metrics        | ✅             | ✅          | ✅            | ✅          |
| Single-binary deploy       | ⏳ planned     | n/a         | ❌            | ❌          |
| Cost                       | free           | $$          | free          | free        |

---

## Platform support

| Platform        | Status       | Install path                                                                           |
| --------------- | ------------ | -------------------------------------------------------------------------------------- |
| Linux (systemd) | ✅ supported | `install.sh` (registers a user systemd unit)                                           |
| macOS (launchd) | ✅ supported | `install.sh` or `brew install ./packaging/Formula/localsurv.rb` (notarization pending) |
| Docker          | ✅ supported | Multi-stage `Dockerfile` at the repo root                                              |
| Windows         | ⏳ planned   | PowerShell `install.ps1` + Windows Service wrapper (in flight)                         |

> Public exposure today goes through Cloudflare Tunnel, with Let's Encrypt for direct custom-domain serving when port 80/443 are open. Bring-your-own ngrok and Tailscale Funnel adapters are on the roadmap and will plug into the same `TunnelAdapter` slot.

---

## Documentation

- [Getting started](docs/getting-started.md) — zero to deployed in 5 minutes
- [Configuration reference](docs/configuration.md) — every env var, schema, file layout
- [API reference](docs/api-reference.md) — all HTTP endpoints
- [Troubleshooting](docs/troubleshooting.md) — when things break
- [Operations guide](docs/operations.md) — running LocalSURV in production
- [QA matrix](docs/qa-matrix.md) — platform coverage

---

## Build and test

```bash
npm run build                     # tsc + vite build across all workspaces
npm run test -w @survhub/server   # node:test against the Fastify app
npm run test:smoke -w @survhub/web
```

---

## Privacy & telemetry

LocalSURV does **not** collect telemetry, analytics, or any usage data. The only outbound calls the control plane makes by default are:

- A daily fetch of the latest GitHub release tag for the in-dashboard "update available" banner. Disable with `LOCALSURV_NO_UPDATE_CHECK=1`.
- Cloudflare API calls when you use Cloudflare Tunnel (only with credentials you supply).
- Let's Encrypt ACME calls when you provision SSL.

Crash reports stay on your machine. They write to `<dataRoot>/crash-<timestamp>.log` only when `crash_reporter.enabled = "1"` (off by default), and are never sent off-host. There is no Prometheus endpoint exposed unless you explicitly enable `prometheus.enabled = "1"`.

If we ever add anything resembling telemetry it will be opt-in with a visible toggle in Settings, disclosed in this section, and disabled by default.

---

## License

MIT — see [LICENSE](LICENSE).
