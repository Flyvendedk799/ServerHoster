import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve the companion PWA from the control plane itself, at `/m`.
 *
 * The companion app used to be a bundle you had to build and host somewhere
 * else, then point the machine at with `SURVHUB_COMPANION_APP_URL`. Nobody does
 * that, so in practice the pairing QR encoded the raw JSON payload — and a
 * phone camera, seeing an `http://…` inside that JSON, opens the *dashboard*.
 * You end up on the desktop UI at phone width instead of the pairing screen,
 * which is exactly the wrong half of the product.
 *
 * Hosting it here removes the choice: the app is always at `<server>/m`, the QR
 * always deep-links into it, and because it is the same origin as the API there
 * is no CORS to configure. `SURVHUB_COMPANION_APP_URL` still wins when set, for
 * anyone who genuinely hosts it elsewhere.
 *
 * `/m` rather than `/companion/app`: the path goes inside the QR, and shorter
 * means fewer modules means a code a phone reads across a desk.
 */

export const COMPANION_MOUNT_PATH = "/m";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * Where the built companion bundle might be. Mirrors the dashboard's search:
 * alongside the server's dist when packaged, one level up, and the repo's
 * `companion/dist` for a checkout.
 */
function candidateDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "../companion-dist"),
    path.resolve(here, "../../companion-dist"),
    path.resolve(here, "../../../../companion/dist")
  ];
}

let resolved: string | null | undefined;

/**
 * The bundle's directory, or null when it was never built. Cached after the
 * first look so the request hook is not a stat storm; `resetCompanionDist`
 * clears it for tests.
 */
export function companionDistDir(): string | null {
  if (resolved !== undefined) return resolved;
  resolved =
    candidateDirs().find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "index.html"));
      } catch {
        return false;
      }
    }) ?? null;
  return resolved;
}

/** Test seam: forget the cached lookup (and optionally pin a directory). */
export function resetCompanionDist(dir?: string | null): void {
  resolved = dir === undefined ? undefined : dir;
}

/** True when this machine can serve the companion app at {@link COMPANION_MOUNT_PATH}. */
export function companionAppBundled(): boolean {
  return companionDistDir() !== null;
}

/**
 * Tell the app which machine served it.
 *
 * The bundle is host-agnostic on purpose — the same files work on Cloudflare
 * Pages — so it cannot assume its own origin is a control plane. When WE serve
 * it, we know, and we know the exact address the phone reached us on, which is
 * by definition an address that works from that phone. That is worth more than
 * anything the server could infer about itself, so it goes into the HTML and
 * the app prefills the server field from it.
 */
export function injectServerOrigin(html: string, origin: string | null): string {
  if (!origin) return html;
  const tag = `<meta name="survhub-server" content="${escapeAttribute(origin)}">`;
  return html.includes("</head>") ? html.replace("</head>", `  ${tag}\n  </head>`) : `${tag}${html}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The origin a request reached us on, honouring a trusted proxy's headers. */
export function requestOrigin(
  headers: Record<string, unknown>,
  fallbackProtocol: string,
  trustProxy: boolean
): string | null {
  const header = (name: string): string | null => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const host = (trustProxy ? header("x-forwarded-host") : null) ?? header("host");
  if (!host) return null;
  // A forwarded host list ("a.example, b.example") means several hops; the
  // first is the one the client actually typed.
  const firstHost = host.split(",")[0].trim();
  if (!/^[A-Za-z0-9._:\-[\]]+$/.test(firstHost)) return null;
  const forwardedProto = trustProxy ? header("x-forwarded-proto") : null;
  const proto = (forwardedProto ?? fallbackProtocol).split(",")[0].trim();
  return `${proto === "https" ? "https" : "http"}://${firstHost}`;
}

export type CompanionStaticRequest = {
  method?: string;
  url: string;
  headers: Record<string, unknown>;
  protocol: string;
};

export type CompanionStaticResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

/**
 * Resolve one request against the bundle. Pure enough to test: it takes the
 * request shape and a directory, and returns what to send (or null to fall
 * through to the rest of the router).
 */
export function serveCompanionAsset(
  dir: string,
  req: CompanionStaticRequest,
  options: { trustProxy: boolean }
): CompanionStaticResponse | null {
  if (req.method && req.method !== "GET" && req.method !== "HEAD") return null;
  const urlPath = req.url.split("?")[0];
  if (urlPath !== COMPANION_MOUNT_PATH && !urlPath.startsWith(`${COMPANION_MOUNT_PATH}/`)) return null;

  // `/m` without the slash: relative asset URLs in the bundle would resolve
  // against `/` and 404, so send the browser to `/m/` first.
  if (urlPath === COMPANION_MOUNT_PATH) {
    return {
      status: 308,
      headers: { location: `${COMPANION_MOUNT_PATH}/`, "cache-control": "no-cache" },
      body: Buffer.alloc(0)
    };
  }

  const relative = urlPath.slice(COMPANION_MOUNT_PATH.length + 1);
  const clean = path.posix.normalize(`/${relative}`).replace(/^\/+/, "");
  let filePath = path.join(dir, clean);
  // Traversal guard: anything that escapes the bundle collapses onto index.html.
  if (!filePath.startsWith(dir)) filePath = path.join(dir, "index.html");

  try {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stat || stat.isDirectory()) filePath = path.join(dir, "index.html");
  } catch {
    filePath = path.join(dir, "index.html");
  }
  if (!fs.existsSync(filePath)) return null;

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    const origin = requestOrigin(req.headers, req.protocol, options.trustProxy);
    return {
      status: 200,
      headers: {
        "content-type": MIME_TYPES[".html"],
        // The injected origin is per-request, so this must never be shared
        // between hosts by an intermediary cache.
        "cache-control": "no-store",
        vary: "Host, X-Forwarded-Host"
      },
      body: Buffer.from(injectServerOrigin(fs.readFileSync(filePath, "utf8"), origin), "utf8")
    };
  }
  return {
    status: 200,
    headers: {
      "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
      // Vite fingerprints its assets; sw.js and the manifest must not be
      // pinned or an update never reaches an installed app.
      "cache-control":
        ext === ".webmanifest" || filePath.endsWith("sw.js")
          ? "no-cache"
          : "public, max-age=31536000, immutable"
    },
    body: fs.readFileSync(filePath)
  };
}
