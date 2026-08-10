import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  companionRequestAllowed,
  normalizePairingCode,
  resetClaimFailures,
  sha256
} from "./services/companion.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

function enablePasswordAuth(ctx: Ctx): void {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db.prepare("DELETE FROM companion_devices").run();
  ctx.db.prepare("DELETE FROM companion_pairings").run();
  // The claim-failure budget is keyed by caller IP and lives in module scope,
  // so without this one test's bad guesses lock out the next one's.
  resetClaimFailures();
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
    assert.equal(attempts?.attempts, 1, "a miss must be recorded against the live pairing");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion pairing: a stranger's wrong guesses cannot destroy a live pairing", async () => {
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

    // The claim endpoint is unauthenticated by necessity, so anyone who can
    // reach it can guess. Guessing must cost the guesser, never the operator.
    for (let i = 0; i < 5; i += 1) {
      const bad = await ctx.app.inject({
        method: "POST",
        url: "/companion/pair/claim",
        payload: { code: `ZZZZ-ZZZ${i}`, deviceName: "Guesser" }
      });
      assert.equal(bad.statusCode, 401);
    }

    const survivor = await ctx.app.inject({
      method: "GET",
      url: `/companion/pairings/${pairing.id}`,
      headers: { authorization: `Bearer ${session}` }
    });
    assert.equal(survivor.statusCode, 200, "the operator's pairing must survive someone else's guessing");
    assert.equal(survivor.json().status, "pending");
    assert.equal(survivor.json().failedAttempts, 5, "the operator needs to see that it is being guessed at");

    // …and the real code still works afterwards.
    const claimed = await ctx.app.inject({
      method: "POST",
      url: "/companion/pair/claim",
      payload: { code: pairing.code, deviceName: "Pixel 9" }
    });
    assert.equal(claimed.statusCode, 200);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion pairing: a persistent guesser burns through its own budget", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    let locked = false;
    // Fewer than the route's 10/min rate limit, so what we observe is the
    // failure budget rather than the rate limiter standing in front of it.
    for (let i = 0; i < 9; i += 1) {
      const bad = await ctx.app.inject({
        method: "POST",
        url: "/companion/pair/claim",
        payload: { code: `YYYY-YY${String(i).padStart(2, "0")}`, deviceName: "Guesser" }
      });
      if (bad.statusCode === 429) {
        assert.equal(bad.json().code, "PAIRING_LOCKED");
        locked = true;
        break;
      }
    }
    assert.ok(locked, "a caller must eventually be cut off from guessing");
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
    //
    // The `/databases/*` and `/services/:id/requests` entries are the reason
    // this list is now checked against an allowlist. Under the original
    // denylist every one of them answered 200: `/databases/:id` returns each
    // managed database's connection string in the clear, the table preview
    // returns arbitrary rows, the backup download streams a whole dump, and the
    // request inspector replays the Authorization headers of proxied apps.
    for (const url of [
      "/secrets",
      "/backup/export",
      "/settings/ssh",
      "/settings",
      "/companion/devices",
      "/databases",
      "/databases/abc",
      "/databases/abc/tables/public/users/preview",
      "/databases/abc/backups/xyz/download",
      "/services/abc/requests",
      "/deployments",
      "/logs/query",
      "/projects/abc/env",
      "/resources/abc",
      "/ops/diagnostics"
    ]) {
      const resp = await ctx.app.inject({ method: "GET", url, headers: auth });
      assert.equal(resp.statusCode, 403, `${url} must not be readable by a phone`);
      assert.equal(resp.json().code, "COMPANION_SCOPE_DENIED");
    }

    // …while the reads the app actually makes still work.
    for (const url of ["/companion/summary", "/services", "/projects", "/notifications"]) {
      const resp = await ctx.app.inject({ method: "GET", url, headers: auth });
      assert.equal(resp.statusCode, 200, `${url} is what the phone is for`);
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

test("companion device: a read-only phone can still revoke itself", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);
    const { claim } = await pairPhone(ctx, session, "read");
    const auth = { authorization: `Bearer ${claim.token}` };

    assert.equal(claim.scope, "read");
    // It cannot drive anything…
    const restart = await ctx.app.inject({
      method: "POST",
      url: "/services/abc/restart",
      headers: auth
    });
    assert.equal(restart.statusCode, 403);

    // …but "forget this server" is not a privilege. A read-only phone left in a
    // taxi is exactly the case where self-revocation has to work from the phone.
    const unpaired = await ctx.app.inject({ method: "POST", url: "/companion/unpair", headers: auth });
    assert.equal(unpaired.statusCode, 200);

    const afterUnpair = await ctx.app.inject({ method: "GET", url: "/services", headers: auth });
    assert.equal(afterUnpair.statusCode, 401, "the token must be dead once the phone forgets the server");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("companion device: writes are attributable in the audit log", async () => {
  const ctx = await buildApp();
  try {
    enablePasswordAuth(ctx);
    const session = await login(ctx);
    const { claim } = await pairPhone(ctx, session);
    const auth = { authorization: `Bearer ${claim.token}` };

    ctx.db.prepare("DELETE FROM audit_logs").run();
    // Refused writes matter as much as accepted ones — a phone probing for the
    // delete route is the signal that a token has been stolen.
    await ctx.app.inject({ method: "DELETE", url: "/services/abc", headers: auth });
    await ctx.app.inject({ method: "POST", url: "/notifications/read-all", headers: auth });

    const entries = ctx.db
      .prepare("SELECT actor, action, status_code FROM audit_logs ORDER BY created_at")
      .all() as Array<{ actor: string; action: string; status_code: number }>;

    assert.ok(
      entries.every((e) => e.actor === `companion:${claim.deviceId}`),
      "every entry must name the device, not the dashboard"
    );
    assert.ok(
      entries.some((e) => e.action === "DELETE /services/abc" && e.status_code === 403),
      "a refused write must be recorded"
    );
    assert.ok(
      entries.some((e) => e.action === "POST /notifications/read-all"),
      "an accepted write must be recorded"
    );

    // Reads are not audited — the phone polls, and a row per poll would bury
    // the writes that actually matter.
    await ctx.app.inject({ method: "GET", url: "/services", headers: auth });
    const afterRead = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number };
    assert.equal(afterRead.n, entries.length);
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

  // Self-service is not a privilege — it works at either scope.
  assert.equal(companionRequestAllowed("read", "POST", "/companion/unpair"), true);
  assert.equal(companionRequestAllowed("read", "POST", "/companion/heartbeat"), true);

  // Anything outside the control allowlist stays refused, including the writes
  // that would let a phone reshape the fleet.
  assert.equal(companionRequestAllowed("control", "POST", "/services"), false);
  assert.equal(companionRequestAllowed("control", "DELETE", "/services/abc"), false);
  assert.equal(companionRequestAllowed("control", "POST", "/services/abc/terminal-sessions"), false);
  assert.equal(companionRequestAllowed("control", "PUT", "/settings"), false);
  assert.equal(companionRequestAllowed("control", "POST", "/backup/import"), false);

  // Reads are an allowlist: anything not named is refused, which is what makes
  // adding a route to this control plane safe by default.
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/env"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/api/ai-gateway/tokens"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/ops/audit-logs"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/databases/abc"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/requests"), false);
  assert.equal(companionRequestAllowed("control", "GET", "/some/route/invented/tomorrow"), false);
  // The sibling collection route is not the `/services/:id` this list means.
  assert.equal(companionRequestAllowed("control", "GET", "/services/env-requirements"), false);
  // …and the reads the app actually makes still work.
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc"), true);
  assert.equal(companionRequestAllowed("control", "GET", "/services/abc/logs"), true);
  assert.equal(companionRequestAllowed("control", "GET", "/companion/summary"), true);
});

test("normalizePairingCode: forgives how a human types a code off a screen", () => {
  assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairingCode(" ABCD EFGH "), "ABCDEFGH");
  assert.equal(normalizePairingCode("ABCDEFGH"), "ABCDEFGH");
});
