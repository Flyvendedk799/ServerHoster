# Troubleshooting

Common failure modes and how to fix them.

## Service won't start

**Symptoms:** Start button flashes, service immediately flips to `crashed` or `stopped`.

Check in order:

1. **Command is empty or wrong** — Open the service settings modal; the `Command` field must be something the shell can exec (`npm run start`, `python app.py`). SURVHub doesn't invent a command if it can't detect one.
2. **Working directory doesn't exist** — `PATCH /services/:id` validation now blocks saves with a missing `workingDir`, but a pre-existing service may still have a stale path. Check `working_dir` in the DB or the settings modal. Re-deploy from Git if the clone was deleted.
3. **Port conflict** — If the service binds to a port already in use by another local process, the child exits with `EADDRINUSE`. Either change the service port or kill the conflicting process (`lsof -i :<port>`).
4. **Missing env var** — Check **Service logs**. Look for `ReferenceError`, `undefined`, or "connection refused" messages. Add the missing variable under the service's env tab, or at the project level to inherit it everywhere.
5. **Exit loop / max restarts** — Auto-restart backs off exponentially and gives up after `max_restarts` (default 5). The service transitions to `stopped` and a `service_crash` notification is posted. Fix the crash cause, then click Start.

## Git deploy fails

**Symptoms:** Deployment row flips to `failed`, build log shows `Remote branch main not found` or `fatal: Authentication failed`.

- **Wrong branch** — Your repo uses `master` or `develop` but SURVHub defaulted to `main`. Pass the right branch in the deploy form or the service settings.
- **Private repo without auth** — Save a GitHub PAT at Settings → GitHub. SURVHub rewrites `https://github.com/org/repo.git` into `https://x-access-token:<PAT>@github.com/org/repo.git` at clone time.
- **SSH URL without key** — If you're using `git@github.com:org/repo.git`, configure `ssh_key_path` under Settings → SSH key. Add the displayed public key as a GitHub deploy key.
- **Build error** — The build log is persisted on the deployment row. Expand the deployment on the Deployments page to see `npm install` / `docker build` output verbatim.
- **Unknown build type** — If the repo has no `package.json`, `requirements.txt`, `pyproject.toml`, or `Dockerfile`, the deploy fails early with "Cannot deploy this repository layout". Add a build manifest your project.

## SSL provisioning fails

**Symptoms:** `ssl_status = error`, build log shows Let's Encrypt errors or "Domain is not reachable on port 80".

- **DNS not pointed** — LocalSURV's pre-flight publishes a sentinel file under `/.well-known/acme-challenge/self-test` and then curls the public URL. If it doesn't see the sentinel come back, the domain isn't actually routed to your server.
  - Fix the DNS A record, **or**
  - Use **DNS-01** instead: Settings → Cloudflare → ACME challenge type → `dns-01`, and make sure a Cloudflare API token with DNS edit is saved.
- **Port 80 blocked** — The HTTP listener is bound but a firewall, router NAT, or ISP is swallowing the traffic. Verify with `curl http://<domain>/.well-known/acme-challenge/self-test` from outside your network.
- **Rate limits** — Let's Encrypt limits 5 duplicate certificates per week. If you've been retrying aggressively, switch to the staging directory temporarily or wait it out.

## Proxy not routing domain

**Symptoms:** `curl http://my-app.example.com` times out or hits the SURVHub dashboard instead of your service.

- **Host header mismatch** — The incoming `Host` header must **exactly** match the `proxy_routes.domain` (lowercased, port stripped). `www.example.com` and `example.com` are different entries.
- **Service not running** — The proxy happily forwards to a dead target and returns 502. Check the service status dot on the dashboard.
- **Port mismatch** — `target_port` in `proxy_routes` must be the port the process/container is actually listening on. For Docker services, make sure the same port is published in the service record.
- **Conflicting listener** — Something else on the host is already on port 80/443. `lsof -i :80` to find it.

## Docker service fails

**Symptoms:** "no such image", container start fails, or `docker stats` errors in metrics collection.

- **Docker daemon not running** — The dashboard will show `Docker: DOWN` in the system health card and a red notification will appear within 5 minutes. Start Docker Desktop / `systemctl start docker`.
- **Image pull failed** — Check build log for "no matching manifest" or auth errors. For private registries, log in on the host with `docker login`; SURVHub uses the daemon's credential helpers transparently.
- **Port already mapped** — Docker rejects container starts when the host port is in use. Change the service port.

## Local Supabase provisioning fails

**Symptoms:** `POST /resources/provision` errors, resource status flips to `failed`, the `resource_provisioning` event stream ends with `failed`.

The failed resource row is **kept** with the error retained in its config so you can diagnose it — fix the cause, delete the resource, and re-provision. The stack is stopped best-effort on failure.

- **Supabase CLI missing** — Preflight fails with "Supabase CLI not found". Install it with `brew install supabase/tap/supabase` (macOS/Linuxbrew) or see [Supabase's CLI guide](https://supabase.com/docs/guides/local-development/cli/getting-started), then retry. Other resource profiles (plain Postgres, Redis) are unaffected.
- **Docker unavailable** — Preflight pings the Docker daemon before touching the CLI. Same fix as any Docker failure: start Docker Desktop / `systemctl start docker` and check the system health card.
- **No `supabase/config.toml`** — Provisioning refuses unless you explicitly confirm initialization (`config.init=true`, the "Initialize" option in the modal), which runs `supabase init` in the service working dir.
- **Migration failure** — `supabase migration up` output is included in the error. Migrations run against the **local** stack only (state is recorded in `supabase_migrations.schema_migrations`); fix the offending SQL in `supabase/migrations` and re-provision. Note "schema only" means "run migrations" — migration files that contain reference/bootstrap inserts will still insert those rows.
- **First start is slow** — `supabase start` pulls the entire stack's images on first run; the timeout is deliberately generous (15 min). Subsequent starts are fast.

## Edge Function marked degraded

**Symptoms:** `GET /resources/:id/env-requirements` shows a function with `status: "degraded"`, function logs contain `[functions] <name>: missing secret KEY (missing-optional) — referenced by <files>`.

This is by design: missing optional/external secrets (`OPENAI_API_KEY`, `RESEND_API_KEY`, any `*_API_KEY`/`*_SECRET`/`*_TOKEN`) never fail provisioning. The log line names the exact missing key and the files referencing it. Either:

- **Provide the key** — `POST /resources/:id/secrets` with `{ "secrets": { "KEY": "value" } }` (or paste it in the UI). The function env file is rewritten and a live `supabase functions serve` process is restarted automatically.
- **Disable it locally** — `{ "disable": ["KEY"] }` marks the feature intentionally off; the function shows `disabled` instead of `degraded`.

A `missing-required` state (an auto-generated key that should exist, like `SUPABASE_SERVICE_ROLE_KEY`) means the stack didn't report it — check `supabase status` in the service working dir and re-provision.

## Bootstrap can't reach the local database

**Symptoms:** `GET /resources/:id/bootstrap/plan` returns 502, or the request is rejected with `Bootstrap refused: … points at non-local host`.

- **Stack not running** — Bootstrap introspects the live local Postgres. Start the resource (`POST /resources/:id/start`) and confirm containers are up with `docker ps` or `supabase status` in the working dir.
- **Non-local URL refusal is intentional** — Bootstrap only ever targets `127.0.0.1` / `localhost` / `host.docker.internal` / `::1`. It will never run against a hosted Supabase project; that's a safety guarantee, not a bug.
- **502 with the stack up** — The DB connection details were captured from `supabase status` at provision time. If you've changed ports in `supabase/config.toml` since, restart the resource (`POST /resources/:id/restart`) — start/restart re-runs `supabase status` and re-records the ports, URLs, and keys (and rewrites the function env file + restarts a live `functions serve` process so Edge Functions pick up the refreshed values too).

## WebSocket disconnects / empty dashboard

- **Auth token expired** — Log out and log back in. Sessions default to 12h.
- **Different origin** — The Vite dev server (5173) and API (8787) are on different ports; CORS + WebSocket origin checks are permissive but some reverse proxies strip the upgrade header. Talk to the API directly or set `VITE_SURVHUB_API_URL` / `VITE_SURVHUB_WS_URL` in the web app.

## Cloudflare Tunnel keeps restarting

- `cloudflared` binary is missing — Install from [Cloudflare's releases](https://github.com/cloudflare/cloudflared/releases) or set `cloudflared_binary_path` in settings.
- Wrong tunnel token — Tokens are scoped to a single tunnel; if you regenerated the tunnel, re-save the token.
- Check **Settings → Cloudflare Tunnel → Recent tunnel output**. The last 200 lines of `cloudflared` stderr are shown.
- Restart limit reached after 10 consecutive failures. Fix the underlying problem and click Stop then Start.

## Backup / restore failed

- **`pg_dump not found`** — The database container must ship with the dump tools. The official `postgres:16` and `mysql:8` images do. `mongo:8` ships with `mongodump`. Redis backups are not supported (use `BGSAVE` + copy the RDB manually).
- **Timeout on restore** — Restores pipe the SQL via stdin; for files over ~200 MB, bump the timeout by running `pg_restore` manually from the host.
- **Backup file missing on disk** — The row points at `$DATA/backups/<filename>` but the file was deleted. Remove the orphan row from `database_backups`.

## Notifications not forwarding to Discord/Slack

- Webhook URL must be saved under Settings → Notifications.
- LocalSURV posts `{content: "…"}` for Discord and `{text: "…"}` for Slack. If you swapped the `kind` in settings, the receiving service will silently drop the payload — pick the right one.
- Network egress is required; if your host is offline or firewalled, forwards are best-effort and the in-app notification still appears.

## "Unknown SURVHUB_SECRET_KEY" errors after restart

If you restart LocalSURV with a different `SURVHUB_SECRET_KEY` than the one used to write secrets, decryption will fail and the dashboard will show placeholder text like `(unreadable — wrong SURVHUB_SECRET_KEY?)`. **There is no recovery without the original key.** Restore the old key, or wipe the `settings` and `env_vars` tables and re-enter every secret.

## Where to look when nothing else works

1. **Fastify server stdout** — structured JSON logs for every request and every error
2. **`~/.survhub/survhub.db`** — open with `sqlite3` and inspect state directly
3. **`/ops/audit-logs?limit=100`** — recent mutations with actor + status code
4. **Service logs** — per-service with level filter + grep search at `/services/:id/logs`
5. **Deployment build log** — expandable on every card on the Deployments page
