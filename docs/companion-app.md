# Companion app (control ServerHoster from your phone)

The companion app pairs a phone to a ServerHoster machine with a QR code, then talks
directly to that machine's API — no account, no relay, no third party in the path.

The app itself lives in [`companion/`](../companion/README.md). This page documents the
control-plane half: the pairing endpoints, what a paired device is allowed to do, and how
to make a machine reachable from a phone that isn't on your Wi-Fi.

---

## Pairing in one picture

```
 Dashboard (authenticated)        Control plane                 Phone
 ─────────────────────────        ─────────────                 ─────
 Settings → Companion
   POST /companion/pairings ──▶   mint an 8-char code
                                  TTL 5 min · single use
                                  store SHA-256(code) only
   ◀── code + chosen server URL
   render as QR ──────────────────────── scan ───────────────▶  parse payload
                                  ◀── POST /companion/pair/claim
                                  verify + mark claimed in one
                                  transaction, mint device token,
                                  store SHA-256(token) only
                                  ─── token + scope ─────────▶  saved on the phone
   GET /companion/pairings/:id ─▶ "claimed" → "Phone connected"
```

Both the pairing code and the device token are stored only as SHA-256 hashes, the same as
AI Gateway consumer tokens. A copy of `survhub.db` yields no working credential.

## Endpoints

| Method   | Path                      | Auth                 | Purpose                                                  |
| -------- | ------------------------- | -------------------- | -------------------------------------------------------- |
| `GET`    | `/companion/endpoints`    | dashboard session    | Addresses this machine might be reachable at, labelled   |
| `POST`   | `/companion/pairings`     | dashboard session    | Mint a pairing code + QR payload                         |
| `GET`    | `/companion/pairings/:id` | dashboard session    | Poll: `pending` / `claimed` / `expired`                  |
| `DELETE` | `/companion/pairings/:id` | dashboard session    | Cancel an unclaimed code                                 |
| `GET`    | `/companion/devices`      | dashboard session    | List paired devices                                      |
| `DELETE` | `/companion/devices/:id`  | dashboard session    | Revoke a device immediately                              |
| `POST`   | `/companion/pair/claim`   | **none** (see below) | Redeem a code for a device token                         |
| `GET`    | `/companion/me`           | any token            | Token introspection                                      |
| `POST`   | `/companion/heartbeat`    | device token         | Liveness ping                                            |
| `POST`   | `/companion/unpair`       | device token         | A phone revoking itself                                  |
| `GET`    | `/companion/summary`      | device token         | Everything the phone's home screen needs, in one request |

`/companion/pair/claim` has to be unauthenticated — the phone holds no credential until it
succeeds. It is guarded by four independent things: the code lives 5 minutes, it works
once (enforced inside the transaction that mints the device), a caller is cut off after 8
wrong guesses in 5 minutes, and the route is rate limited to 10 requests per minute per IP.
The code alphabet excludes `0/O` and `1/I`, so a code read off a screen has ~39 bits of
entropy against a 5-minute window.

Note where the guess budget is charged: to the **caller**, not to the pairing. Spending it
against the pairing is the obvious design and it is wrong — the endpoint is unauthenticated,
so anyone able to reach it could burn five junk codes and destroy the QR on the operator's
screen, repeatedly, until pairing became impossible. Instead the pairing survives, and the
number of wrong attempts is shown next to the QR so a human can decide to cancel it.

Both controls key on `req.ip`, which is the proxy's address unless you set
`SURVHUB_TRUST_PROXY` — see below.

## What a paired phone may do

Device tokens are checked in the same `onRequest` hook as dashboard sessions, but they are
deliberately _less_ privileged. **Reads and writes are both allowlists.** Anything not named
here is refused, so adding a route to this control plane never silently widens what a phone
can reach.

**Allowed reads (both scopes):**

- `GET /companion/{summary,me}`
- `GET /services`, `GET /services/:id`, `GET /services/:id/logs`
- `GET /services/:id/deployments/timeline`, `GET /services/:id/github-sync-status`
- `GET /projects`, `GET /service-groups`, `GET /notifications`
- `GET /health`, `GET /health/{system,docker}`, `GET /metrics/system`, `GET /metrics/services[/:id]`

**Allowed writes (scope `control` only):**

- `POST /services/:id/{start,stop,restart,force-restart,redeploy}`
- `POST /projects/:id/{start-all,stop-all,restart-all,deploy-all}`
- `POST /service-groups/:id/{start-all,stop-all,restart-all}`
- `POST /databases/:id/{start,stop,restart}`
- `POST /deployments/rollback`
- `POST /notifications/:id/read`, `POST /notifications/read-all`

**Allowed at either scope:** `POST /companion/{heartbeat,unpair}`. Self-revocation is not a
privilege — a read-only phone left in a taxi is exactly the case where it has to work.

Everything else is refused with `403 COMPANION_SCOPE_DENIED`, including `/secrets`,
`/backup`, all of `/databases`, `/settings`, `/admin`, `/api/ai-gateway`, `/ops`, the request
inspector, `/deployments`, `/logs/query`, anything ending in `/env`, and the
`/companion/{devices,endpoints,pairings}` administration surface.

> This list was a denylist first, and the denylist leaked. It named `/secrets`, `/backup`
> and `/services/:id/env` and looked complete, while `GET /databases/:id` still returned
> every managed database's password in the clear, `/databases/:id/tables/:schema/:table/preview`
> returned any row of any table, and `/databases/:id/backups/:backupId/download` streamed the
> whole dump — none of which start with `/backup` or end in `/env`. If you extend the phone's
> reach, extend the allowlist and add a case to `apps/server/src/companion.test.ts`.

### The one thing a phone can read that may contain a secret

`GET /services/:id/logs` is on the allowlist because reading logs from a phone is the app's
reason to exist. Logs are also where an application prints whatever it chose to print,
including, sometimes, a token. The control plane does not put secrets there — your services
might. If that matters more to you than remote troubleshooting, drop the
`/^\/services\/[^/]+\/logs$/` entry from `READ_ALLOW_PATTERNS` in
`apps/server/src/services/companion.ts`; nothing else in the app depends on it.

The same shape applies on the WebSocket: a device token may follow the live log and status
stream, but terminal attach messages from a companion socket are ignored, and terminal output
is delivered per-session rather than broadcast.

## What a phone did, after the fact

Every state-changing request made with a device token is written to the audit log with the
actor `companion:<device-id>`, the method and path, the resulting status code, the source IP
and the User-Agent — refused writes included, since a phone probing for `DELETE /services/:id`
is how a stolen token announces itself. Reads are not audited; the app polls, and a row per
poll would bury the writes. **Settings → System → Audit log**, or `GET /ops/audit-logs`.

## Making the machine reachable

Pairing hands the phone an address, and the app is only as useful as that address is
reachable. `GET /companion/endpoints` returns every candidate the host knows about, labelled
honestly, and the pairing UI makes you choose:

| Candidate                                          | Source             | Reachable from                   |
| -------------------------------------------------- | ------------------ | -------------------------------- |
| `SURVHUB_PUBLIC_URL`                               | env                | anywhere                         |
| The dashboard's own origin                         | request `Host`     | anywhere, if that host is public |
| Domains in `proxy_routes` pointing at the API port | database           | anywhere                         |
| `http://<lan-ip>:8787`                             | network interfaces | same Wi-Fi only                  |
| `http://localhost:8787`                            | fallback           | that machine only                |

For real remote access, expose the **control plane** itself — a Cloudflare Tunnel hostname
or a custom domain routed to the API port — and pair against that HTTPS address.

### Environment variables

```bash
# The address the phone should call home on. Offered first when pairing.
SURVHUB_PUBLIC_URL=https://hoster.example.com

# Where the companion app is hosted. Two effects:
#   1. the origin is allowed through CORS automatically
#   2. the pairing QR encodes a deep link into the app, so a phone's stock
#      camera can open it straight from the lock screen
SURVHUB_COMPANION_APP_URL=https://companion.example.com

# Believe X-Forwarded-For. Set this whenever you reach the dashboard through
# cloudflared, nginx or Caddy. Without it every remote request arrives wearing
# the proxy's address, so the pairing rate limit and guess budget collapse into
# one bucket shared by the whole internet — an attacker's guessing then locks
# out your own phone — and a device's recorded last-seen IP is the tunnel's.
#   1                     trust the immediate hop
#   10.0.0.1,10.0.0.0/8   trust only these
SURVHUB_TRUST_PROXY=1
```

Leave `SURVHUB_TRUST_PROXY` unset if the control plane is exposed directly. Turning it on
without a proxy in front lets any caller forge their own address in a header, which is the
same failure in the other direction.

If you would rather not think about CORS at all, build `companion/` and serve its `dist/`
from the same origin as the control plane — for example as a ServerHoster static service on
the same hostname. Same origin, no configuration, one address to remember.

## Revoking a phone

**Settings → Companion → Paired devices → Unpair.** The token stops working on the next
request; there is no cache to wait out. A phone can also revoke itself from
**Servers → Forget this machine** in the app, which additionally drops the local copy.
