import { ApiError, OfflineError } from "./client";
import type { PairedServer } from "./vault";
import { addServer } from "./vault";

/**
 * Turning "a thing the camera saw" into a paired machine.
 *
 * Three shapes reach `parsePairingInput`, and all three are things a real user
 * actually produces:
 *
 *   1. The raw JSON payload the dashboard's QR encodes.
 *   2. A deep link — `https://companion.example/#/pair?s=…&c=…` — which is what
 *      the QR encodes when the operator has told their machine where this app
 *      is hosted. The phone's stock camera can open that one directly.
 *   3. Nothing but the code, typed in by hand, when the camera won't cooperate.
 *      That path has no server URL in it, so the UI has to ask for one — unless
 *      a control plane served this app, in which case it already told us its
 *      address and the field arrives filled in.
 */

export type PairingInput = {
  serverUrl: string | null;
  code: string;
  serverName: string | null;
};

function cleanUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * The machine that served this bundle, when one did.
 *
 * A control plane serving the app at /m stamps
 * `<meta name="survhub-server" content="…">` into the HTML with the exact
 * origin the request arrived on. That beats `location.origin`: the bundle also
 * runs on Cloudflare Pages, where its own origin is not a control plane and
 * offering it as the server address would send people down a dead end.
 */
export function servingMachineUrl(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="survhub-server"]');
  const content = meta?.getAttribute("content")?.trim();
  if (!content || !/^https?:\/\//i.test(content)) return null;
  return cleanUrl(content);
}

export function parsePairingInput(raw: string): PairingInput | null {
  const text = raw.trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        t?: string;
        url?: string;
        code?: string;
        name?: string;
      };
      if (parsed.t !== "serverhoster-pair" || !parsed.code) return null;
      return {
        serverUrl: parsed.url ? cleanUrl(parsed.url) : null,
        code: parsed.code,
        serverName: parsed.name ?? null
      };
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      // The deep link keeps its parameters in the hash so they never reach the
      // app's own web server logs — a pairing code in an access log is a
      // pairing code someone else can use.
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
      const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : url.search.slice(1);
      const params = new URLSearchParams(query);
      const code = params.get("c") ?? params.get("code");
      if (!code) return null;
      const server = params.get("s") ?? params.get("server");
      return {
        // A link with no `s` came from a machine hosting this app itself, so
        // the link's own origin IS the control plane. Falling back to it is
        // what lets a QR stay short and still pair in one tap.
        serverUrl: cleanUrl(server ?? url.origin),
        code,
        serverName: null
      };
    } catch {
      return null;
    }
  }

  // A bare code. Anything that isn't obviously a code is rejected rather than
  // sent to a server that would only 401 on it.
  const bare = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (bare.length < 6 || bare.length > 16) return null;
  return { serverUrl: null, code: bare, serverName: null };
}

type ClaimResponse = {
  token: string;
  deviceId: string;
  deviceName: string;
  scope: "read" | "control";
  expiresAt: number;
  serverUrl: string;
  server: { name: string; platform: string };
};

/** A name the operator will recognize in the dashboard's device list. */
export function suggestDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android phone";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  return "Phone";
}

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

export class PairingFailure extends Error {
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "PairingFailure";
    this.hint = hint;
  }
}

/**
 * Redeem a code against a machine and store the resulting device token.
 *
 * `serverUrl` is what the phone will use from now on, so it wins over the URL
 * the payload suggested — an operator who typed a different address into the
 * form did so because the one in the QR does not resolve from here.
 */
export async function claimPairing(input: {
  serverUrl: string;
  code: string;
  deviceName: string;
}): Promise<PairedServer> {
  const base = cleanUrl(input.serverUrl);
  if (!/^https?:\/\//i.test(base)) {
    throw new PairingFailure(
      "That doesn't look like a server address",
      "It should start with https:// — for example https://hoster.example.com"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${base}/companion/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        deviceName: input.deviceName.trim() || suggestDeviceName(),
        platform: detectPlatform()
      })
    });
  } catch {
    throw new PairingFailure(
      "Couldn't reach that server",
      servingMachineUrl() === base
        ? `Check that ${base} is still reachable from this phone — it is the address this app was loaded from, so the connection dropped between opening it and pairing.`
        : `Check that ${base} is reachable from this phone. A localhost or 192.168.x address only works on the same Wi-Fi, and the machine must allow this app's origin (SURVHUB_COMPANION_APP_URL).`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let code: string | undefined;
    let message = `Pairing failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string };
      code = parsed.code;
      message = parsed.error ?? message;
    } catch {
      /* non-JSON body */
    }
    const hints: Record<string, string> = {
      PAIRING_INVALID: "Check the code, or generate a fresh one on the dashboard.",
      PAIRING_USED: "That code was already used. Generate a new one on the dashboard.",
      PAIRING_EXPIRED: "Codes last five minutes. Generate a new one on the dashboard.",
      PAIRING_LOCKED: "Too many wrong attempts. Generate a new code on the dashboard."
    };
    throw new PairingFailure(
      message,
      hints[code ?? ""] ?? "Generate a fresh pairing code on the dashboard and try again."
    );
  }

  const claim = (await response.json()) as ClaimResponse;
  const server: PairedServer = {
    id: claim.deviceId,
    // Prefer the address the phone actually used: `claim.serverUrl` is what the
    // dashboard *thinks* is reachable, which is not always what worked.
    url: base,
    name: claim.server?.name || "ServerHoster",
    token: claim.token,
    scope: claim.scope,
    platform: claim.server?.platform ?? null,
    pairedAt: new Date().toISOString(),
    expiresAt: claim.expiresAt
  };
  addServer(server);
  return server;
}

/** Human-readable text for the errors the rest of the app throws at us. */
export function describeError(err: unknown): string {
  if (err instanceof PairingFailure) return `${err.message}. ${err.hint}`;
  if (err instanceof OfflineError) return err.message;
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
