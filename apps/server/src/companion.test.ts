import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { companionRequestAllowed, normalizePairingCode, sha256 } from "./services/companion.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function enablePasswordAuth(ctx: Ctx): void {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db.prepare("DELETE FROM companion_devices").run();
  ctx.db.prepare("DELETE FROM companion_pairings").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
}

async function login(ctx: Ctx): Promise<string> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(resp.statusCode, 200);
  return resp.json().token as string;
}

async function pairPhone(ctx: Ctx, sessionToken: string, scope: "read" | "control" = "control") {
  const minted = await ctx.app.inject({
    method: "POST",
    url: "/companion/pairings",
    headers: { authorization: `Bearer ${sessionToken}`, host: "box.example.com" },
    payload: { scope, label: "Pixel" }
  });
  assert.equal(minted.statusCode, 200);
  const pairing = minted.json();

  const claimed = await ctx.app.inject({
    method: "POST",
    url: "/companion/pair/claim",
    payload: { code: pairing.code, deviceName: "Pixel 9", platform: "android" }
  });
  assert.equal(claimed.statusCode, 200);
  return { pairing, claim: claimed.json() };
}

test("companion pairing: a QR code exchanges once for a scoped device token", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);
    const { pairing, claim } = await pairPhone(ctx, session);

    // The code the operator reads off the screen is never stored in the clear.
    const stored = ctx.db
      .prepare("SELECT code_hash FROM companion_pairings WHERE id = ?")
      .get(pairing.id) as { code_hash: string };
    assert.equal(stored.code_hash, sha256(normalizePairingCode(pairing.code)));
    assert.notEqual(stored.code_hash, pairing.code);

    // …and neither is the device token.
    const deviceRow = ctx.db
      .prepare("SELECT token_hash FROM companion_devices WHERE id = ?")
      .get(claim.deviceId) as { token_hash: string };
    assert.equal(deviceRow.token_hash, sha256(claim.token));

    // The QR payload carries the address the phone should call home on.
    const payload = JSON.parse(pairing.payload) as { url: string; code: string; t: string };
    assert.equal(payload.t, "serverhoster-pair");
    assert.equal(payload.url, "http://box.example.com");
    assert.equal(payload.code, pairing.code);

    // Single use: a second phone photographing the same screen loses.
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/companion/pair/claim",
      payload: { code: pairing.code, deviceName: "Stolen phone" }
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, "PAIRING_USED");

    // The desktop poll now shows the phone as connected.
    const status = await ctx.app.inject({
      method: "GET",
      url: `/companion/pairings/${pairing.id}`,
      headers: { authorization: `Bearer ${session}` }
    });
    assert.equal(status.json().status, "claimed");
    assert.equal(status.json().device.name, "Pixel 9");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion pairing: a wrong code is rejected and burns an attempt", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);
    const minted = await ctx.app.inject({
      method: "POST",
      url: "/companion/pairings",
      headers: { authorization: `Bearer ${session}`, host: "box.example.com" },
      payload: {}
    });
    const pairing = minted.json();

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/companion/pair/claim",
      payload: { code: "ZZZZ-ZZZZ", deviceName: "Guesser" }
    });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().code, "PAIRING_INVALID");

    const attempts = ctx.db
      .prepare("SELECT attempts FROM companion_pairings WHERE id = ?")
      .get(pairing.id) as { attempts: number } | undefined;
    assert.equal(attempts?.attempts, 1, "a miss must cost the live pairing an attempt");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion pairing: minting a code requires a dashboard session", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const anonymous = await ctx.app.inject({ method: "POST", url: "/companion/pairings", payload: {} });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion device token: can drive services but cannot read secrets or mint pairings", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);
    const { claim } = await pairPhone(ctx, session);
    const auth = { authorization: `Bearer ${claim.token}` };

    const summary = await ctx.app.inject({ method: "GET", url: "/companion/summary", headers: auth });
    assert.equal(summary.statusCode, 200);
    assert.ok(Array.isArray(summary.json().services));

    const services = await ctx.app.inject({ method: "GET", url: "/services", headers: auth });
    assert.equal(services.statusCode, 200);

    // Reads that would leak credentials off the host are refused outright.
    for (const url of ["/secrets", "/backup/export", "/settings/ssh", "/companion/devices"]) {
      const resp = await ctx.app.inject({ method: "GET", url, headers: auth });
      assert.equal(resp.statusCode, 403, `${url} must not be readable by a phone`);
      assert.equal(resp.json().code, "COMPANION_SCOPE_DENIED");
    }

    // Destructive writes are refused even though the token is valid.
    const deleted = await ctx.app.inject({ method: "DELETE", url: "/services/anything", headers: auth });
    assert.equal(deleted.statusCode, 403);

    // A stolen phone must not be able to enroll a second device.
    const escalate = await ctx.app.inject({
      method: "POST",
      url: "/companion/pairings",
      headers: auth,
      payload: {}
    });
    assert.equal(escalate.statusCode, 403);

    // Revoking from the dashboard kills the token immediately.
    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/companion/devices/${claim.deviceId}`,
      headers: { authorization: `Bearer ${session}` }
    });
    assert.equal(revoked.statusCode, 200);
    const afterRevoke = await ctx.app.inject({ method: "GET", url: "/services", headers: auth });
    assert.equal(afterRevoke.statusCode, 401);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion scope: read-only devices cannot start or stop anything", () => {
  assert.equal(companionRequestAllowed("control", "POST", "/services/abc/restart"), true);
  assert.equal(companionRequestAllowed("control", "POST", "/projects/abc/stop-all"), true);
  assert.equal(companionRequestAllowed("control", "POST", "/deployments/rollback"), true);
  assert.equal(companionRequestAllowed("read", "POST", "/services/abc/restart"), false);
  assert.equal(companionRequestAllowed("read", "GET", "/services"), true);

  // Anything outside the control allowlist stays refused, including the writes
  // that would let a phone reshape the fleet.
  assert.equal(companionRequestAllowed("control", "POST", "/services"), false);
  assert.equal(companionRequestAllowed("control", "DELETE", "/services/abc"), false);
  assert.equal(companionRequestAllowed("control", "POST", "/services/abc/terminal-sessions"), false);
  assert.equal(companionRequestAllowed("control", "PUT", "/settings"), false);
  assert.equal(companionRequestAllowed("control", "POST", "/backup/import"), false);

  // Reads that expose credentials or host internals.
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/env"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/api/ai-gateway/tokens"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/ops/audit-logs"), false);
  // …but the neighbouring non-secret reads still work.
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/env-requirements"), true);
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/logs"), true);
});

test("normalizePairingCode: forgives how a human types a code off a screen", () => {
  assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairingCode(" ABCD EFGH "), "ABCDEFGH");
  assert.equal(normalizePairingCode("ABCDEFGH"), "ABCDEFGH");
});
