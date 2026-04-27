import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { nanoid } from "nanoid";
import { broadcast, detectBuildType, getServiceEnv, insertLog, nowIso, runCommand, serializeError, updateServiceStatus } from "../lib/core.js";
import type { AppContext } from "../types.js";
import { startService, stopService } from "./runtime.js";
import { buildGitEnv, injectGitCredentials } from "./settings.js";
import { createNotification } from "./notifications.js";

export type DeployPhase = "queued" | "cloning" | "installing" | "building" | "starting" | "done" | "failed";
export type DeployTrigger = "manual" | "webhook" | "gitops-poller" | "rollback";

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

function emitProgress(
  ctx: AppContext,
  serviceId: string,
  deploymentId: string,
  phase: DeployPhase
): void {
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
  opts: { deploymentId?: string; onPhase?: (phase: DeployPhase) => void } = {}
): Promise<{ status: "success" | "failed"; buildLog: string; artifactPath: string }> {
  const deploymentId = opts.deploymentId;
  const env = { ...process.env, ...getServiceEnv(ctx, serviceId) };
  const buildType = detectBuildType(projectPath);
  let buildLog = `Detected build type: ${buildType}\n`;
  let artifactPath = projectPath;

  const stream = (chunk: string, s: "stdout" | "stderr") => {
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, chunk, s);
  };

  if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, buildLog, "stdout");

  if (buildType === "node") {
    opts.onPhase?.("installing");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "installing");
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, "\n$ npm install\n", "stdout");
    const install = await runCommand("npm install", projectPath, env, { onChunk: stream });
    buildLog += `\n$ npm install\n${install.output}\n`;
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };

    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, "\n$ npm run build --if-present\n", "stdout");
    const build = await runCommand("npm run build --if-present", projectPath, env, { onChunk: stream });
    buildLog += `\n$ npm run build --if-present\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    if (fs.existsSync(path.join(projectPath, "dist"))) artifactPath = path.join(projectPath, "dist");
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
  } else if (buildType === "docker") {
    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    const imageTag = `survhub-build-${serviceId}:latest`;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ docker build -t ${imageTag} .\n`, "stdout");
    const build = await runCommand(`docker build -t ${imageTag} .`, projectPath, env, {
      timeoutMs: 240000,
      onChunk: stream
    });
    buildLog += `\n$ docker build -t ${imageTag} .\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    ctx.db.prepare("UPDATE services SET docker_image = ?, updated_at = ? WHERE id = ?").run(imageTag, nowIso(), serviceId);
  } else if (buildType === "unknown") {
    const msg =
      "\nNo Dockerfile, package.json, requirements.txt, or pyproject.toml found. Cannot deploy this repository layout.\n";
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
  ctx.db.prepare(
    `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(deploymentId, serviceId, "", "running", "", targetPath, startedAt, startedAt, branch, trigger);

  emitProgress(ctx, serviceId, deploymentId, "cloning");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch, trigger });

  try {
    if (fs.existsSync(path.join(targetPath, ".git"))) {
      // Reset origin URL so an updated PAT or switched remote takes effect.
      try { await git.cwd(targetPath).remote(["set-url", "origin", authedUrl]); } catch { /* first-time */ }
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
    const inferred = inferServiceRuntimeDefaults(buildType);
    ctx.db.prepare(
      "UPDATE services SET type = ?, command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
    ).run(inferred.type, inferred.command, targetPath, nowIso(), serviceId);
    commitHash = (await git.cwd(targetPath).revparse(["HEAD"])).trim();
    const result = await runBuildPipeline(ctx, serviceId, targetPath, { deploymentId });
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  ctx.db.prepare(
    `UPDATE deployments
     SET commit_hash = ?, status = ?, build_log = ?, artifact_path = ?, finished_at = ?
     WHERE id = ?`
  ).run(commitHash, status, buildLog, artifactPath, finishedAt, deploymentId);

  broadcast(ctx, { type: "deployment_finished", serviceId, deploymentId, status, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) });

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
  const svcRow = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as { name?: string } | undefined;
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
  const row = ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(serviceId) as { status?: string } | undefined;
  if (row?.status === "running") {
    await stopService(ctx, serviceId);
  }
}

export function inferServiceRuntimeDefaults(buildType: ReturnType<typeof detectBuildType>): { type: "process" | "docker" | "static"; command: string } {
  if (buildType === "docker") {
    return { type: "docker", command: "" };
  }
  if (buildType === "python") {
    return { type: "process", command: "python app.py" };
  }
  if (buildType === "node") {
    return { type: "process", command: "npm run start" };
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

  ctx.db.prepare(
    `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(deploymentId, serviceId, "", "running", "", localPath, startedAt, startedAt, null, trigger);

  emitProgress(ctx, serviceId, deploymentId, "installing");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch: null, trigger });

  try {
    const buildType = detectBuildType(localPath);
    const inferred = inferServiceRuntimeDefaults(buildType);
    const command = options.command !== undefined ? options.command : inferred.command;
    ctx.db.prepare(
      "UPDATE services SET type = ?, command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
    ).run(inferred.type, command, localPath, nowIso(), serviceId);

    emitBuildLog(ctx, serviceId, deploymentId, `Detected build type: ${buildType}\n`);
    const result = await runBuildPipeline(ctx, serviceId, localPath, { deploymentId });
    status = result.status;
    buildLog += result.buildLog;
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  ctx.db.prepare(
    `UPDATE deployments SET status = ?, build_log = ?, artifact_path = ?, finished_at = ? WHERE id = ?`
  ).run(status, buildLog, localPath, finishedAt, deploymentId);

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
    artifact_path: localPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch: null,
    trigger_source: trigger
  };
}

export async function rollbackDeployment(ctx: AppContext, serviceId: string, deploymentId: string) {
  const deployment = ctx.db.prepare("SELECT commit_hash, artifact_path, branch FROM deployments WHERE id = ? AND service_id = ?")
    .get(deploymentId, serviceId) as { commit_hash?: string; artifact_path?: string; branch?: string } | undefined;
  if (!deployment?.commit_hash) throw new Error("Deployment not found");

  await stopServiceIfRunning(ctx, serviceId);

  const newDeployId = nanoid();
  const startedAt = nowIso();
  ctx.db.prepare(
    `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newDeployId, serviceId, deployment.commit_hash, "running", "", deployment.artifact_path ?? "",
    startedAt, startedAt, deployment.branch ?? null, "rollback"
  );
  emitProgress(ctx, serviceId, newDeployId, "building");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId: newDeployId, branch: deployment.branch ?? null, trigger: "rollback" });
  emitBuildLog(ctx, serviceId, newDeployId, `Rollback to ${deployment.commit_hash}\n`);

  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const git = simpleGit(targetPath);
  await git.checkout(deployment.commit_hash);
  const result = await runBuildPipeline(ctx, serviceId, targetPath, { deploymentId: newDeployId });

  const buildLog = `Rollback to ${deployment.commit_hash}\n${result.buildLog}`;
  const finishedAt = nowIso();
  const artifactPath = deployment.artifact_path ?? result.artifactPath;
  emitProgress(ctx, serviceId, newDeployId, result.status === "success" ? "done" : "failed");

  ctx.db.prepare(
    `UPDATE deployments
     SET status = ?, build_log = ?, artifact_path = ?, finished_at = ?
     WHERE id = ?`
  ).run(result.status, buildLog, artifactPath, finishedAt, newDeployId);

  broadcast(ctx, { type: "deployment_finished", serviceId, deploymentId: newDeployId, status: result.status, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) });

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
