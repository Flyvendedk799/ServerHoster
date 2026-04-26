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
