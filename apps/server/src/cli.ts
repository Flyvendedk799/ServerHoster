#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const command = args[0];

const dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dirname, "index.js");

if (command === "start" || command === "server" || !command) {
  spawn(process.execPath, [entry], { stdio: "inherit" });
} else if (command === "logs") {
  console.log("Use dashboard logs or API endpoint /services/:id/logs");
} else if (command === "stop") {
  console.log("Use your system service manager to stop SURVHub.");
} else {
  console.log("Usage: survhub [start|server|logs|stop]");
}
