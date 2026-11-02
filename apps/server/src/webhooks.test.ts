import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
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

test("webhook: ignores deleted branch payloads", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify({ ...fakePayload, deleted: true });
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(SECRET, body)
      },
      payload: body
    });
    assert.equal(resp.statusCode, 200);
    const json = resp.json() as { matched: number; skippedDeleted: boolean };
    assert.equal(json.matched, 0);
    assert.equal(json.skippedDeleted, true);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: rejects replayed delivery ids", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const body = JSON.stringify(fakePayload);
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": sign(SECRET, body),
      "x-github-delivery": "delivery-id-replay-test"
    };
    const first = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers,
      payload: body
    });
    assert.equal(first.statusCode, 200);
    const second = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers,
      payload: body
    });
    assert.equal(second.statusCode, 409);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: honors per-service GitHub auto-update toggle", async () => {
  const ctx = await buildApp();
  const projectId = nanoid();
  const serviceId = nanoid();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const now = nowIso();
    ctx.db
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(projectId, "webhook-project", now, now);
    ctx.db
      .prepare(
        `INSERT INTO services (
          id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
          auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at,
          github_repo_url, github_branch, github_auto_pull
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        serviceId,
        projectId,
        "webhook-disabled-service",
        "process",
        "",
        "",
        "",
        "",
        0,
        "stopped",
        1,
        0,
        5,
        "manual",
        now,
        now,
        "https://github.com/example/widget.git",
        "main",
        0
      );
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: {
        full_name: "example/widget",
        clone_url: "https://github.com/example/widget.git",
        html_url: "https://github.com/example/widget"
      }
    });
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(SECRET, body)
      },
      payload: body
    });
    assert.equal(resp.statusCode, 200);
    const json = resp.json() as { matched: number; skippedAutoPull: number };
    assert.equal(json.matched, 0);
    assert.equal(json.skippedAutoPull, 1);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: rejects payloads with stale timestamp header", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    ctx.config.webhookMaxSkewSeconds = 60;
    const body = JSON.stringify(fakePayload);
    const ancient = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(SECRET, body),
        "x-hub-timestamp": String(ancient),
        "x-github-delivery": "delivery-id-stale-test"
      },
      payload: body
    });
    assert.equal(resp.statusCode, 401);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("admin reset: 503 when SURVHUB_ADMIN_RESET_TOKEN is unset", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.adminResetToken = "";
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/admin/reset-admin",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });
    assert.equal(resp.statusCode, 503);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("admin reset: 401 when token mismatches", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.adminResetToken = "the-real-token";
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/admin/reset-admin",
      headers: {
        "content-type": "application/json",
        "x-admin-reset-token": "the-wrong-token"
      },
      payload: "{}"
    });
    assert.equal(resp.statusCode, 401);
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

function seedWebhookService(
  ctx: Awaited<ReturnType<typeof buildApp>>,
  opts: { repo: string; branch: string; pipeline?: boolean }
): string {
  const projectId = nanoid();
  const serviceId = nanoid();
  const now = nowIso();
  ctx.db
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(projectId, `p-${projectId}`, now, now);
  ctx.db
    .prepare(
      `INSERT INTO services (
        id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at,
        github_repo_url, github_branch, github_auto_pull
      ) VALUES (?, ?, ?, 'process', '', '', '', '', 0, 'stopped', 1, 0, 5, 'manual', ?, ?, ?, ?, 0)`
    )
    .run(
      serviceId,
      projectId,
      `s-${serviceId}`,
      now,
      now,
      `https://github.com/${opts.repo}.git`,
      opts.branch
    );
  if (opts.pipeline) {
    ctx.db
      .prepare(
        `INSERT INTO ci_pipelines
         (id, service_id, name, enabled, gate_deploy, config_source, inline_config, image, timeout_minutes, memory_mb, cpus,
          trigger_branches, created_at, updated_at)
         VALUES (?, ?, 'CI', 1, 0, 'inline', 'steps:\n  - name: t\n    run: "true"\n', 'node:22', 20, 2048, 1, '*', ?, ?)`
      )
      .run(nanoid(), serviceId, now, now);
  }
  return serviceId;
}

async function deliver(
  ctx: Awaited<ReturnType<typeof buildApp>>,
  event: string,
  payload: unknown
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": sign(SECRET, body)
    },
    payload: body
  });
  return { statusCode: resp.statusCode, json: resp.json() as Record<string, unknown> };
}

function prPayload(repo: string, headRepo: string, number: number) {
  return {
    action: "opened",
    number,
    pull_request: {
      head: { sha: "f".repeat(40), ref: "feature/x", repo: { full_name: headRepo } },
      base: { ref: "main", repo: { full_name: repo } }
    },
    repository: { full_name: repo, clone_url: `https://github.com/${repo}.git` }
  };
}

test("webhook: branch matching uses the full ref", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const repo = `example/fullref-${nanoid(6)}`;
    seedWebhookService(ctx, { repo, branch: "main" });
    // The old split("/").pop() read refs/heads/feature/main as "main".
    const nested = await deliver(ctx, "push", {
      ref: "refs/heads/feature/main",
      repository: { full_name: repo }
    });
    assert.equal(nested.json.matched, 0);
    const tag = await deliver(ctx, "push", { ref: "refs/tags/main", repository: { full_name: repo } });
    assert.equal(tag.json.matched, 0);
    assert.equal((await deliver(ctx, "ping", { zen: "hi" })).json.message, "pong");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: same-repo pull requests queue CI, forks are skipped", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = SECRET;
    ctx.config.webhookInsecure = false;
    const repo = `example/prs-${nanoid(6)}`;
    const serviceId = seedWebhookService(ctx, { repo, branch: "main", pipeline: true });
    const same = await deliver(ctx, "pull_request", prPayload(repo, repo, 3));
    assert.equal(same.statusCode, 200);
    assert.deepEqual(same.json.ci, [{ serviceId, queued: true }]);
    const fork = await deliver(ctx, "pull_request", prPayload(repo, "stranger/prs", 4));
    assert.deepEqual(fork.json.ci, [
      { serviceId, queued: false, reason: "pull requests from forks are not run on this host" }
    ]);
    const runs = ctx.db
      .prepare("SELECT lane, event, deploy_after FROM ci_runs WHERE service_id = ?")
      .all(serviceId) as Array<{ lane: string; event: string; deploy_after: number }>;
    assert.deepEqual(
      runs.map((run) => ({ ...run })),
      [{ lane: "pr:3", event: "pull_request", deploy_after: 0 }]
    );
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("webhook: unsigned mode refuses pull request and branch CI", async () => {
  const ctx = await buildApp();
  try {
    ctx.config.webhookSecret = "";
    ctx.config.webhookInsecure = true;
    const repo = `example/unsigned-${nanoid(6)}`;
    const serviceId = seedWebhookService(ctx, { repo, branch: "main", pipeline: true });
    const pr = await deliver(ctx, "pull_request", prPayload(repo, repo, 5));
    assert.match(String(pr.json.message), /SURVHUB_WEBHOOK_INSECURE/);
    const push = await deliver(ctx, "push", {
      ref: "refs/heads/feature/y",
      after: "e".repeat(40),
      repository: { full_name: repo }
    });
    const ci = push.json.ci as Array<{ queued: boolean; reason?: string }>;
    assert.equal(ci[0].queued, false);
    assert.match(ci[0].reason ?? "", /unsigned/);
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM ci_runs WHERE service_id = ?").get(serviceId) as {
      n: number;
    };
    assert.equal(count.n, 0);
  } finally {
    await gracefulShutdown(ctx);
  }
});
