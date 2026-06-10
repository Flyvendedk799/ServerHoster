import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureExecutable } from "./services/terminals.js";

test("ensureExecutable restores a stripped execute bit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-exec-"));
  const helper = path.join(dir, "spawn-helper");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  const fixed = ensureExecutable([helper, path.join(dir, "missing")]);

  assert.deepEqual(fixed, [helper]);
  assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureExecutable leaves already-executable files alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-exec-"));
  const helper = path.join(dir, "spawn-helper");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  assert.deepEqual(ensureExecutable([helper]), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("node-pty spawn-helper for this platform is executable", () => {
  if (process.platform === "win32") return;
  // The module-load self-heal in terminals.ts must have fixed it by now.
  const ptyRoot = path.dirname(new URL(import.meta.resolve("node-pty/package.json")).pathname);
  const helper = path.join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!fs.existsSync(helper)) return; // source build instead of prebuild
  assert.notEqual(fs.statSync(helper).mode & 0o111, 0, `${helper} must be executable`);
});
