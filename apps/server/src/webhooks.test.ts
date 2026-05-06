import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { listTunnelAdapters } from "./services/tunnels/index.js";
import { registerBuiltinTunnelAdapters } from "./services/tunnels/register.js";

const SECRET = "test-webhook-secret";

function sign(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

const fakePayload = {
  ref: "refs/heads/main",
  repository: { clone_url: "https://github.com/example/never-matches.git" }
};

test("webhook: rejects when SURVHUB_WEBHOOK_SECRET is unset", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = "";
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify(fakePayload);
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: body
    });
    assert.equal(resp.statusCode, 503);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: rejects when signature is missing", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify(fakePayload);
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: body
    });
    assert.equal(resp.statusCode, 401);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: rejects when signature is wrong", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify(fakePayload);
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "0".repeat(64)
      },
      payload: body
    });
    assert.equal(resp.statusCode, 401);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: accepts a payload signed with the configured secret", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify(fakePayload);
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(SECRET, body)
      },
      payload: body
    });
    // Signature valid; payload doesn't match any service so it returns
    // {ok: true, matched: 0} with status 200.
    assert.equal(resp.statusCode, 200);
    const json = resp.json() as { ok: boolean; matched: number };
    assert.equal(json.ok, true);
    assert.equal(json.matched, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("tunnel adapters: registered and conform to the contract", () => {
  registerBuiltinTunnelAdapters();
  const adapters = listTunnelAdapters();
  const ids = adapters.map((a) => a.id).sort();
  assert.deepEqual(ids, ["cloudflare", "ngrok", "tailscale"]);
  for (const a of adapters) {
    assert.equal(typeof a.id, "string");
    assert.equal(typeof a.label, "string");
    assert.equal(typeof a.start, "function");
    assert.equal(typeof a.stop, "function");
    assert.equal(typeof a.status, "function");
    assert.equal(typeof a.available, "function");
  }
});
