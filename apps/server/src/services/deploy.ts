import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { nanoid } from "nanoid";
import { detectBuildType, getServiceEnv, nowIso, runCommand } from "../lib/core.js";
import type { AppContext } from "../types.js";

export async function runBuildPipeline(ctx: AppContext, serviceId: string, projectPath: string): Promise<{ status: "success" | "failed"; buildLog: string; artifactPath: string }> {
  const env = { ...process.env, ...getServiceEnv(ctx, serviceId) };
  const buildType = detectBuildType(projectPath);
  let buildLog = `Detected build type: ${buildType}\n`;
  let artifactPath = projectPath;

  if (buildType === "node") {
    const install = await runCommand("npm install", projectPath, env);
    buildLog += `\n$ npm install\n${install.output}\n`;
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };
    const build = await runCommand("npm run build", projectPath, env);
    buildLog += `\n$ npm run build\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    if (fs.existsSync(path.join(projectPath, "dist"))) artifactPath = path.join(projectPath, "dist");
  } else if (buildType === "python") {
    const installCmd = fs.existsSync(path.join(projectPath, "requirements.txt"))
      ? "python -m pip install -r requirements.txt"
      : "python -m pip install .";
    const install = await runCommand(installCmd, projectPath, env);
    buildLog += `\n$ ${installCmd}\n${install.output}\n`;
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };
  } else if (buildType === "docker") {
    const imageTag = `survhub-build-${serviceId}:latest`;
    const build = await runCommand(`docker build -t ${imageTag} .`, projectPath, env, 240000);
    buildLog += `\n$ docker build -t ${imageTag} .\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    ctx.db.prepare("UPDATE services SET docker_image = ?, updated_at = ? WHERE id = ?").run(imageTag, nowIso(), serviceId);
  }

  return { status: "success", buildLog, artifactPath };
}

export async function deployFromGit(ctx: AppContext, serviceId: string, repoUrl: string) {
  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const git = simpleGit();
  let buildLog = "";
  let commitHash = "";
  let status: "success" | "failed" = "success";
  let artifactPath = targetPath;

  try {
    if (fs.existsSync(path.join(targetPath, ".git"))) {
      await git.cwd(targetPath).pull();
      buildLog += "Pulled latest changes.\n";
    } else {
      await git.clone(repoUrl, targetPath);
      buildLog += "Cloned repository.\n";
    }
    commitHash = (await git.cwd(targetPath).revparse(["HEAD"])).trim();
    const result = await runBuildPipeline(ctx, serviceId, targetPath);
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
  } catch (error) {
    status = "failed";
    buildLog += `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
  }

  const row = {
    id: nanoid(),
    service_id: serviceId,
    commit_hash: commitHash,
    status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: nowIso()
  };
  ctx.db.prepare("INSERT INTO deployments (id, service_id, commit_hash, status, build_log, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.service_id, row.commit_hash, row.status, row.build_log, row.artifact_path, row.created_at);
  return row;
}

export async function rollbackDeployment(ctx: AppContext, serviceId: string, deploymentId: string) {
  const deployment = ctx.db.prepare("SELECT commit_hash, artifact_path FROM deployments WHERE id = ? AND service_id = ?")
    .get(deploymentId, serviceId) as { commit_hash?: string; artifact_path?: string } | undefined;
  if (!deployment?.commit_hash) throw new Error("Deployment not found");

  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const git = simpleGit(targetPath);
  await git.checkout(deployment.commit_hash);
  const result = await runBuildPipeline(ctx, serviceId, targetPath);

  const row = {
    id: nanoid(),
    service_id: serviceId,
    commit_hash: deployment.commit_hash,
    status: result.status,
    build_log: `Rollback to ${deployment.commit_hash}\n${result.buildLog}`,
    artifact_path: deployment.artifact_path ?? result.artifactPath,
    created_at: nowIso()
  };
  ctx.db.prepare("INSERT INTO deployments (id, service_id, commit_hash, status, build_log, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.service_id, row.commit_hash, row.status, row.build_log, row.artifact_path, row.created_at);
  return row;
}
