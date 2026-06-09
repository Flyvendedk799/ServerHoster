import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { setSetting } from "./services/settings.js";
import { nowIso } from "./lib/core.js";
import { getExposure } from "./services/exposure.js";
import {
  CF_LOGIN_URL_RE,
  buildIngressConfig,
  isCloudflareConnected,
  parseRoutedFqdn,
  parseTunnelId,
  reconcileLoginTunnelOnBoot
} from "./services/cloudflare.js";

test("parseRoutedFqdn: catches a wrong-zone bind (cloudflared appended the authorized zone)", () => {
  // The real bug: binding fastprice.dk with a cert scoped to mast3kmedia.dk.
  assert.equal(
    parseRoutedFqdn(
      "2026-06-09T11:37:33Z INF fastprice.dk.mast3kmedia.dk is already configured to route to your tunnel tunnelID=fd0f0498"
    ),
    "fastprice.dk.mast3kmedia.dk"
  );
  // A correct bind into the domain's own zone.
  assert.equal(
    parseRoutedFqdn("2026-06-09T11:00:00Z INF Added CNAME fastprice.dk which will route to this tunnel"),
    "fastprice.dk"
  );
  assert.equal(
    parseRoutedFqdn("INF mast3kmedia.dk is already configured to route to your tunnel"),
    "mast3kmedia.dk"
  );
  // --overwrite-dns phrasings must also be caught (else a wrong-zone overwrite
  // bind slips the guard).
  assert.equal(
    parseRoutedFqdn("INF Updated CNAME fastprice.dk.mast3kmedia.dk which will route to this tunnel"),
    "fastprice.dk.mast3kmedia.dk"
  );
  assert.equal(
    parseRoutedFqdn("INF fastprice.dk.mast3kmedia.dk updated to route to your tunnel"),
    "fastprice.dk.mast3kmedia.dk"
  );
  assert.equal(parseRoutedFqdn("no recognizable line here"), null);
});

test("parseTunnelId: array reuse, object id/ID, garbage", () => {
  assert.equal(parseTunnelId('[{"id":"abc","name":"x"}]'), "abc");
  assert.equal(parseTunnelId('{"id":"def"}'), "def");
  assert.equal(parseTunnelId('{"ID":"ghi"}'), "ghi");
  assert.equal(parseTunnelId("not json"), null);
  assert.equal(parseTunnelId("[]"), null);
  assert.equal(parseTunnelId(""), null);
});

test("buildIngressConfig: one rule per route, 404 catch-all is LAST", () => {
  const cfg = buildIngressConfig("tid", "/creds.json", [
    { domain: "a.example.com", port: 3000 },
    { domain: "b.example.com", port: 4000 }
  ]);
  assert.match(cfg, /^tunnel: tid$/m);
  assert.match(cfg, /^credentials-file: \/creds\.json$/m);
  assert.match(cfg, /- hostname: a\.example\.com\n {4}service: http:\/\/localhost:3000/);
  assert.match(cfg, /- hostname: b\.example\.com\n {4}service: http:\/\/localhost:4000/);
  const lines = cfg.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1].trim(), "- service: http_status:404");
});

test("buildIngressConfig: zero routes → only the 404 catch-all", () => {
  const cfg = buildIngressConfig("tid", "/c.json", []);
  assert.match(cfg, /ingress:\n {2}- service: http_status:404\n/);
  assert.doesNotMatch(cfg, /hostname:/);
});

test("CF_LOGIN_URL_RE captures the dash.cloudflare.com/argotunnel URL", () => {
  const line =
    "Please open the following URL: https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc123";
  const m = CF_LOGIN_URL_RE.exec(line);
  assert.ok(m);
  assert.match(m[0], /^https:\/\/dash\.cloudflare\.com\/argotunnel/);
  assert.equal(CF_LOGIN_URL_RE.exec("no url on this line"), null);
});

test("reconcileLoginTunnelOnBoot: no-op (no spawn, no throw) when Cloudflare isn't connected", async () => {
  const ctx = await buildApp();
  try {
    // Fresh app: no cert.pem, no login tunnel id → isCloudflareConnected() is
    // false, so the boot reconcile must return before ever shelling out to
    // cloudflared. Removing the guard would surface here as a throw.
    assert.equal(isCloudflareConnected(ctx), false);
    assert.doesNotThrow(() => reconcileLoginTunnelOnBoot(ctx));
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("isCloudflareConnected + exposure capability flip once cert.pem AND tunnel id exist", async () => {
  const ctx = await buildApp();
  const serviceId = nanoid();
  try {
    // seed a minimal service so getExposure has a row
    ctx.db
      .prepare(
        `INSERT INTO services
         (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
          auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(serviceId, "p1", "svc", "process", "", "", "", "", 3000, "stopped", 1, 0, 5, "manual", nowIso(), nowIso());

    assert.equal(isCloudflareConnected(ctx), false);
    assert.equal(getExposure(ctx, serviceId).capabilities.cloudflareConnected, false);

    const dir = path.join(ctx.config.dataRoot, "cloudflared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cert.pem"), "fake-cert");
    // cert present but no tunnel id yet → still not connected
    assert.equal(isCloudflareConnected(ctx), false);

    setSetting(ctx, "cloudflare_login_tunnel_id", "tunnel-uuid");
    setSetting(ctx, "cloudflare_login_tunnel_name", "serverhoster");
    assert.equal(isCloudflareConnected(ctx), true);

    const cap = getExposure(ctx, serviceId).capabilities;
    assert.equal(cap.cloudflareConnected, true);
    assert.equal(cap.cloudflareAccountLabel, "serverhoster");
  } finally {
    // The test-runner shares one data dir + DB across test files — remove the
    // fake cert and the login settings so a sibling's isCloudflareConnected()
    // isn't polluted (the real ~/.cloudflared/cert.pem may also exist on a dev box).
    try {
      fs.rmSync(path.join(ctx.config.dataRoot, "cloudflared", "cert.pem"), { force: true });
      ctx.db.prepare("DELETE FROM settings WHERE key LIKE 'cloudflare_login_%'").run();
    } catch {
      /* ignore */
    }
    await gracefulShutdown(ctx);
  }
});
