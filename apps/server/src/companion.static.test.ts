import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { companionAppLink } from "./routes/companion.js";
import {
  COMPANION_MOUNT_PATH,
  injectServerOrigin,
  requestOrigin,
  serveCompanionAsset
} from "./services/companionStatic.js";

/**
 * Serving the companion PWA from the control plane at /m, and deep-linking the
 * pairing QR into it.
 *
 * The bug these pin down: with no app hosted anywhere the QR fell back to the
 * raw JSON payload, and a phone camera reading `{"url":"http://box:8787",…}`
 * opens that URL — the *dashboard*, at phone width, with no pairing screen.
 */

function fixtureBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-companion-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>Companion</title></head><body></body></html>"
  );
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "export default 1;");
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}");
  return dir;
}

function get(dir: string, url: string, headers: Record<string, unknown> = { host: "box:8787" }) {
  return serveCompanionAsset(dir, { method: "GET", url, headers, protocol: "http" }, { trustProxy: false });
}

// ---- the QR deep link -------------------------------------------------------

test("a bundled app makes the QR a link into the pairing screen, not a JSON blob", () => {
  const { appLink, appHosted } = companionAppLink({
    configuredAppUrl: "",
    serverUrl: "https://box.example.com",
    code: "ABCD2345",
    bundled: true
  });
  assert.equal(appHosted, "bundled");
  assert.equal(appLink, "https://box.example.com/m/#/pair?s=https%3A%2F%2Fbox.example.com&c=ABCD2345");
});

test("an externally hosted app still wins over the bundled one", () => {
  const { appLink, appHosted } = companionAppLink({
    configuredAppUrl: "https://companion.example.com/",
    serverUrl: "https://box.example.com",
    code: "ABCD2345",
    bundled: true
  });
  assert.equal(appHosted, "external");
  assert.match(appLink ?? "", /^https:\/\/companion\.example\.com\/#\/pair\?/);
});

test("with no app anywhere there is no link, and the QR falls back to the payload", () => {
  const { appLink, appHosted } = companionAppLink({
    configuredAppUrl: "",
    serverUrl: "https://box.example.com",
    code: "ABCD2345",
    bundled: false
  });
  assert.equal(appLink, null);
  assert.equal(appHosted, null);
});

test("the pairing code is percent-encoded into the link, never concatenated raw", () => {
  const { appLink } = companionAppLink({
    configuredAppUrl: "",
    serverUrl: "https://box.example.com",
    code: "AB CD&E",
    bundled: true
  });
  assert.match(appLink ?? "", /c=AB%20CD%26E$/);
});

// ---- serving the bundle -----------------------------------------------------

test("/m redirects to /m/ so the bundle's relative asset URLs resolve", () => {
  const dir = fixtureBundle();
  const res = get(dir, COMPANION_MOUNT_PATH);
  assert.equal(res?.status, 308);
  assert.equal(res?.headers.location, "/m/");
});

test("/m/ serves index.html and stamps in the address the phone reached us on", () => {
  const dir = fixtureBundle();
  const res = get(dir, "/m/");
  assert.equal(res?.status, 200);
  assert.match(res!.headers["content-type"], /text\/html/);
  assert.match(res!.body.toString(), /<meta name="survhub-server" content="http:\/\/box:8787">/);
  // Per-request content must never be cached by an intermediary for another host.
  assert.equal(res!.headers["cache-control"], "no-store");
});

test("a hash-routed deep link falls back to index.html rather than 404ing", () => {
  const dir = fixtureBundle();
  // The hash never reaches the server, so this is what /m/#/pair actually asks for.
  assert.match(get(dir, "/m/")!.body.toString(), /Companion/);
  assert.match(get(dir, "/m/pair")!.body.toString(), /Companion/);
});

test("fingerprinted assets are immutable; the service worker and manifest are not", () => {
  const dir = fixtureBundle();
  assert.match(get(dir, "/m/assets/index-abc123.js")!.headers["cache-control"], /immutable/);
  assert.equal(get(dir, "/m/sw.js")!.headers["cache-control"], "no-cache");
  assert.equal(get(dir, "/m/manifest.webmanifest")!.headers["cache-control"], "no-cache");
});

test("paths outside /m are left to the rest of the router", () => {
  const dir = fixtureBundle();
  assert.equal(get(dir, "/"), null);
  assert.equal(get(dir, "/services"), null);
  assert.equal(get(dir, "/mail"), null, "/m must not swallow a sibling prefix");
});

test("non-GET requests are never answered from the bundle", () => {
  const dir = fixtureBundle();
  const res = serveCompanionAsset(
    dir,
    { method: "POST", url: "/m/", headers: { host: "box:8787" }, protocol: "http" },
    { trustProxy: false }
  );
  assert.equal(res, null);
});

test("traversal out of the bundle collapses onto index.html", () => {
  const dir = fixtureBundle();
  const secret = path.join(path.dirname(dir), "outside-the-bundle.txt");
  fs.writeFileSync(secret, "not yours");
  for (const attempt of ["/m/../../etc/passwd", "/m/..%2f..%2fetc/passwd", "/m/../outside-the-bundle.txt"]) {
    const res = get(dir, attempt);
    assert.ok(res, `${attempt} should still answer`);
    assert.ok(!res!.body.toString().includes("not yours"), `${attempt} escaped the bundle`);
  }
});

// ---- the origin we stamp in -------------------------------------------------

test("the stamped origin follows the proxy headers only when the proxy is trusted", () => {
  const headers = {
    host: "internal:8787",
    "x-forwarded-host": "hoster.example.com",
    "x-forwarded-proto": "https"
  };
  assert.equal(requestOrigin(headers, "http", true), "https://hoster.example.com");
  assert.equal(
    requestOrigin(headers, "http", false),
    "http://internal:8787",
    "an untrusted caller must not be able to name the origin we hand the phone"
  );
});

test("a forwarded host list takes the first hop, and a junk host stamps nothing", () => {
  assert.equal(
    requestOrigin({ "x-forwarded-host": "a.example, b.example", "x-forwarded-proto": "https" }, "http", true),
    "https://a.example"
  );
  assert.equal(requestOrigin({ host: "bad host/../x" }, "http", false), null);
  assert.equal(requestOrigin({}, "http", false), null);
});

test("the injected meta tag escapes its content and no-ops without an origin", () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  assert.equal(injectServerOrigin(html, null), html);
  const injected = injectServerOrigin(html, 'http://x"><script>alert(1)</script>');
  assert.ok(!injected.includes("<script>alert(1)</script>"), injected);
  assert.ok(injected.includes("&quot;&gt;&lt;script"), injected);
});
