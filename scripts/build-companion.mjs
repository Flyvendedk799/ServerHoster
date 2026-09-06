#!/usr/bin/env node
/**
 * Build the companion PWA so the control plane can serve it at /m.
 *
 * `companion/` is deliberately NOT an npm workspace — `scripts/split-to-own-repo.sh`
 * exists so it can be lifted into its own repo — which is exactly why it was
 * never built by `npm run build` and therefore never shipped. This bridges that:
 * the root build installs the companion's own dependencies if they are missing,
 * then builds it.
 *
 * Failure is a WARNING, not an error. The control plane must still build and
 * deploy on a machine with no network to fetch the companion's dependencies, or
 * with a companion build that has broken; the only consequence is that /m is not
 * served and the pairing QR falls back to the raw payload. CI passes --strict to
 * turn that back into a hard failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionDir = path.join(root, "companion");
const strict = process.argv.includes("--strict");

function fail(message) {
  if (strict) {
    console.error(`companion build: ${message}`);
    process.exit(1);
  }
  console.warn(`companion build skipped: ${message}`);
  console.warn("  The control plane will not serve /m; pairing falls back to the raw QR payload.");
  process.exit(0);
}

/**
 * Run npm in companion/. On Windows npm is a shell script, so it needs a shell;
 * the arguments here are all literals, never anything from outside this file.
 */
function run(args, cwd) {
  const viaShell = process.platform === "win32";
  const result = spawnSync(viaShell ? ["npm", ...args].join(" ") : "npm", viaShell ? [] : args, {
    cwd,
    stdio: "inherit",
    shell: viaShell
  });
  if (result.error) console.warn(`companion build: npm ${args.join(" ")} — ${result.error.message}`);
  return result.status === 0;
}

if (!fs.existsSync(path.join(companionDir, "package.json"))) {
  fail("companion/ is not present in this checkout");
}

if (!fs.existsSync(path.join(companionDir, "node_modules"))) {
  const hasLock = fs.existsSync(path.join(companionDir, "package-lock.json"));
  console.log(`companion build: installing dependencies (npm ${hasLock ? "ci" : "install"})…`);
  const installed =
    (hasLock && run(["ci", "--no-audit", "--no-fund"], companionDir)) ||
    run(["install", "--no-audit", "--no-fund"], companionDir);
  if (!installed) fail("could not install companion dependencies");
}

if (!run(["run", "build"], companionDir)) {
  fail("`npm run build` failed in companion/");
}

const indexHtml = path.join(companionDir, "dist", "index.html");
if (!fs.existsSync(indexHtml)) {
  fail("the build produced no companion/dist/index.html");
}

console.log(`companion build: ready — the control plane will serve it at /m (${indexHtml})`);
