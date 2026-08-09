# ServerHoster Companion

**Your ServerHoster machine, in your pocket.** Pair once by scanning a QR code on the dashboard, then check on your services — and start, stop, restart or redeploy them — from a phone, anywhere.

Today it is an installable web app (PWA) built for a phone screen. It is structured so that a native shell can wrap the same client later; the pairing protocol and the API client don't care what runs them.

---

## What it does

|                   |                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Pair by QR**    | Scan the code on **Settings → Companion** in the dashboard. No account, no sign-up, no cloud.                      |
| **Pair by code**  | Camera not cooperating? Type the 8-character code and the server address instead.                                  |
| **Many machines** | Pair as many boxes as you like and switch between them from the header.                                            |
| **Home**          | Health at a glance: what's running, what's broken, memory and load, recent deploys. Broken things sort to the top. |
| **Services**      | Search and filter the whole fleet, grouped by project.                                                             |
| **Control**       | Start · Stop · Restart · Redeploy, with live status straight off the machine's WebSocket.                          |
| **Live logs**     | The same log stream the desktop dashboard shows, tail-following, with a follow toggle when you scroll up to read.  |
| **Activity**      | Deploy history and alerts, with unread badges.                                                                     |
| **Offline-aware** | Opens and explains itself with no signal instead of showing a browser error page.                                  |

### What it deliberately cannot do

A phone gets lost. So the device token a phone holds is scoped on the server side, and no amount of tampering with this app changes that — the checks live in the control plane, not here. A paired phone **cannot**:

- read secrets, environment variables, SSH keys, GitHub PATs or AI gateway tokens
- open a terminal on the host
- create or delete services, projects, databases or routes
- export or import a backup
- pair another device, or see which other devices are paired

If you want an even smaller blast radius, pair with **read-only** access — then the control buttons are refused too.

---

## Quick start

**You need:** a machine running [ServerHoster](https://github.com/Flyvendedk799/ServerHoster) with the companion endpoints (`/companion/*`), Node 20+, and a way for your phone to reach the machine.

```bash
npm install
npm run dev          # http://localhost:5174, also served on your LAN IP
```

Open it on your phone, then on your computer open the dashboard → **Settings → Companion** → **Show pairing code**, and scan.

To build for deployment:

```bash
npm run build        # → dist/, a static bundle
npm run preview
```

`dist/` is plain static files with a relative base, so it works on any static host — Cloudflare Pages, Netlify, GitHub Pages, a `nginx` root, or a ServerHoster static service.

---

## Reaching your machine from outside

This is the part that decides whether the app is useful on a bus, and the app cannot solve it for you: **your phone has to be able to open a connection to your machine.**

The pairing screen on the dashboard lists every address the machine knows about and labels them honestly:

| Address it offers                                             | Works from                          |
| ------------------------------------------------------------- | ----------------------------------- |
| `SURVHUB_PUBLIC_URL`, or a domain routed to the control plane | anywhere                            |
| The address the dashboard itself is open on                   | anywhere, if that address is public |
| `http://192.168.x.x:8787`                                     | the same Wi-Fi only                 |
| `http://localhost:8787`                                       | that machine only                   |

For genuine remote access, expose the **control plane** (not just your services) — ServerHoster's Cloudflare Tunnel or a custom domain both work — and pair against that HTTPS address. A LAN address is fine for trying things out at home; it will simply time out from mobile data.

### Two CORS-shaped details

The companion app is a browser app, so the machine has to allow its origin:

```bash
# on the ServerHoster machine
SURVHUB_COMPANION_APP_URL=https://companion.example.com   # also allowed through CORS automatically
SURVHUB_PUBLIC_URL=https://hoster.example.com             # offered first when pairing
```

Setting `SURVHUB_COMPANION_APP_URL` has a second effect: the pairing QR then encodes a deep link into your hosted app rather than a raw payload, so a phone's stock camera app can open it straight from the lock screen.

**Or side-step CORS entirely:** build this app and serve `dist/` from the same origin as the control plane (for example as a ServerHoster static service on `https://hoster.example.com`, or behind a path on the same domain). Same origin, no CORS configuration, one hostname to remember.

---

## How pairing works

```
 Desktop dashboard                Control plane                  Phone
 ─────────────────                ─────────────                  ─────
 Settings → Companion
   POST /companion/pairings  ──▶  mint code (5 min, single use)
                                  store SHA-256(code) only
   ◀── code + server URL
   render QR  ──────────────────────── scan ──────────────────▶  parse payload
                                  ◀── POST /companion/pair/claim
                                       { code, deviceName }
                                  verify, mark claimed in one txn,
                                  mint device token, store its hash
                                  ─── token + scope ──────────▶  save to this
                                                                 phone's vault
   GET /companion/pairings/:id ─▶ "claimed"
   "Phone connected ✓"
```

- The code is 8 characters from an alphabet with no `0/O` or `1/I`, valid for **5 minutes**, usable **once**, capped at 5 attempts, and rate limited per IP at the route.
- Neither the code nor the device token is ever stored in the clear — the database holds SHA-256 hashes, so a stolen `survhub.db` yields no working credentials.
- The device token lasts a year and is revocable instantly from the dashboard, or from **Servers → Forget this machine** in the app.

Tokens live in this phone's `localStorage`. That is the same exposure as staying logged into any web app on your phone: keep a device lock on, and revoke from the dashboard if you lose it.

---

## Project layout

```
src/
  lib/
    vault.ts      paired machines + their tokens (the only credential store)
    client.ts     HTTP to a paired machine — timeouts, typed errors, 401 handling
    pairing.ts    QR/deep-link/typed-code parsing, and redeeming a code
    live.ts       WebSocket log + status stream, with reconnect
    format.ts     bytes, uptime, relative time, status tone
  hooks/          vault subscription, summary polling (pauses when backgrounded)
  components/     QR scanner, tab bar, status pill, server switcher, toasts
  screens/        Pair · Home · Services · ServiceDetail · Activity · Settings
public/
  manifest.webmanifest, sw.js, icons
scripts/
  generate-icons.mjs   regenerates the PNG icons (zero dependencies)
```

Everything the phone shows on its home screen comes from a **single** `GET /companion/summary` request. That is deliberate: on a weak connection, five parallel requests are five chances to time out.

## Development

```bash
npm run dev      # dev server, reachable from your LAN
npm test         # vitest — pairing parsing, vault, formatting
npm run build    # typecheck + production bundle
npm run icons    # regenerate public/icon-*.png
```

## Roadmap

- Push notifications for crashes and failed deploys (needs a push endpoint on the control plane)
- Optional PIN / biometric lock over the vault
- Native shells (Capacitor or React Native) reusing `src/lib` unchanged
- Widgets / Live Activities for a deploy in flight

## License

MIT — see [LICENSE](LICENSE).
