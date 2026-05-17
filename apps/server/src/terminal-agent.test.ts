import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { nowIso } from "./lib/core.js";
import { gracefulShutdown } from "./services/runtime.js";
import { getTerminalCapabilities } from "./services/terminals.js";
import {
  createAgentProfile,
  createMcpSessionToken,
  listAgentProviders,
  listAgentProfiles,
  upsertAgentSecret,
  validateMcpSessionToken
} from "./services/agents.js";

function insertProcessService(ctx: Awaited<ReturnType<typeof buildApp>>, workingDir: string): string {
  const id = nanoid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO services (
        id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "proj-test",
      "terminal-test",
      "process",
      "node server.js",
      workingDir,
      "",
      "",
      0,
      "stopped",
      1,
      0,
      5,
      "manual",
      now,
      now
    );
  return id;
}

test("terminal capabilities expose host process service context", async () => {
  const ctx = await buildApp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-terminal-cap-"));
  try {
    const serviceId = insertProcessService(ctx, root);
    const capability = await getTerminalCapabilities(ctx, serviceId);
    assert.equal(capability.target, "host");
    assert.equal(capability.interactive, true);
    assert.ok(capability.shell);
    assert.equal(capability.persistentAgentHome, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("agent secrets are masked and MCP tokens are scoped", async () => {
  const ctx = await buildApp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-agent-profile-"));
  try {
    const serviceId = insertProcessService(ctx, root);
    const profile = createAgentProfile(ctx, serviceId, "claude", "default", "managed");
    upsertAgentSecret(ctx, serviceId, profile.id, "ANTHROPIC_API_KEY", "sk-ant-test-secret-value");

    const listed = listAgentProfiles(ctx, serviceId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.hasManagedSecret, true);
    assert.notEqual(listed[0]?.managedSecretPreview, "sk-ant-test-secret-value");
    assert.match(String(listed[0]?.managedSecretPreview), /\*\*/);

    const token = createMcpSessionToken(ctx, serviceId, "term-test", false);
    const valid = validateMcpSessionToken(ctx, token.id, token.token);
    assert.equal(valid?.serviceId, serviceId);
    assert.equal(valid?.allowMutations, false);
    assert.deepEqual(valid?.policy, ["read"]);
    assert.equal(validateMcpSessionToken(ctx, token.id, "wrong-token"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});

test("agent provider registry includes Codex managed auth metadata", async () => {
  const ctx = await buildApp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-codex-agent-profile-"));
  try {
    const providers = listAgentProviders();
    const codex = providers.find((provider) => provider.id === "codex");
    assert.equal(codex?.managedSecretKey, "OPENAI_API_KEY");

    const serviceId = insertProcessService(ctx, root);
    const profile = createAgentProfile(ctx, serviceId, "codex", "default", "managed");
    upsertAgentSecret(ctx, serviceId, profile.id, "OPENAI_API_KEY", "sk-test-openai-secret-value");

    const listed = listAgentProfiles(ctx, serviceId);
    assert.equal(listed[0]?.provider, "codex");
    assert.equal(listed[0]?.hasManagedSecret, true);
    assert.match(String(listed[0]?.managedSecretPreview), /\*\*/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await gracefulShutdown(ctx);
  }
});
