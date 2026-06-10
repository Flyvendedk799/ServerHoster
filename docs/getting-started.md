# Getting started

From `git clone` to a live service on your own hardware in about five minutes.

## 1. Prerequisites

- **Node.js 20 or later** (`node --version`)
- **Git** (`git --version`)
- **Docker** — required for Docker-typed services, managed databases, and local Supabase stacks. Not strictly required if you only run Node/Python process services.
- **Supabase CLI** — only needed for the local Supabase flow (step 9): `brew install supabase/tap/supabase`, or see [Supabase's install guide](https://supabase.com/docs/guides/local-development/cli/getting-started)
- **A port you control** — 80/443 if you want Let's Encrypt HTTP-01, or nothing exposed if you're using Cloudflare Tunnel.

## 2. Clone and install

```bash
git clone https://github.com/your-org/localsurv.git
cd localsurv
npm install
```

## 3. Set secrets

LocalSURV encrypts stored env-var secrets and external tokens (GitHub PAT, Cloudflare token, …) at rest using `SURVHUB_SECRET_KEY`. Pick a strong random value and keep it somewhere safe — **losing the key means losing access to encrypted data**.

```bash
export SURVHUB_SECRET_KEY=$(openssl rand -base64 32)
```

Optional but recommended:

```bash
export SURVHUB_PORT=8787
export SURVHUB_DATA_DIR=$HOME/.survhub
```

Full reference: [configuration.md](configuration.md).

## 4. First boot

```bash
npm run build
npm run dev -w @survhub/server       # Fastify on 8787
npm run dev -w @survhub/web          # Vite dev server on 5173
```

Open `http://localhost:5173` in your browser.

## 5. Bootstrap an admin user

The first time you launch, there is no user yet. Go to **Settings → Authentication**:

1. Enter a **bootstrap username** and **password** (8+ characters)
2. Click **Bootstrap admin user**
3. Then **Login** with the same credentials

The sidebar nav will light up. You're in.

## 6. Deploy your first service from GitHub

Go to **Services → "Deploy directly from GitHub repo"**:

1. **If your repo is public**, paste the clone URL (`https://github.com/org/repo.git`), pick a branch, set an internal port, and click **Deploy**.
2. **If your repo is private**, first save a GitHub PAT at **Settings → GitHub** (create one at [github.com/settings/tokens](https://github.com/settings/tokens) with `contents:read`). Then come back and use **List my repos** to pick a repo directly.

LocalSURV will:

- Clone the repo
- Auto-detect the build type (`Dockerfile` → Docker, `package.json` → Node, `requirements.txt` → Python)
- Stream the build log live into the UI
- Start the service automatically if you leave "Start after successful deploy" checked

You'll see the service appear in the grid with a live status dot and CPU/memory metrics.

## 7. Connect a domain

Open the settings ⚙️ on the service card and set a **Domain** and an **Internal Port**. LocalSURV will:

1. Insert a proxy route so any request to that host on port 80/443 goes to your service
2. Either:
   - Auto-register the domain with **Cloudflare Tunnel** (if configured at Settings → Cloudflare), **or**
   - Request a **Let's Encrypt** certificate via HTTP-01 (with a pre-flight check that the domain is actually reachable), **or**
   - Use **DNS-01** via the Cloudflare DNS API if you've set `ssl_mode=dns-01`

## 8. (Optional) Set up Cloudflare Tunnel

If you don't want to open ports 80/443 on your router:

1. Install `cloudflared` and create a tunnel in the Cloudflare dashboard
2. Copy the **tunnel token**, **account ID**, **tunnel ID**, and **zone ID**
3. In LocalSURV, go to **Settings → Cloudflare Tunnel**, paste them all in
4. Also save a **Cloudflare API token** with DNS + Cloudflare Tunnel edit permissions
5. Click **Start** — LocalSURV will spawn `cloudflared tunnel run` as a managed child process, with auto-restart and a live tail of its output
6. Any domain you add to a service will now auto-register as a CNAME in Cloudflare and an ingress rule in the tunnel

## 9. (Optional) Add a database or local backend stack

LocalSURV is **dependency-aware**: it scans a service's repo for the backend it actually uses and offers the right local resource, instead of assuming every app wants a plain `DATABASE_URL`.

The scan detects:

- **Supabase** — `@supabase/supabase-js` in `package.json`, `supabase/config.toml`, `supabase/migrations`, `supabase/functions`, `VITE_SUPABASE_*` env keys → offers **Add Local Supabase**
- **Postgres** — `pg` / Prisma / Drizzle drivers → offers **Add Postgres**
- **MySQL** — `mysql` / `mysql2` (and pymysql, go-sql-driver, …) drivers → offers a managed MySQL container with `DATABASE_URL` injection
- **MongoDB** — `mongodb` / `mongoose` (and pymongo, mongo-driver, …) drivers → offers a managed Mongo container with `DATABASE_URL` injection
- **Redis** — redis client packages → offers managed Redis
- Nothing detected → pick a provisioning profile manually

A Supabase app that also carries `pg`/Prisma deps is still recommended Supabase — it's never mislabeled as plain Postgres.

### The Supabase path

Prerequisites: **Docker** running, plus the **Supabase CLI** — `brew install supabase/tap/supabase` (or see [Supabase's CLI guide](https://supabase.com/docs/guides/local-development/cli/getting-started)).

1. **Detect** — the service card shows "Supabase detected" after a scan (`POST /resources/scans/:serviceId/run`)
2. **Add Local Supabase** — LocalSURV runs `supabase start` from the service's working directory and parses `supabase status` for the API/Studio/DB URLs, keys, and ports
3. **Schema only** (the default) — applies `supabase/migrations` via `supabase migration up`. **No hosted data is ever copied** — no Auth users, no storage files, no rows. Pick "Schema + seed" explicitly if you want `supabase/seed.sql` to run
4. **Secrets** — generated keys (anon, service-role, JWT) are stored encrypted; optional external provider keys (`OPENAI_API_KEY`, `RESEND_API_KEY`, …) referenced by Edge Functions can be pasted in or disabled locally — missing ones just mark the affected function _degraded_, never fail provisioning
5. **Bootstrap** — create the first local user (and optionally platform admin + organization) from a preview built by introspecting the local database's actual schema — no manual SQL

The service is then linked and gets `VITE_SUPABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, etc. injected at build and runtime — static/Vite builds are redeployed automatically since `VITE_*` is baked at build time.

### Plain databases

Go to **Databases → Create database**:

- Pick an engine (postgres / mysql / redis / mongo)
- Choose a port
- Optionally set a custom username, password, or database name

LocalSURV pulls the image, starts the container, records the connection string, and the admin panel lets you run `pg_dump`/`mysqldump` backups, restore from a backup, run seed SQL, or copy the connection string.

To **auto-inject `DATABASE_URL`** into a service, open the service settings and pick the database from the **Linked database** dropdown. Next time it starts, it'll see the URL in its env.

## 10. Enable GitHub webhooks (optional)

Instead of polling every 60 seconds, add a webhook:

1. Repo settings → **Webhooks → Add webhook**
2. Payload URL: `https://<your-server>/webhooks/github` (or `http://` for local testing)
3. Content type: `application/json`
4. Events: **Just the push event**
5. Save

LocalSURV will redeploy the matching service on every push to the tracked branch. If you configured a PAT, you can also call `POST /github/webhook/ensure` to have LocalSURV register the webhook for you automatically.

## What's next

- Set up a systemd/launchd service so LocalSURV boots with your machine (Settings → System service templates)
- Add Discord or Slack notification forwarding (Notifications → Forward to…)
- Read [operations.md](operations.md) for production guidance
