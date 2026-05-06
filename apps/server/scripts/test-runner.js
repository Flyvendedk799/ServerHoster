#!/usr/bin/env node
/**
 * Local test runner. Wraps `node --test` with two important things the bare
 * runner doesn't do:
 *
 *   1. Force SURVHUB_DATA_DIR into a throwaway temp directory before tests
 *      load the server. Otherwise the integration tests do
 *      `INSERT OR REPLACE INTO settings (...'dashboard_password'...)` and
 *      create dozens of `svc-*` rows directly inside the user's real
 *      ~/.survhub/survhub.db.
 *
 *   2. Wipe that temp directory on every run so test state never carries
 *      across invocations.
 *
 * CI already sets SURVHUB_DATA_DIR explicitly per platform; if it's set we
 * respect it. Locally `npm test` falls into the temp-dir branch.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SURVHUB_DATA_DIR || path.join(os.tmpdir(), "survhub-tests");
process.env.SURVHUB_DATA_DIR = dataDir;
if (!process.env.SURVHUB_SECRET_KEY) {
  process.env.SURVHUB_SECRET_KEY = "test-secret-key-32-bytes-not-for-prod";
}

// Wipe and recreate so each run starts from a known-clean state.
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  /* nothing to remove */
}
fs.mkdirSync(dataDir, { recursive: true });

const distDir = path.resolve(here, "..", "dist");
if (!fs.existsSync(distDir)) {
  process.stderr.write(`No dist/ found at ${distDir}. Run \`npm run build\` first.\n`);
  process.exit(1);
}
const testFiles = fs
  .readdirSync(distDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join("dist", f))
  .sort();

if (testFiles.length === 0) {
  process.stderr.write("No test files found under dist/. Did `npm run build` succeed?\n");
  process.exit(1);
}

const args = ["--test", "--test-concurrency=1", ...testFiles];
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: process.env,
  cwd: path.resolve(here, "..")
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
