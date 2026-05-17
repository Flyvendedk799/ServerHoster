#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shouldOpen = process.argv.includes("--open");
const uiUrl = "http://localhost:5175";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let shuttingDown = false;

function prefixOutput(name, chunk, stream) {
  const lines = chunk.toString().split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    stream.write(`[${name}] ${line}\n`);
  }
}

function startProcess(name, args) {
  const child = spawn(npmCommand, args, {
    cwd: rootDir,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  children.push(child);
  child.stdout.on("data", (chunk) => prefixOutput(name, chunk, process.stdout));
  child.stderr.on("data", (chunk) => prefixOutput(name, chunk, process.stderr));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[launcher] ${name} exited with ${reason}; stopping the rest.`);
    process.exitCode = code ?? 1;
    shutdown();
  });
}

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    killChild(child);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openWhenReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(uiUrl, { method: "HEAD" });
      if (response.ok || response.status < 500) {
        spawn("open", [uiUrl], { stdio: "ignore", detached: true }).unref();
        console.log(`[launcher] opened ${uiUrl}`);
        return;
      }
    } catch {
      await delay(1000);
    }
  }

  console.error(`[launcher] UI did not respond yet. Open ${uiUrl} manually when Vite is ready.`);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

startProcess("api", ["run", "dev", "-w", "@survhub/server"]);
startProcess("web", ["run", "dev:web"]);

if (shouldOpen) {
  void openWhenReady();
}
