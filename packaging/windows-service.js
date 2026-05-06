#!/usr/bin/env node
/* eslint-disable */
/**
 * LocalSURV Windows Service installer (optional, requires admin).
 *
 * The default Windows install path uses a Scheduled Task triggered at user
 * logon. That works without admin and is fine for single-user developer
 * machines. If you want LocalSURV to run as a true Windows Service that
 * starts before any user logs in, use this script.
 *
 * Prerequisites:
 *   1. Install node-windows globally:  npm install -g node-windows
 *   2. Run from an *elevated* PowerShell (Run as Administrator):
 *        node packaging\windows-service.js install
 *        node packaging\windows-service.js uninstall
 *
 * The service runs as LocalSystem by default. To run as your user, edit the
 * `Service` constructor below to set `user` / `password`.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let svcLib;
try {
  svcLib = require("node-windows");
} catch (err) {
  console.error("node-windows is not installed. Run: npm install -g node-windows");
  process.exit(1);
}

const installDir = path.resolve(__dirname, "..");
const dataDir = process.env.SURVHUB_DATA_DIR || path.join(os.homedir(), ".survhub");
const envFile = path.join(dataDir, "survhub.env");
const serverEntry = path.join(installDir, "apps", "server", "dist", "index.js");

if (!fs.existsSync(serverEntry)) {
  console.error(`Server entry not found at ${serverEntry}. Did the build run? Try: npm run build`);
  process.exit(1);
}

const env = [];
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, name, rawValue] = m;
    const value = rawValue.replace(/^"(.*)"$/, "$1");
    env.push({ name, value });
  }
}

const svc = new svcLib.Service({
  name: "LocalSURV",
  description: "LocalSURV control plane (self-hosted deploy platform).",
  script: serverEntry,
  nodeOptions: [],
  env
});

const action = process.argv[2];

switch (action) {
  case "install":
    svc.on("install", () => {
      console.log("Service installed. Starting…");
      svc.start();
    });
    svc.on("alreadyinstalled", () => console.log("Service is already installed."));
    svc.on("start", () => console.log("LocalSURV service started."));
    svc.install();
    break;
  case "uninstall":
    svc.on("uninstall", () => console.log("Service uninstalled."));
    svc.uninstall();
    break;
  case "start":
    svc.start();
    break;
  case "stop":
    svc.stop();
    break;
  default:
    console.error("Usage: node packaging\\windows-service.js {install|uninstall|start|stop}");
    process.exit(2);
}
