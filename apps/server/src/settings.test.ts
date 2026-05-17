import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { ensureRepoWebhook } from "./services/github.js";
import { injectGitCredentials, setSecretSetting, getSecretSetting } from "./services/settings.js";

test("settings: encrypted github_pat round-trip", async () => {
  const ctx = await buildApp();
  try {
    setSecretSetting(ctx, "github_pat", "ghp_testtokenvalue123");
    assert.equal(getSecretSetting(ctx, "github_pat"), "ghp_testtokenvalue123");
    // Raw row in DB must NOT equal plaintext (it's ciphertext).
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get("github_pat") as {
      value: string;
    };
    assert.notEqual(row.value, "ghp_testtokenvalue123");
  } finally {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    await gracefulShutdown(ctx);
  }
});

test("injectGitCredentials: rewrites github.com HTTPS URLs", async () => {
  const ctx = await buildApp();
  try {
    setSecretSetting(ctx, "github_pat", "ghp_abc123xyz");
    const injected = injectGitCredentials(ctx, "https://github.com/acme/widget.git");
    assert.match(injected, /x-access-token:ghp_abc123xyz@github\.com\/acme\/widget\.git/);
  } finally {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    await gracefulShutdown(ctx);
  }
});

test("injectGitCredentials: leaves non-github URLs alone", async () => {
  const ctx = await buildApp();
  try {
    setSecretSetting(ctx, "github_pat", "ghp_abc");
    const untouched = injectGitCredentials(ctx, "https://gitlab.com/org/repo.git");
    assert.equal(untouched, "https://gitlab.com/org/repo.git");
  } finally {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    await gracefulShutdown(ctx);
  }
});

test("injectGitCredentials: leaves SSH URLs alone", async () => {
  const ctx = await buildApp();
  try {
    setSecretSetting(ctx, "github_pat", "ghp_abc");
    const untouched = injectGitCredentials(ctx, "git@github.com:org/repo.git");
    assert.equal(untouched, "git@github.com:org/repo.git");
  } finally {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    await gracefulShutdown(ctx);
  }
});

test("injectGitCredentials: no PAT configured → URL unchanged", async () => {
  const ctx = await buildApp();
  try {
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    const untouched = injectGitCredentials(ctx, "https://github.com/org/repo.git");
    assert.equal(untouched, "https://github.com/org/repo.git");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("ensureRepoWebhook: refreshes an existing hook with the current secret", async () => {
  const ctx = await buildApp();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    setSecretSetting(ctx, "github_pat", "ghp_testtokenvalue123");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/acme/widget/hooks?per_page=100")) {
        return new Response(
          JSON.stringify([{ id: 42, config: { url: "https://host.example/webhooks/github" } }]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (url.endsWith("/repos/acme/widget/hooks/42") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await ensureRepoWebhook(
      ctx,
      "acme/widget",
      "https://host.example/webhooks/github",
      "webhook-secret"
    );

    assert.deepEqual(result, { id: 42, created: false, updated: true });
    const patch = calls.find((call) => call.init?.method === "PATCH");
    assert.ok(patch);
    const body = JSON.parse(String(patch.init?.body)) as { config?: { secret?: string } };
    assert.equal(body.config?.secret, "webhook-secret");
  } finally {
    globalThis.fetch = originalFetch;
    ctx.db.prepare("DELETE FROM settings WHERE key = 'github_pat'").run();
    await gracefulShutdown(ctx);
  }
});
