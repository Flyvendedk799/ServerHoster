import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import { injectGitCredentials, setSecretSetting, getSecretSetting } from "./services/settings.js";

test("settings: encrypted github_pat round-trip", async () => {
  const ctx = await buildApp();
  try {
    setSecretSetting(ctx, "github_pat", "ghp_testtokenvalue123");
    assert.equal(getSecretSetting(ctx, "github_pat"), "ghp_testtokenvalue123");
    // Raw row in DB must NOT equal plaintext (it's ciphertext).
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get("github_pat") as { value: string };
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
