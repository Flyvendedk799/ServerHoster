import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { spawn as spawnPty } from "node-pty";
import type { WebSocket } from "ws";
import type { AppContext } from "../types.js";
import { getService, nowIso, serializeError } from "../lib/core.js";
import { getServiceEnvWithLinks } from "./runtime.js";

const exec = promisify(execFile);

export type TerminalTarget = "host" | "docker";
export type TerminalKind = "shell" | "agent-install" | "agent-auth" | "agent-run";

export type TerminalCreateOptions = {
  serviceId: string;
  kind?: TerminalKind;
  target?: TerminalTarget;
  title?: string;
  provider?: string;
  profileId?: string;
  command?: string;
  env?: Record<string, string>;
  cwd?: string;
  rows?: number;
  cols?: number;
  allowMutations?: boolean;
};

type ShellSpec = {
  command: string;
  args: string[];
  label: string;
};

type CapabilityCheck = {
  ok: boolean;
  missing: string[];
};

function terminalEnabled(ctx: AppContext): void {
  if (!ctx.config.terminalsEnabled)
    throw new Error("Per-service terminals are disabled by SURVHUB_TERMINALS_ENABLED=0");
}

function hostShellForInteractive(): ShellSpec {
  if (process.platform === "win32") {
    const powershell = process.env.ComSpec?.toLowerCase().includes("powershell")
      ? process.env.ComSpec
      : "powershell.exe";
    return { command: powershell, args: ["-NoLogo"], label: "powershell" };
  }
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean) as string[];
  const shell = candidates.find((candidate) => fs.existsSync(candidate)) ?? "/bin/sh";
  return { command: shell, args: [], label: path.basename(shell) };
}

function hostShellForCommand(command: string): ShellSpec {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      label: "powershell"
    };
  }
  const shell = hostShellForInteractive();
  return { command: shell.command, args: ["-lc", command], label: shell.label };
}

function dockerShellForCommand(shell: string, command?: string): ShellSpec {
  if (command) return { command: shell, args: ["-lc", command], label: shell };
  return { command: shell, args: [], label: shell };
}

function normalizeRowsCols(rows?: number, cols?: number): { rows: number; cols: number } {
  return {
    rows: Number.isFinite(rows) ? Math.max(8, Math.min(80, Number(rows))) : 24,
    cols: Number.isFinite(cols) ? Math.max(40, Math.min(240, Number(cols))) : 100
  };
}

function serviceCwd(service: Record<string, unknown>, override?: string): string {
  const cwd = String(override || service.working_dir || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  return cwd;
}

function prepareHostEnv(
  ctx: AppContext,
  serviceId: string,
  extra?: Record<string, string>
): NodeJS.ProcessEnv {
  const serviceEnv = getServiceEnvWithLinks(ctx, serviceId);
  return {
    ...process.env,
    TERM: process.env.TERM ?? "xterm-256color",
    ...serviceEnv,
    ...(extra ?? {})
  };
}

function dockerEnvArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

function broadcastTerminal(ctx: AppContext, sessionId: string, event: Record<string, unknown>): void {
  const subscribers = ctx.terminalSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0) return;
  const payload = JSON.stringify({ ...event, sessionId });
  for (const client of subscribers) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function resetIdleTimer(ctx: AppContext, sessionId: string): void {
  const runtime = ctx.terminalSessions.get(sessionId);
  if (!runtime) return;
  runtime.lastActivityAt = Date.now();
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  runtime.idleTimer = setTimeout(() => {
    const current = ctx.terminalSessions.get(sessionId);
    if (!current) return;
    if (Date.now() - current.lastActivityAt < ctx.config.terminalIdleTimeoutMs) {
      resetIdleTimer(ctx, sessionId);
      return;
    }
    killTerminalSession(ctx, sessionId, "idle timeout");
  }, ctx.config.terminalIdleTimeoutMs);
}

function rowToSummary(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    kind: String(row.kind),
    shellKind: String(row.shell_kind),
    target: String(row.target),
    status: String(row.status),
    title: row.title ? String(row.title) : "",
    provider: row.provider ? String(row.provider) : null,
    profileId: row.profile_id ? String(row.profile_id) : null,
    allowMutations: Boolean(row.allow_mutations),
    rows: Number(row.rows ?? 24),
    cols: Number(row.cols ?? 100),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    exitSignal: row.exit_signal ? String(row.exit_signal) : null,
    attached: false
  };
}

export function listTerminalSessions(ctx: AppContext, serviceId: string) {
  const rows = ctx.db
    .prepare("SELECT * FROM terminal_sessions WHERE service_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(serviceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...rowToSummary(row), attached: ctx.terminalSessions.has(String(row.id)) }));
}

async function commandExistsOnHost(command: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await exec("where.exe", [command], { timeout: 1500, maxBuffer: 1024 * 32 });
    } else {
      await exec("sh", ["-lc", `command -v ${command}`], { timeout: 1500, maxBuffer: 1024 * 32 });
    }
    return true;
  } catch {
    return false;
  }
}

async function checkHostCommands(commands: string[]): Promise<CapabilityCheck> {
  const missing: string[] = [];
  for (const command of commands) {
    if (!(await commandExistsOnHost(command))) missing.push(command);
  }
  return { ok: missing.length === 0, missing };
}

async function inspectDockerContainer(ctx: AppContext, serviceId: string): Promise<any | null> {
  try {
    return await ctx.docker.getContainer(`survhub-${serviceId}`).inspect();
  } catch {
    return null;
  }
}

async function tryDockerShell(containerName: string, shell: string): Promise<boolean> {
  try {
    const { stdout } = await exec("docker", ["exec", containerName, shell, "-lc", `printf ${shell}`], {
      timeout: 2500,
      maxBuffer: 1024 * 32
    });
    return stdout.trim() === shell;
  } catch {
    return false;
  }
}

export async function detectDockerShell(serviceId: string): Promise<string | null> {
  const containerName = `survhub-${serviceId}`;
  for (const shell of ["bash", "sh", "ash"]) {
    if (await tryDockerShell(containerName, shell)) return shell;
  }
  return null;
}

async function checkDockerCommands(
  serviceId: string,
  shell: string,
  commands: string[]
): Promise<CapabilityCheck> {
  const missing: string[] = [];
  const script = commands
    .map((command) => `command -v ${command} >/dev/null 2>&1 || echo ${command}`)
    .join("; ");
  try {
    const { stdout } = await exec("docker", ["exec", `survhub-${serviceId}`, shell, "-lc", script], {
      timeout: 3500,
      maxBuffer: 1024 * 64
    });
    for (const line of stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (commands.includes(line)) missing.push(line);
    }
  } catch {
    return { ok: false, missing: commands };
  }
  return { ok: missing.length === 0, missing };
}

function hasAgentHomeMount(info: any): boolean {
  const mounts = Array.isArray(info?.Mounts) ? info.Mounts : [];
  return mounts.some((mount: any) => mount?.Destination === "/home/survhub-agent");
}

export async function getTerminalCapabilities(ctx: AppContext, serviceId: string) {
  const service = getService(ctx, serviceId);
  const target: TerminalTarget = service.type === "docker" ? "docker" : "host";
  if (target === "host") {
    const shell = hostShellForInteractive();
    const commands = await checkHostCommands(["node", "npm", "git"]);
    return {
      enabled: ctx.config.terminalsEnabled,
      serviceId,
      serviceType: service.type,
      target,
      capability: commands.ok ? "agent-ready" : "interactive",
      interactive: true,
      agentReady: commands.ok,
      shell: shell.label,
      missing: commands.missing,
      persistentAgentHome: true,
      remediation: commands.ok ? [] : [`Install missing host tools: ${commands.missing.join(", ")}`]
    };
  }

  const info = await inspectDockerContainer(ctx, serviceId);
  if (!info?.State?.Running) {
    return {
      enabled: ctx.config.terminalsEnabled,
      serviceId,
      serviceType: service.type,
      target,
      capability: "unsupported",
      interactive: false,
      agentReady: false,
      shell: null,
      missing: ["running-container"],
      persistentAgentHome: false,
      remediation: ["Start the Docker service before opening a container console."]
    };
  }
  const shell = await detectDockerShell(serviceId);
  if (!shell) {
    return {
      enabled: ctx.config.terminalsEnabled,
      serviceId,
      serviceType: service.type,
      target,
      capability: "unsupported",
      interactive: false,
      agentReady: false,
      shell: null,
      missing: ["shell"],
      persistentAgentHome: hasAgentHomeMount(info),
      remediation: ["Rebuild the image with sh, bash, or ash for interactive service consoles."]
    };
  }
  const commands = await checkDockerCommands(serviceId, shell, ["node", "npm", "git"]);
  const persistentAgentHome = hasAgentHomeMount(info);
  const agentReady = commands.ok && persistentAgentHome;
  return {
    enabled: ctx.config.terminalsEnabled,
    serviceId,
    serviceType: service.type,
    target,
    capability: agentReady ? "agent-ready" : commands.ok ? "read-only-debug" : "interactive",
    interactive: true,
    agentReady,
    shell,
    missing: [...commands.missing, ...(persistentAgentHome ? [] : ["persistent-agent-home"])],
    persistentAgentHome,
    remediation: [
      ...(commands.ok ? [] : [`Install missing container tools: ${commands.missing.join(", ")}`]),
      ...(persistentAgentHome
        ? []
        : ["Restart/recreate the service so ServerHoster can mount a persistent agent home."])
    ]
  };
}

export async function createTerminalSession(ctx: AppContext, options: TerminalCreateOptions) {
  terminalEnabled(ctx);
  if (ctx.terminalSessions.size >= ctx.config.terminalMaxSessions) {
    throw new Error(`Terminal session limit reached (${ctx.config.terminalMaxSessions})`);
  }

  const service = getService(ctx, options.serviceId);
  const target = options.target ?? (service.type === "docker" ? "docker" : "host");
  if (target === "docker" && service.type !== "docker")
    throw new Error("Docker terminal target requires a Docker service");

  const { rows, cols } = normalizeRowsCols(options.rows, options.cols);
  const id = nanoid();
  const kind = options.kind ?? "shell";
  const now = nowIso();
  let shell: ShellSpec;
  let cwd = process.cwd();
  let ptyCommand = "";
  let ptyArgs: string[] = [];
  let env: NodeJS.ProcessEnv = process.env;

  if (target === "host") {
    cwd = serviceCwd(service, options.cwd);
    shell = options.command ? hostShellForCommand(options.command) : hostShellForInteractive();
    ptyCommand = shell.command;
    ptyArgs = shell.args;
    env = prepareHostEnv(ctx, options.serviceId, options.env);
  } else {
    const info = await inspectDockerContainer(ctx, options.serviceId);
    if (!info?.State?.Running) throw new Error("Docker service container is not running");
    const detected = await detectDockerShell(options.serviceId);
    if (!detected) throw new Error("Docker container has no supported shell (bash, sh, ash)");
    shell = dockerShellForCommand(detected, options.command);
    ptyCommand = "docker";
    ptyArgs = [
      "exec",
      "-it",
      ...dockerEnvArgs(options.env),
      `survhub-${options.serviceId}`,
      shell.command,
      ...shell.args
    ];
  }

  ctx.db
    .prepare(
      `INSERT INTO terminal_sessions (
        id, service_id, kind, shell_kind, target, status, title, provider, profile_id,
        allow_mutations, rows, cols, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      options.serviceId,
      kind,
      shell.label,
      target,
      "running",
      options.title ?? "",
      options.provider ?? null,
      options.profileId ?? null,
      options.allowMutations ? 1 : 0,
      rows,
      cols,
      now,
      now
    );

  const pty = spawnPty(ptyCommand, ptyArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env
  });
  ctx.terminalSessions.set(id, {
    id,
    serviceId: options.serviceId,
    pty,
    startedAt: Date.now(),
    lastActivityAt: Date.now()
  });
  resetIdleTimer(ctx, id);

  pty.onData((data) => {
    resetIdleTimer(ctx, id);
    broadcastTerminal(ctx, id, { type: "terminal_output", data });
  });
  pty.onExit((event) => {
    const ended = nowIso();
    const runtime = ctx.terminalSessions.get(id);
    if (runtime?.idleTimer) clearTimeout(runtime.idleTimer);
    ctx.terminalSessions.delete(id);
    ctx.db
      .prepare(
        "UPDATE terminal_sessions SET status = ?, updated_at = ?, ended_at = ?, exit_code = ?, exit_signal = ? WHERE id = ?"
      )
      .run("ended", ended, ended, event.exitCode ?? null, event.signal ?? null, id);
    broadcastTerminal(ctx, id, {
      type: "terminal_exit",
      exitCode: event.exitCode ?? null,
      signal: event.signal ?? null
    });
  });

  const row = ctx.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
  return { ...rowToSummary(row), attached: true };
}

export function writeTerminalInput(ctx: AppContext, sessionId: string, data: string): void {
  const runtime = ctx.terminalSessions.get(sessionId);
  if (!runtime) throw new Error("Terminal session is not running");
  runtime.pty.write(data);
  resetIdleTimer(ctx, sessionId);
}

export function resizeTerminal(ctx: AppContext, sessionId: string, rows: number, cols: number): void {
  const runtime = ctx.terminalSessions.get(sessionId);
  if (!runtime) throw new Error("Terminal session is not running");
  const normalized = normalizeRowsCols(rows, cols);
  runtime.pty.resize(normalized.cols, normalized.rows);
  ctx.db
    .prepare("UPDATE terminal_sessions SET rows = ?, cols = ?, updated_at = ? WHERE id = ?")
    .run(normalized.rows, normalized.cols, nowIso(), sessionId);
  resetIdleTimer(ctx, sessionId);
}

export function killTerminalSession(ctx: AppContext, sessionId: string, reason = "killed"): void {
  const runtime = ctx.terminalSessions.get(sessionId);
  if (runtime?.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime) {
    try {
      runtime.pty.kill();
    } catch {
      /* already exited */
    }
  }
  ctx.terminalSessions.delete(sessionId);
  const ended = nowIso();
  ctx.db
    .prepare("UPDATE terminal_sessions SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?")
    .run(reason === "idle timeout" ? "idle_timeout" : "ended", ended, ended, sessionId);
  broadcastTerminal(ctx, sessionId, { type: "terminal_exit", reason });
}

export function attachTerminal(ctx: AppContext, sessionId: string, ws: WebSocket): void {
  const row = ctx.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    ws.send(JSON.stringify({ type: "terminal_error", sessionId, error: "Terminal session not found" }));
    return;
  }
  const subscribers = ctx.terminalSubscribers.get(sessionId) ?? new Set<WebSocket>();
  subscribers.add(ws);
  ctx.terminalSubscribers.set(sessionId, subscribers);
  ws.send(JSON.stringify({ type: "terminal_status", sessionId, session: rowToSummary(row) }));
}

export function detachTerminal(ctx: AppContext, sessionId: string, ws: WebSocket): void {
  const subscribers = ctx.terminalSubscribers.get(sessionId);
  if (!subscribers) return;
  subscribers.delete(ws);
  if (subscribers.size === 0) ctx.terminalSubscribers.delete(sessionId);
}

export function handleTerminalWebSocketMessage(
  ctx: AppContext,
  ws: WebSocket,
  msg: Record<string, unknown>,
  attachedTerminalIds: Set<string>
): boolean {
  const type = typeof msg.type === "string" ? msg.type : "";
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
  if (!type.startsWith("terminal_")) return false;
  if (!sessionId && type !== "terminal_attach") return true;
  try {
    if (type === "terminal_attach") {
      if (!sessionId) throw new Error("sessionId is required");
      attachedTerminalIds.add(sessionId);
      attachTerminal(ctx, sessionId, ws);
    } else if (type === "terminal_detach") {
      attachedTerminalIds.delete(sessionId);
      detachTerminal(ctx, sessionId, ws);
    } else if (type === "terminal_input") {
      if (typeof msg.data !== "string") throw new Error("data is required");
      writeTerminalInput(ctx, sessionId, msg.data);
    } else if (type === "terminal_resize") {
      resizeTerminal(ctx, sessionId, Number(msg.rows), Number(msg.cols));
    } else if (type === "terminal_kill") {
      killTerminalSession(ctx, sessionId);
    }
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "terminal_error",
        sessionId,
        error: serializeError(error)
      })
    );
  }
  return true;
}

export function cleanupTerminalSocket(
  ctx: AppContext,
  ws: WebSocket,
  attachedTerminalIds: Set<string>
): void {
  for (const sessionId of attachedTerminalIds) detachTerminal(ctx, sessionId, ws);
  attachedTerminalIds.clear();
}

export function stopAllTerminalSessions(ctx: AppContext): void {
  for (const sessionId of [...ctx.terminalSessions.keys()]) {
    killTerminalSession(ctx, sessionId, "server shutdown");
  }
  ctx.terminalSubscribers.clear();
}

export function agentHomeForProfile(
  ctx: AppContext,
  serviceId: string,
  provider: string,
  profileId: string
): string {
  const safeProvider = provider.replace(/[^a-z0-9_-]/gi, "_");
  const home = path.join(ctx.config.agentHomeDir, "services", serviceId, safeProvider, profileId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function agentPathEnv(home: string, baseEnv: Record<string, string> = {}): Record<string, string> {
  const pathValue = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    process.env.PATH ?? ""
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    NPM_CONFIG_PREFIX: path.join(home, ".npm-global"),
    PATH: pathValue,
    ...baseEnv
  };
}

export function platformLabel(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function defaultMcpBaseUrl(ctx: AppContext, target: TerminalTarget): string {
  if (ctx.config.mcpBaseUrl) return ctx.config.mcpBaseUrl.replace(/\/$/, "");
  const host = target === "docker" ? "host.docker.internal" : "127.0.0.1";
  return `http://${host}:${ctx.config.apiPort}`;
}

export function diagnosticsHeader(title: string, lines: string[] = []): string {
  const prefix = os.EOL;
  return [`${prefix}# ${title}`, ...lines.map((line) => `# ${line}`), ""].join(os.EOL);
}
