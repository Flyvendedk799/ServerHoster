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
once (enforced inside the transaction that mints the device), it locks after 5 failed
attempts, and the route is rate limited to 10 requests per minute per IP. The code alphabet
excludes `0/O` and `1/I`, so a code read off a screen has ~39 bits of entropy against a
5-minute window.

## What a paired phone may do

Device tokens are checked in the same `onRequest` hook as dashboard sessions, but they are
deliberately _less_ privileged. Writes are an **allowlist** — a forgotten denylist entry
would mean a lost phone deleting a production service — and a set of reads is refused
outright.

**Allowed writes (scope `control` only):**

- `POST /services/:id/{start,stop,restart,force-restart,redeploy}`
- `POST /projects/:id/{start-all,stop-all,restart-all,deploy-all}`
- `POST /service-groups/:id/{start-all,stop-all,restart-all}`
- `POST /databases/:id/{start,stop,restart}`
- `POST /deployments/rollback`
- `POST /notifications/:id/read`, `POST /notifications/read-all`
- `POST /companion/{heartbeat,unpair}`

**Refused reads (both scopes):** `/secrets`, `/backup`, `/settings/ssh`, `/settings/github`,
`/admin`, `/agents`, `/mcp`, `/api/ai-gateway`, `/ops/{audit-logs,diagnostics,install-scripts}`,
anything ending in `/env`, `/certificate` or `/terminal-sessions`, and the
`/companion/{devices,endpoints,pairings}` administration surface.

Everything else that is a plain `GET` is allowed. A `read`-scoped device gets the reads and
none of the writes.

The same restriction applies on the WebSocket: a device token may follow the live log and
status stream, but terminal attach messages from a companion socket are ignored.

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
```

If you would rather not think about CORS at all, build `companion/` and serve its `dist/`
from the same origin as the control plane — for example as a ServerHoster static service on
the same hostname. Same origin, no configuration, one address to remember.

## Revoking a phone

**Settings → Companion → Paired devices → Unpair.** The token stops working on the next
request; there is no cache to wait out. A phone can also revoke itself from
**Servers → Forget this machine** in the app, which additionally drops the local copy.
