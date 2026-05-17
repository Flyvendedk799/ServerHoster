import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { nanoid } from "nanoid";
import {
  broadcast,
  detectBuildType,
  getServiceEnv,
  findStaticEntry,
  insertLog,
  nowIso,
  runCommand,
  serializeError,
  updateServiceStatus
} from "../lib/core.js";
import type { AppContext } from "../types.js";
import { startService, stopService } from "./runtime.js";
import { buildGitEnv, injectGitCredentials } from "./settings.js";
import { createNotification } from "./notifications.js";
import { transition, markFailed } from "./deployStateMachine.js";
import { recordDeployDuration, recordDeployFailure } from "./metrics.js";

export type DeployPhase = "queued" | "cloning" | "installing" | "building" | "starting" | "done" | "failed";
export type DeployTrigger = "manual" | "webhook" | "gitops-poller" | "rollback";

type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";
type NodeLaunchKind = "electron" | "web" | "node";
type NodeLaunchTarget = {
  kind: NodeLaunchKind;
  workingDir: string;
  command: string;
  buildCommand?: string;
  skipBuild?: boolean;
  reason: string;
};

function detectNodePackageManager(projectPath: string): NodePackageManager {
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectPath, "bun.lockb")) || fs.existsSync(path.join(projectPath, "bun.lock")))
    return "bun";
  return "npm";
}

function nodeInstallCommand(pm: NodePackageManager): string {
  if (pm === "pnpm") return "pnpm install --frozen-lockfile=false";
  if (pm === "yarn") return "yarn install";
  if (pm === "bun") return "bun install";
  return "npm install";
}

function nodeBuildCommand(pm: NodePackageManager): string {
  if (pm === "pnpm") return "pnpm run --if-present build";
  if (pm === "yarn") return "yarn run build";
  if (pm === "bun") return "bun run build";
  return "npm run build --if-present";
}

function packageRunCommand(pm: NodePackageManager, script: string): string {
  if (pm === "pnpm") return `pnpm run ${script}`;
  if (pm === "yarn") return `yarn run ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function packageDevCommand(pm: NodePackageManager, kind: NodeLaunchKind): string {
  const base = packageRunCommand(pm, "dev");
  return kind === "web" ? `${base} -- --host 0.0.0.0 --port $PORT` : base;
}

function staticServeCommand(): string {
  const candidates = [
    path.resolve(process.cwd(), "apps/server/dist/static-server.js"),
    path.resolve(process.cwd(), "dist/static-server.js")
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  return entry ? `node ${JSON.stringify(entry)}` : "python3 -m http.server $PORT --bind 0.0.0.0";
}

function hasCommand(command: string): boolean {
  return (
    process.env.PATH?.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, command))) ?? false
  );
}

function godotCommand(): string {
  if (hasCommand("godot")) return "godot";
  if (hasCommand("godot4")) return "godot4";
  return "godot";
}

function godotTemplatesDir(templateVersion: string): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Godot",
      "export_templates",
      templateVersion
    );
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "Godot", "export_templates", templateVersion);
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "godot",
    "export_templates",
    templateVersion
  );
}

async function ensureGodotWebExportTemplates(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  stream: (chunk: string, s: "stdout" | "stderr") => void
): Promise<string> {
  const cmd = godotCommand();
  const versionResult = await runCommand(`${cmd} --version`, projectPath, env, { timeoutMs: 30000 });
  if (versionResult.code !== 0) throw new Error(`Godot is not available: ${versionResult.output}`);
  const versionLine = versionResult.output.split(/\r?\n/).find(Boolean) ?? "";
  const match = versionLine.match(/(\d+\.\d+\.\d+)\.(stable|beta|rc|dev)/);
  if (!match) throw new Error(`Could not parse Godot version from: ${versionLine}`);

  const [, version, channel] = match;
  const templateVersion = `${version}.${channel}`;
  const dest = godotTemplatesDir(templateVersion);
  if (fs.existsSync(path.join(dest, "web_release.zip")) && fs.existsSync(path.join(dest, "web_debug.zip"))) {
    return cmd;
  }

  const tag = `${version}-${channel}`;
  const fileName = `Godot_v${version}-${channel}_export_templates.tpz`;
  const url = `https://github.com/godotengine/godot/releases/download/${tag}/${fileName}`;
  const tmpDir = path.join(os.tmpdir(), `survhub-godot-templates-${templateVersion}`);
  const archivePath = path.join(tmpDir, fileName);
  const installCommand = [
    `rm -rf ${JSON.stringify(tmpDir)}`,
    `mkdir -p ${JSON.stringify(tmpDir)} ${JSON.stringify(dest)}`,
    `curl -L --fail -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`,
    `unzip -q -o ${JSON.stringify(archivePath)} -d ${JSON.stringify(tmpDir)}`,
    `cp -R ${JSON.stringify(path.join(tmpDir, "templates"))}/. ${JSON.stringify(dest)}/`
  ].join(" && ");
  stream(`Godot Web export templates missing; installing ${templateVersion} from ${url}\n`, "stdout");
  const install = await runCommand(installCommand, projectPath, env, {
    timeoutMs: 240000,
    onChunk: stream
  });
  if (install.code !== 0) {
    throw new Error(`Failed to install Godot export templates: ${install.output}`);
  }
  return cmd;
}

function parseGodotWebExportPath(projectPath: string): string {
  const presetsPath = path.join(projectPath, "export_presets.cfg");
  if (!fs.existsSync(presetsPath)) return path.join(projectPath, "build", "web", "index.html");
  const raw = fs.readFileSync(presetsPath, "utf8");
  const sections = raw.split(/\n(?=\[preset\.\d+\])/);
  for (const section of sections) {
    if (!/\bplatform="Web"/.test(section)) continue;
    const match = section.match(/\bexport_path="([^"]+)"/);
    if (match?.[1]) return path.resolve(projectPath, match[1]);
  }
  return path.join(projectPath, "build", "web", "index.html");
}

function readPackageJson(packagePath: string): {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findPackageDirs(rootPath: string): string[] {
  const out: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "out", "release", ".turbo"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    if (fs.existsSync(path.join(dir, "package.json"))) out.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(rootPath, 0);
  return out;
}

export function detectNodeLaunchTarget(
  projectPath: string,
  serviceName = "",
  packageManager: NodePackageManager = detectNodePackageManager(projectPath)
): NodeLaunchTarget {
  const normalizedServiceName = normalizeName(serviceName);
  const packageDirs = findPackageDirs(projectPath);
  let best: {
    score: number;
    target: NodeLaunchTarget;
  } | null = null;

  for (const dir of packageDirs) {
    const pkg = readPackageJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const rel = path.relative(projectPath, dir) || ".";
    const nameText = normalizeName(`${pkg.name ?? ""} ${rel}`);
    const nameBonus = normalizedServiceName && nameText.includes(normalizedServiceName) ? 20 : 0;
    const hasDev = Boolean(scripts.dev);
    const hasStart = Boolean(scripts.start);
    const hasBuild = Boolean(scripts.build);
    const scriptText = Object.values(scripts).join(" ");

    let score = 0;
    let kind: NodeLaunchKind = "node";
    let command = hasDev
      ? packageRunCommand(packageManager, "dev")
      : packageRunCommand(packageManager, "start");
    let buildCommand = hasBuild ? packageRunCommand(packageManager, "build") : undefined;
    let skipBuild = false;
    let reason = rel === "." ? "root package" : `workspace package ${rel}`;

    if (deps.electron || deps["electron-vite"] || /electron(-vite)?\b/i.test(scriptText)) {
      score = 100;
      kind = "electron";
      command = packageDevCommand(packageManager, "electron");
      buildCommand = undefined;
      skipBuild = true;
      reason = `Electron package ${rel}`;
    } else if (deps.vitepress || /vitepress\b/i.test(scriptText)) {
      score = 80;
      kind = "web";
      command = packageDevCommand(packageManager, "web");
      reason = `VitePress package ${rel}`;
    } else if (deps.vite || deps.next || deps.astro || deps.nuxt || deps["@sveltejs/kit"]) {
      score = 70;
      kind = "web";
      command = packageDevCommand(packageManager, "web");
      reason = `web package ${rel}`;
    } else if (hasStart || hasDev) {
      score = rel === "." ? 30 : 45;
      kind = "node";
      command = hasStart
        ? packageRunCommand(packageManager, "start")
        : packageRunCommand(packageManager, "dev");
    }

    if (score === 0) continue;
    score += nameBonus;
    if (rel.includes("apps/desktop")) score += 5;
    if (rel.includes("website") && kind === "web") score += 3;

    const target = { kind, workingDir: dir, command, buildCommand, skipBuild, reason };
    if (!best || score > best.score) best = { score, target };
  }

  return (
    best?.target ?? {
      kind: "node",
      workingDir: projectPath,
      command: nodeStartCommand(packageManager),
      buildCommand: nodeBuildCommand(packageManager),
      reason: "root package fallback"
    }
  );
}

function emitBuildLog(
  ctx: AppContext,
  serviceId: string,
  deploymentId: string,
  line: string,
  stream: "stdout" | "stderr" = "stdout"
): void {
  if (!line) return;
  broadcast(ctx, {
    type: "build_log",
    serviceId,
    deploymentId,
    line,
    stream,
    timestamp: nowIso()
  });
}

function emitProgress(ctx: AppContext, serviceId: string, deploymentId: string, phase: DeployPhase): void {
  broadcast(ctx, {
    type: "build_progress",
    serviceId,
    deploymentId,
    phase,
    timestamp: nowIso()
  });
}

export async function runBuildPipeline(
  ctx: AppContext,
  serviceId: string,
  projectPath: string,
  opts: { deploymentId?: string; onPhase?: (phase: DeployPhase) => void; nodeTarget?: NodeLaunchTarget } = {}
): Promise<{ status: "success" | "failed"; buildLog: string; artifactPath: string }> {
  const deploymentId = opts.deploymentId;
  const env = { ...process.env, ...getServiceEnv(ctx, serviceId) };
  const serviceBuild = ctx.db.prepare("SELECT dockerfile FROM services WHERE id = ?").get(serviceId) as
    | { dockerfile?: string }
    | undefined;
  const dockerfile = String(serviceBuild?.dockerfile ?? "").trim();
  const buildType = detectBuildType(projectPath);
  let buildLog = `Detected build type: ${buildType}\n`;
  let artifactPath = projectPath;

  const stream = (chunk: string, s: "stdout" | "stderr") => {
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, chunk, s);
  };

  if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, buildLog, "stdout");

  if (buildType === "node") {
    const packageManager = detectNodePackageManager(projectPath);
    const nodeTarget = opts.nodeTarget ?? detectNodeLaunchTarget(projectPath, "", packageManager);
    const installCommand = nodeInstallCommand(packageManager);
    const buildCommand = nodeTarget.buildCommand ?? nodeBuildCommand(packageManager);
    const buildCwd = nodeTarget.workingDir || projectPath;
    buildLog += `Detected package manager: ${packageManager}\n`;
    buildLog += `Selected launch target: ${path.relative(projectPath, nodeTarget.workingDir) || "."} (${nodeTarget.reason})\n`;
    if (deploymentId)
      emitBuildLog(ctx, serviceId, deploymentId, `Detected package manager: ${packageManager}\n`);
    if (deploymentId)
      emitBuildLog(
        ctx,
        serviceId,
        deploymentId,
        `Selected launch target: ${path.relative(projectPath, nodeTarget.workingDir) || "."} (${nodeTarget.reason})\n`
      );

    opts.onPhase?.("installing");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "installing");
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${installCommand}\n`, "stdout");
    const install = await runCommand(installCommand, projectPath, env, { onChunk: stream });
    buildLog += `\n$ ${installCommand}\n${install.output}\n`;
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };

    if (nodeTarget.skipBuild) {
      const msg = `\nSkipping package build for ${nodeTarget.reason}; the launch command performs its own development build.\n`;
      buildLog += msg;
      if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stdout");
      return { status: "success", buildLog, artifactPath };
    }

    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${buildCommand}\n`, "stdout");
    const build = await runCommand(buildCommand, buildCwd, env, { onChunk: stream });
    buildLog += `\n$ ${buildCommand}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    if (fs.existsSync(path.join(buildCwd, "dist"))) artifactPath = path.join(buildCwd, "dist");
  } else if (buildType === "python") {
    opts.onPhase?.("installing");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "installing");
    const installCmd = fs.existsSync(path.join(projectPath, "requirements.txt"))
      ? "python -m pip install -r requirements.txt"
      : "python -m pip install .";
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${installCmd}\n`, "stdout");
    const install = await runCommand(installCmd, projectPath, env, { onChunk: stream });
    buildLog += `\n$ ${installCmd}\n${install.output}\n`;
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };
  } else if (buildType === "godot") {
    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    const exportPath = parseGodotWebExportPath(projectPath);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    const godot = await ensureGodotWebExportTemplates(projectPath, env, stream);
    const command = `${godot} --headless --path . --export-release Web ${JSON.stringify(exportPath)}`;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${command}\n`, "stdout");
    const build = await runCommand(command, projectPath, env, {
      timeoutMs: 240000,
      onChunk: stream
    });
    buildLog += `\n$ ${command}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    artifactPath = path.dirname(exportPath);
  } else if (buildType === "static") {
    const staticDir = findStaticEntry(projectPath);
    artifactPath = staticDir ?? projectPath;
    const msg = `Static site detected at ${path.relative(projectPath, artifactPath) || "."}; no build step required.\n`;
    buildLog += msg;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stdout");
  } else if (buildType === "docker") {
    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    const imageSafeServiceId = serviceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    const imageTag = `survhub-build-${imageSafeServiceId}:latest`;
    const dockerfileArg = dockerfile ? ` -f ${JSON.stringify(dockerfile)}` : "";
    const buildCommand = `docker build${dockerfileArg} -t ${imageTag} .`;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${buildCommand}\n`, "stdout");
    const build = await runCommand(buildCommand, projectPath, env, {
      timeoutMs: 240000,
      onChunk: stream
    });
    buildLog += `\n$ ${buildCommand}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    ctx.db
      .prepare("UPDATE services SET docker_image = ?, updated_at = ? WHERE id = ?")
      .run(imageTag, nowIso(), serviceId);
  } else if (buildType === "unknown") {
    const msg =
      "\nNo Dockerfile, package.json, Python markers, Godot project, or static index.html found. Cannot deploy this repository layout.\n";
    buildLog += msg;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
    return { status: "failed", buildLog, artifactPath };
  }

  return { status: "success", buildLog, artifactPath };
}

export async function deployFromGit(
  ctx: AppContext,
  serviceId: string,
  repoUrl: string,
  branch: string = "main",
  trigger: DeployTrigger = "manual"
) {
  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const gitEnv = buildGitEnv(ctx);
  const git = simpleGit().env(gitEnv as Record<string, string>);
  const authedUrl = injectGitCredentials(ctx, repoUrl);
  let buildLog = "";
  let commitHash = "";
  let status: "success" | "failed" = "success";
  let artifactPath = targetPath;

  const deploymentId = nanoid();
  const startedAt = nowIso();

  // Pre-create the deployment row so the UI can observe in-flight state.
  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(deploymentId, serviceId, "", "running", "", targetPath, startedAt, startedAt, branch, trigger);

  emitProgress(ctx, serviceId, deploymentId, "cloning");
  transition(ctx, deploymentId, "cloning");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch, trigger });

  let failureStage: "queued" | "cloning" | "building" | "starting" | "unknown" = "unknown";
  try {
    failureStage = "cloning";
    if (fs.existsSync(path.join(targetPath, ".git"))) {
      // Reset origin URL so an updated PAT or switched remote takes effect.
      try {
        await git.cwd(targetPath).remote(["set-url", "origin", authedUrl]);
      } catch {
        /* first-time */
      }
      await git.cwd(targetPath).fetch();
      await git.cwd(targetPath).checkout(branch);
      await git.cwd(targetPath).pull("origin", branch);
      buildLog += `Fetched and pulled branch: ${branch}.\n`;
      emitBuildLog(ctx, serviceId, deploymentId, `Fetched and pulled branch: ${branch}.\n`);
    } else {
      await git.clone(authedUrl, targetPath, ["--branch", branch]);
      buildLog += `Cloned repository branch: ${branch}.\n`;
      emitBuildLog(ctx, serviceId, deploymentId, `Cloned repository branch: ${branch}.\n`);
    }
    const buildType = detectBuildType(targetPath);
    const preferredDockerfile =
      buildType === "docker" && fs.existsSync(path.join(targetPath, "Dockerfile.frontend"))
        ? "Dockerfile.frontend"
        : "";
    const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
      | { name?: string }
      | undefined;
    const nodeTarget =
      buildType === "node" ? detectNodeLaunchTarget(targetPath, service?.name ?? "") : undefined;
    const inferred = inferServiceRuntimeDefaults(buildType, nodeTarget?.workingDir ?? targetPath);
    ctx.db
      .prepare(
        "UPDATE services SET type = ?, command = ?, working_dir = ?, dockerfile = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        inferred.type,
        nodeTarget?.command ?? inferred.command,
        nodeTarget?.workingDir ?? targetPath,
        preferredDockerfile,
        nowIso(),
        serviceId
      );
    commitHash = (await git.cwd(targetPath).revparse(["HEAD"])).trim();
    failureStage = "building";
    transition(ctx, deploymentId, "building", { gitSha: commitHash });
    const result = await runBuildPipeline(ctx, serviceId, targetPath, { deploymentId, nodeTarget });
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
    if (status === "success") {
      if (buildType === "godot" || buildType === "static") {
        ctx.db
          .prepare(
            "UPDATE services SET type = 'static', command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
          )
          .run(staticServeCommand(), artifactPath, nowIso(), serviceId);
      }
      transition(ctx, deploymentId, "starting", { gitSha: commitHash });
    }
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  if (status === "success") {
    transition(ctx, deploymentId, "healthy", { gitSha: commitHash });
    recordDeployDuration(ctx, serviceId, durationMs);
  } else {
    markFailed(ctx, deploymentId, failureStage);
    recordDeployFailure(ctx, serviceId, failureStage);
  }

  ctx.db
    .prepare(
      `UPDATE deployments
     SET commit_hash = ?, status = ?, build_log = ?, artifact_path = ?, finished_at = ?, duration_ms = ?, git_sha = COALESCE(git_sha, ?)
     WHERE id = ?`
    )
    .run(commitHash, status, buildLog, artifactPath, finishedAt, durationMs, commitHash, deploymentId);

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId,
    status,
    durationMs
  });

  return {
    id: deploymentId,
    service_id: serviceId,
    commit_hash: commitHash,
    status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch,
    trigger_source: trigger
  };
}

/** Sync DB status and optional autostart after deployFromGit (GitHub deploy or redeploy). */
export async function applyPostDeployServiceState(
  ctx: AppContext,
  serviceId: string,
  deployment: { status: string; build_log: string },
  options: { startAfterDeploy: boolean }
): Promise<void> {
  const svcRow = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
    | { name?: string }
    | undefined;
  const serviceName = svcRow?.name ?? serviceId;
  if (deployment.status === "success") {
    createNotification(ctx, {
      kind: "deployment",
      severity: "success",
      title: `Deployment succeeded: ${serviceName}`,
      serviceId
    });
    if (options.startAfterDeploy) {
      try {
        await startService(ctx, serviceId);
      } catch (error) {
        updateServiceStatus(ctx, serviceId, "stopped");
        insertLog(ctx, serviceId, "error", `Start after deploy failed: ${serializeError(error)}`);
      }
    } else {
      updateServiceStatus(ctx, serviceId, "stopped");
    }
  } else {
    updateServiceStatus(ctx, serviceId, "stopped");
    const log = deployment.build_log ?? "";
    const snippet = log.length > 2000 ? `${log.slice(0, 2000)}…` : log;
    insertLog(ctx, serviceId, "error", snippet ? `Deploy failed:\n${snippet}` : "Deploy failed.");
    createNotification(ctx, {
      kind: "deployment",
      severity: "error",
      title: `Deployment failed: ${serviceName}`,
      body: snippet.slice(0, 400),
      serviceId
    });
  }
}

/** Stop a running service before redeploying so git can update files safely. */
export async function stopServiceIfRunning(ctx: AppContext, serviceId: string): Promise<void> {
  const row = ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(serviceId) as
    | { status?: string }
    | undefined;
  if (row?.status === "running") {
    await stopService(ctx, serviceId);
  }
}

function nodeStartCommand(pm: NodePackageManager): string {
  if (pm === "pnpm") return "pnpm run start";
  if (pm === "yarn") return "yarn run start";
  if (pm === "bun") return "bun run start";
  return "npm run start";
}

export function inferServiceRuntimeDefaults(
  buildType: ReturnType<typeof detectBuildType>,
  projectPath?: string
): {
  type: "process" | "docker" | "static";
  command: string;
} {
  if (buildType === "docker") {
    return { type: "docker", command: "" };
  }
  if (buildType === "python") {
    return { type: "process", command: "python app.py" };
  }
  if (buildType === "node") {
    const packageManager = projectPath ? detectNodePackageManager(projectPath) : "npm";
    return { type: "process", command: nodeStartCommand(packageManager) };
  }
  if (buildType === "godot" || buildType === "static") {
    return { type: "static", command: staticServeCommand() };
  }
  return { type: "process", command: "" };
}

export async function deployFromLocalPath(
  ctx: AppContext,
  serviceId: string,
  localPath: string,
  trigger: DeployTrigger = "manual",
  options: { command?: string } = {}
) {
  if (!fs.existsSync(localPath)) throw new Error(`Local path does not exist: ${localPath}`);
  if (!fs.statSync(localPath).isDirectory()) throw new Error(`Path is not a directory: ${localPath}`);

  const deploymentId = nanoid();
  const startedAt = nowIso();
  let buildLog = `Source: local directory ${localPath}\n`;
  let status: "success" | "failed" = "success";
  let artifactPath = localPath;

  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(deploymentId, serviceId, "", "running", "", localPath, startedAt, startedAt, null, trigger);

  emitProgress(ctx, serviceId, deploymentId, "installing");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch: null, trigger });

  try {
    const buildType = detectBuildType(localPath);
    const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
      | { name?: string }
      | undefined;
    const nodeTarget =
      buildType === "node" ? detectNodeLaunchTarget(localPath, service?.name ?? "") : undefined;
    const inferred = inferServiceRuntimeDefaults(buildType, nodeTarget?.workingDir ?? localPath);
    const command =
      options.command !== undefined ? options.command : (nodeTarget?.command ?? inferred.command);
    ctx.db
      .prepare("UPDATE services SET type = ?, command = ?, working_dir = ?, updated_at = ? WHERE id = ?")
      .run(inferred.type, command, nodeTarget?.workingDir ?? localPath, nowIso(), serviceId);

    emitBuildLog(ctx, serviceId, deploymentId, `Detected build type: ${buildType}\n`);
    const result = await runBuildPipeline(ctx, serviceId, localPath, { deploymentId, nodeTarget });
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
    if (status === "success" && (buildType === "godot" || buildType === "static")) {
      ctx.db
        .prepare(
          "UPDATE services SET type = 'static', command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
        )
        .run(staticServeCommand(), artifactPath, nowIso(), serviceId);
    }
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  ctx.db
    .prepare(
      `UPDATE deployments SET status = ?, build_log = ?, artifact_path = ?, finished_at = ? WHERE id = ?`
    )
    .run(status, buildLog, artifactPath, finishedAt, deploymentId);

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId,
    status,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  });

  return {
    id: deploymentId,
    service_id: serviceId,
    commit_hash: "",
    status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch: null,
    trigger_source: trigger
  };
}

export async function rollbackDeployment(ctx: AppContext, serviceId: string, deploymentId: string) {
  const deployment = ctx.db
    .prepare("SELECT commit_hash, artifact_path, branch FROM deployments WHERE id = ? AND service_id = ?")
    .get(deploymentId, serviceId) as
    | { commit_hash?: string; artifact_path?: string; branch?: string }
    | undefined;
  if (!deployment?.commit_hash) throw new Error("Deployment not found");

  await stopServiceIfRunning(ctx, serviceId);

  const newDeployId = nanoid();
  const startedAt = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newDeployId,
      serviceId,
      deployment.commit_hash,
      "running",
      "",
      deployment.artifact_path ?? "",
      startedAt,
      startedAt,
      deployment.branch ?? null,
      "rollback"
    );
  emitProgress(ctx, serviceId, newDeployId, "building");
  broadcast(ctx, {
    type: "deployment_started",
    serviceId,
    deploymentId: newDeployId,
    branch: deployment.branch ?? null,
    trigger: "rollback"
  });
  emitBuildLog(ctx, serviceId, newDeployId, `Rollback to ${deployment.commit_hash}\n`);

  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const git = simpleGit(targetPath);
  await git.checkout(deployment.commit_hash);
  const result = await runBuildPipeline(ctx, serviceId, targetPath, { deploymentId: newDeployId });

  const buildLog = `Rollback to ${deployment.commit_hash}\n${result.buildLog}`;
  const finishedAt = nowIso();
  const artifactPath = deployment.artifact_path ?? result.artifactPath;
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  emitProgress(ctx, serviceId, newDeployId, result.status === "success" ? "done" : "failed");

  // Record canonical state on the new (rollback) deployment row, plus mark
  // the source deployment as rolled_back so the timeline reflects intent.
  if (result.status === "success") {
    transition(ctx, newDeployId, "rolled_back", { gitSha: deployment.commit_hash });
  } else {
    markFailed(ctx, newDeployId, "building");
  }
  transition(ctx, deploymentId, "rolled_back");

  ctx.db
    .prepare(
      `UPDATE deployments
     SET status = ?, build_log = ?, artifact_path = ?, finished_at = ?, duration_ms = ?, git_sha = COALESCE(git_sha, ?)
     WHERE id = ?`
    )
    .run(
      result.status === "success" ? "rolled_back" : "failed",
      buildLog,
      artifactPath,
      finishedAt,
      durationMs,
      deployment.commit_hash,
      newDeployId
    );

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId: newDeployId,
    status: result.status,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  });

  const row = {
    id: newDeployId,
    service_id: serviceId,
    commit_hash: deployment.commit_hash,
    status: result.status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch: deployment.branch ?? null,
    trigger_source: "rollback" as const
  };
  await applyPostDeployServiceState(ctx, serviceId, row, { startAfterDeploy: false });
  return row;
}
