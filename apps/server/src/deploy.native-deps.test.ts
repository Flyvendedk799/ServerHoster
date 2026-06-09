import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remediateNativeDeps } from "./services/deploy.js";

const HOST_MAJOR = Number(process.versions.node.split(".")[0]);

function scratchPkg(deps: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-remediate-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", ...deps }, null, 2));
  return dir;
}

test("remediateNativeDeps: bumps better-sqlite3@9 to ^11 on Node 23+ and reports it", () => {
  if (HOST_MAJOR < 23) return; // remediation is a no-op below the incompatible host floor
  const dir = scratchPkg({ dependencies: { "better-sqlite3": "^9.4.3", express: "^4.18.2" } });
  const notes = remediateNativeDeps(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["better-sqlite3"], "^11.10.0", "better-sqlite3 should be bumped");
  assert.equal(pkg.dependencies.express, "^4.18.2", "unrelated deps must be untouched");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /better-sqlite3/);
});

test("remediateNativeDeps: idempotent — an already-compatible pin is left alone", () => {
  if (HOST_MAJOR < 23) return;
  const dir = scratchPkg({ dependencies: { "better-sqlite3": "^11.10.0" } });
  const notes = remediateNativeDeps(dir);
  assert.deepEqual(notes, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["better-sqlite3"], "^11.10.0");
});

test("remediateNativeDeps: also covers devDependencies/optionalDependencies", () => {
  if (HOST_MAJOR < 23) return;
  const dir = scratchPkg({
    devDependencies: { "better-sqlite3": "9.6.0" },
    optionalDependencies: { "better-sqlite3": "~9.0.0" }
  });
  remediateNativeDeps(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["better-sqlite3"], "^11.10.0");
  assert.equal(pkg.optionalDependencies["better-sqlite3"], "^11.10.0");
});

test("remediateNativeDeps: a repo with no package.json is a safe no-op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-remediate-empty-"));
  assert.deepEqual(remediateNativeDeps(dir), []);
});
