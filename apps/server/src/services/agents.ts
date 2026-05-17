import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { getService, nowIso } from "../lib/core.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security.js";
import {
  agentHomeForProfile,
  agentPathEnv,
  createTerminalSession,
  defaultMcpBaseUrl,
  diagnosticsHeader,
  getTerminalCapabilities,
  platformLabel,
  shellQuote,
  type TerminalTarget
} from "./terminals.js";

export type AgentProviderId = "claude" | "gemini" | "codex";
type AgentAuthMode = "cli" | "managed";

type AgentProvider = {
  id: AgentProviderId;
  name: string;
  executable: string;
  managedSecretKey: string;
  docsUrl: string;
  installCommand: () => string;
  authCommand: (mode: AgentAuthMode) => string;
  runCommand: (mcpUrl: string, token: string) => string;
};

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    managedSecretKey: "ANTHROPIC_API_KEY",
    docsUrl: "https://code.claude.com/docs/en/setup",
    installCommand: () =>
      process.platform === "win32"
        ? [
            "Write-Host 'Installing Claude Code with the official native installer...'",
            "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) stable",
            "claude --version"
          ].join("; ")
        : [
            "echo 'Installing Claude Code with the official native installer...'",
            "curl -fsSL https://claude.ai/install.sh | bash",
            'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
            "claude --version"
          ].join(" && "),
    authCommand: (mode) =>
      mode === "managed" ? "claude auth status || claude auth login --console" : "claude auth login",
    runCommand: (mcpUrl, token) =>
      process.platform === "win32"
        ? [
            `claude mcp add --transport http --scope user serverhoster ${shellQuote(mcpUrl)} --header ${shellQuote(
              `Authorization: Bearer ${token}`
            )}`,
            "claude"
          ].join("; ")
        : [
            `claude mcp add --transport http --scope user serverhoster ${shellQuote(mcpUrl)} --header ${shellQuote(
              `Authorization: Bearer ${token}`
            )} >/dev/null 2>&1 || true`,
            "claude"
          ].join(" && ")
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    executable: "gemini",
    managedSecretKey: "GEMINI_API_KEY",
    docsUrl: "https://google-gemini.github.io/gemini-cli/docs/get-started/",
    installCommand: () =>
      [
        "echo 'Installing Gemini CLI into the isolated npm prefix...'",
        "npm install -g @google/gemini-cli",
        "gemini --version"
      ].join(" && "),
    authCommand: (mode) =>
      mode === "managed"
        ? "gemini"
        : "echo 'Gemini CLI opens interactively. Run /auth if the auth picker is not shown automatically.' && gemini",
    runCommand: () => "gemini"
  },
  {
    id: "codex",
    name: "Codex",
    executable: "codex",
    managedSecretKey: "OPENAI_API_KEY",
    docsUrl: "https://developers.openai.com/codex/",
    installCommand: () =>
      process.platform === "win32"
        ? [
            "if (Get-Command codex -ErrorAction SilentlyContinue) {",
            "  Write-Host 'Codex CLI already installed.';",
            "  codex --version;",
            "  codex update;",
            "  codex --version;",
            "} else {",
            "  Write-Host 'Installing Codex CLI into the isolated npm prefix...';",
            "  npm install -g @openai/codex;",
            "  codex --version;",
            "}"
          ].join(" ")
        : [
            "if command -v codex >/dev/null 2>&1; then",
            "  echo 'Codex CLI already installed.';",
            "  codex --version;",
            "  codex update || true;",
            "  codex --version;",
            "else",
            "  echo 'Installing Codex CLI into the isolated npm prefix...';",
            "  npm install -g @openai/codex;",
            "  codex --version;",
            "fi"
          ].join(" "),
    authCommand: (mode) =>
      process.platform === "win32"
        ? mode === "managed"
          ? [
              "if (-not $env:OPENAI_API_KEY) { throw 'OPENAI_API_KEY managed secret is not configured.' }",
              "$env:OPENAI_API_KEY | codex login --with-api-key",
              "codex login status"
            ].join("; ")
          : "codex login status; if ($LASTEXITCODE -ne 0) { codex login --device-auth }"
        : mode === "managed"
          ? [
              "test -n \"$OPENAI_API_KEY\" || (echo 'OPENAI_API_KEY managed secret is not configured.' && exit 1)",
              "printf '%s' \"$OPENAI_API_KEY\" | codex login --with-api-key",
              "codex login status"
            ].join(" && ")
          : "codex login status || codex login --device-auth",
    runCommand: (mcpUrl) =>
      process.platform === "win32"
        ? [
            `codex mcp add serverhoster --url ${shellQuote(mcpUrl)} --bearer-token-env-var SERVERHOSTER_MCP_TOKEN`,
            "codex --cd . --sandbox workspace-write --ask-for-approval on-request --no-alt-screen"
          ].join("; ")
        : [
            `codex mcp add serverhoster --url ${shellQuote(mcpUrl)} --bearer-token-env-var SERVERHOSTER_MCP_TOKEN >/dev/null 2>&1 || true`,
            "codex --cd . --sandbox workspace-write --ask-for-approval on-request --no-alt-screen"
          ].join(" && ")
  }
];

type AgentProfileRow = {
  id: string;
  service_id: string;
  provider: AgentProviderId;
  name: string;
  install_status: string;
  auth_mode: AgentAuthMode;
  auth_status: string;
  isolated_home: string;
  version?: string | null;
  created_at: string;
  updated_at: string;
};

function providerById(id: string): AgentProvider {
  const provider = AGENT_PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new Error(`Unsupported agent provider: ${id}`);
  return provider;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function profileSummary(ctx: AppContext, row: AgentProfileRow) {
  const secrets = ctx.db
    .prepare("SELECT key, value FROM agent_secrets WHERE profile_id = ? ORDER BY key")
    .all(row.id) as Array<{ key: string; value: string }>;
  const provider = providerById(row.provider);
  const managedSecret = secrets.find((secret) => secret.key === provider.managedSecretKey);
  return {
    id: row.id,
    serviceId: row.service_id,
    provider: row.provider,
    name: row.name,
    providerName: provider.name,
    installStatus: row.install_status,
    authMode: row.auth_mode,
    authStatus: row.auth_status,
    isolatedHome: row.isolated_home,
    version: row.version ?? null,
    managedSecretKey: provider.managedSecretKey,
    hasManagedSecret: Boolean(managedSecret),
    managedSecretPreview: managedSecret
      ? maskSecret(decryptSecret(managedSecret.value, ctx.config.secretKey))
      : null,
    docsUrl: provider.docsUrl,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listAgentProviders() {
  return AGENT_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    executable: provider.executable,
    managedSecretKey: provider.managedSecretKey,
    docsUrl: provider.docsUrl,
    platform: platformLabel()
  }));
}

export function listAgentProfiles(ctx: AppContext, serviceId: string) {
  const rows = ctx.db
    .prepare("SELECT * FROM agent_profiles WHERE service_id = ? ORDER BY provider, name")
    .all(serviceId) as AgentProfileRow[];
  return rows.map((row) => profileSummary(ctx, row));
}

export function createAgentProfile(
  ctx: AppContext,
  serviceId: string,
  providerId: AgentProviderId,
  name = "default",
  authMode: AgentAuthMode = "cli"
) {
  const provider = providerById(providerId);
  getService(ctx, serviceId);
  const id = nanoid();
  const isolatedHome = agentHomeForProfile(ctx, serviceId, provider.id, id);
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO agent_profiles (
        id, service_id, provider, name, auth_mode, auth_status, isolated_home, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      serviceId,
      provider.id,
      name,
      authMode,
      authMode === "managed" ? "managed-secret-required" : "unknown",
      isolatedHome,
      now,
      now
    );
  const row = ctx.db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as AgentProfileRow;
  return profileSummary(ctx, row);
}

function getProfile(ctx: AppContext, serviceId: string, profileId: string): AgentProfileRow {
  const row = ctx.db
    .prepare("SELECT * FROM agent_profiles WHERE id = ? AND service_id = ?")
    .get(profileId, serviceId) as AgentProfileRow | undefined;
  if (!row) throw new Error("Agent profile not found");
  return row;
}

export function updateAgentProfile(
  ctx: AppContext,
  serviceId: string,
  profileId: string,
  fields: { name?: string; authMode?: AgentAuthMode }
) {
  getProfile(ctx, serviceId, profileId);
  if (fields.name !== undefined) {
    ctx.db
      .prepare("UPDATE agent_profiles SET name = ?, updated_at = ? WHERE id = ?")
      .run(fields.name, nowIso(), profileId);
  }
  if (fields.authMode !== undefined) {
    ctx.db
      .prepare("UPDATE agent_profiles SET auth_mode = ?, updated_at = ? WHERE id = ?")
      .run(fields.authMode, nowIso(), profileId);
  }
  const row = ctx.db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(profileId) as AgentProfileRow;
  return profileSummary(ctx, row);
}

export function upsertAgentSecret(
  ctx: AppContext,
  serviceId: string,
  profileId: string,
  key: string,
  value: string
) {
  getProfile(ctx, serviceId, profileId);
  const now = nowIso();
  const encrypted = encryptSecret(value, ctx.config.secretKey);
  ctx.db
    .prepare(
      `INSERT INTO agent_secrets (id, profile_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(nanoid(), profileId, key, encrypted, now, now);
  return { ok: true };
}

function profileSecrets(ctx: AppContext, profileId: string): Record<string, string> {
  const rows = ctx.db
    .prepare("SELECT key, value FROM agent_secrets WHERE profile_id = ?")
    .all(profileId) as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = decryptSecret(row.value, ctx.config.secretKey);
  return out;
}

export function deleteAgentSecret(ctx: AppContext, serviceId: string, profileId: string, key: string) {
  getProfile(ctx, serviceId, profileId);
  ctx.db.prepare("DELETE FROM agent_secrets WHERE profile_id = ? AND key = ?").run(profileId, key);
  return { ok: true };
}

function sessionHome(
  ctx: AppContext,
  serviceId: string,
  provider: string,
  profileId: string,
  target: TerminalTarget
) {
  if (target === "host") {
    const hostHome = agentHomeForProfile(ctx, serviceId, provider, profileId);
    return { hostHome, runtimeHome: hostHome };
  }
  const hostHome = path.join(
    ctx.config.agentHomeDir,
    "services",
    serviceId,
    "docker-home",
    provider,
    profileId
  );
  const runtimeHome = `/home/survhub-agent/${provider}/${profileId}`;
  fs.mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  return { hostHome, runtimeHome };
}

function dockerAgentEnv(runtimeHome: string, extra: Record<string, string>): Record<string, string> {
  return {
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    XDG_CONFIG_HOME: `${runtimeHome}/.config`,
    XDG_CACHE_HOME: `${runtimeHome}/.cache`,
    NPM_CONFIG_PREFIX: `${runtimeHome}/.npm-global`,
    PATH: `${runtimeHome}/.local/bin:${runtimeHome}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...extra
  };
}

function ensureDockerAgentReady(capability: Awaited<ReturnType<typeof getTerminalCapabilities>>): void {
  if (capability.target !== "docker") return;
  if (!capability.agentReady) {
    throw new Error(
      `Docker service is not agent-ready. Missing: ${capability.missing.join(", ") || "unknown"}. ${capability.remediation.join(" ")}`
    );
  }
}

export function createMcpSessionToken(
  ctx: AppContext,
  serviceId: string,
  terminalSessionId: string | null,
  allowMutations: boolean
) {
  const id = nanoid(12);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 8;
  const now = nowIso();
  const policy = allowMutations
    ? ["read", "service:start", "service:stop", "service:restart", "log:marker"]
    : ["read"];
  ctx.db
    .prepare(
      `INSERT INTO mcp_session_tokens (
        id, service_id, terminal_session_id, token_hash, allow_mutations, tool_policy, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      serviceId,
      terminalSessionId,
      tokenHash(token),
      allowMutations ? 1 : 0,
      JSON.stringify(policy),
      expiresAt,
      now
    );
  return { id, token, expiresAt, policy };
}

export function validateMcpSessionToken(ctx: AppContext, id: string, token: string) {
  const row = ctx.db.prepare("SELECT * FROM mcp_session_tokens WHERE id = ?").get(id) as
    | {
        id: string;
        service_id: string;
        terminal_session_id?: string | null;
        token_hash: string;
        allow_mutations: number;
        tool_policy: string;
        expires_at: number;
        revoked_at?: string | null;
      }
    | undefined;
  if (!row || row.revoked_at) return null;
  if (row.expires_at < Date.now()) return null;
  if (row.token_hash !== tokenHash(token)) return null;
  let policy: string[] = ["read"];
  try {
    const parsed = JSON.parse(row.tool_policy);
    if (Array.isArray(parsed)) policy = parsed.map(String);
  } catch {
    /* keep read-only */
  }
  return {
    id: row.id,
    serviceId: row.service_id,
    terminalSessionId: row.terminal_session_id ?? null,
    allowMutations: Boolean(row.allow_mutations),
    policy
  };
}

function writeGeminiMcpConfig(hostHome: string, mcpUrl: string, token: string): void {
  const geminiDir = path.join(hostHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(geminiDir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  const mcpServers = {
    ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}),
    serverhoster: {
      httpUrl: mcpUrl,
      headers: { Authorization: `Bearer ${token}` }
    }
  };
  fs.writeFileSync(settingsPath, JSON.stringify({ ...current, mcpServers }, null, 2), { mode: 0o600 });
}

async function createAgentSession(
  ctx: AppContext,
  serviceId: string,
  profileId: string,
  kind: "agent-install" | "agent-auth" | "agent-run",
  allowMutations = false
) {
  const service = getService(ctx, serviceId);
  const profile = getProfile(ctx, serviceId, profileId);
  const provider = providerById(profile.provider);
  const target: TerminalTarget = service.type === "docker" ? "docker" : "host";
  const capability = await getTerminalCapabilities(ctx, serviceId);
  ensureDockerAgentReady(capability);
  const { hostHome, runtimeHome } = sessionHome(ctx, serviceId, provider.id, profileId, target);
  const secrets = profileSecrets(ctx, profileId);
  const env =
    target === "docker"
      ? dockerAgentEnv(runtimeHome, profile.auth_mode === "managed" ? secrets : {})
      : agentPathEnv(runtimeHome, profile.auth_mode === "managed" ? secrets : {});

  let command = "";
  let title = provider.name;
  if (kind === "agent-install") {
    command = `${diagnosticsHeader(`ServerHoster ${provider.name} install`, [
      "This runs inside the service context with an isolated agent home.",
      `Agent home: ${runtimeHome}`
    ])}${provider.installCommand()}`;
    title = `${provider.name} Install`;
    ctx.db
      .prepare("UPDATE agent_profiles SET install_status = ?, updated_at = ? WHERE id = ?")
      .run("installing", nowIso(), profileId);
  } else if (kind === "agent-auth") {
    command = `${diagnosticsHeader(`ServerHoster ${provider.name} authentication`, [
      "Credentials are stored in this profile's isolated home unless managed secrets are enabled.",
      profile.auth_mode === "managed" ? `Managed secret env: ${provider.managedSecretKey}` : "CLI auth mode"
    ])}${provider.authCommand(profile.auth_mode)}`;
    title = `${provider.name} Auth`;
    ctx.db
      .prepare("UPDATE agent_profiles SET auth_status = ?, updated_at = ? WHERE id = ?")
      .run("authenticating", nowIso(), profileId);
  } else {
    const token = createMcpSessionToken(ctx, serviceId, null, allowMutations);
    const mcpUrl = `${defaultMcpBaseUrl(ctx, target)}/mcp/${token.id}`;
    if (provider.id === "gemini") writeGeminiMcpConfig(hostHome, mcpUrl, token.token);
    if (provider.id === "codex") env.SERVERHOSTER_MCP_TOKEN = token.token;
    command = `${diagnosticsHeader(`ServerHoster ${provider.name} agent`, [
      `MCP: ${mcpUrl}`,
      `Service actions: ${allowMutations ? "enabled for this run" : "read-only"}`
    ])}${provider.runCommand(mcpUrl, token.token)}`;
    title = `${provider.name} Agent`;
  }

  return createTerminalSession(ctx, {
    serviceId,
    kind,
    target,
    title,
    provider: provider.id,
    profileId,
    command,
    env,
    allowMutations
  });
}

export async function createAgentInstallSession(ctx: AppContext, serviceId: string, profileId: string) {
  return createAgentSession(ctx, serviceId, profileId, "agent-install", false);
}

export async function createAgentAuthSession(ctx: AppContext, serviceId: string, profileId: string) {
  return createAgentSession(ctx, serviceId, profileId, "agent-auth", false);
}

export async function createAgentRunSession(
  ctx: AppContext,
  serviceId: string,
  profileId: string,
  allowMutations: boolean
) {
  return createAgentSession(ctx, serviceId, profileId, "agent-run", allowMutations);
}
