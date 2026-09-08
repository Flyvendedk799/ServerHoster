import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectNodeLaunchTarget, readNitroBuildOutput, refineNodeLaunchTarget } from "./services/deploy.js";

function tmpRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `survhub-nitro-${label}-`));
}

/**
 * A TanStack Start app. Note it looks identical to a plain Vite SPA from
 * package.json alone — no `start` script, `vite build` as the build — which is
 * the whole reason the launch target cannot be decided before the build runs.
 */
const TANSTACK_APP = {
  name: "consflow",
  private: true,
  type: "module",
  scripts: { dev: "vite dev", build: "vite build", preview: "vite preview" },
  dependencies: { "@tanstack/react-start": "^1.167.50", react: "^19.0.0", vite: "^7.3.1" }
};

function writeNitroOutput(dir: string, nitro: Record<string, unknown>, entry = "server/index.mjs"): void {
  fs.mkdirSync(path.join(dir, ".output", path.dirname(entry)), { recursive: true });
  fs.writeFileSync(path.join(dir, ".output", entry), "// built server\n");
  fs.writeFileSync(path.join(dir, ".output", "nitro.json"), JSON.stringify(nitro, null, 2));
}

function viteTarget(dir: string) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(TANSTACK_APP, null, 2));
  fs.writeFileSync(path.join(dir, "vite.config.ts"), "export default {};\n");
  return detectNodeLaunchTarget(dir, "Boared");
}

test("a Nitro framework is indistinguishable from a Vite SPA before the build", () => {
  const dir = tmpRoot("predetect");
  const target = viteTarget(dir);
  // Pre-build detection can only see package.json, so it picks the dev server.
  // This is the behaviour refineNodeLaunchTarget() exists to correct.
  assert.match(target.command, /vite --host/);
});

test("a node-server Nitro build launches the built server, not the dev server", () => {
  const dir = tmpRoot("nodeserver");
  const target = viteTarget(dir);
  writeNitroOutput(dir, { preset: "node-server", serverEntry: "server/index.mjs" });

  const { target: refined, note } = refineNodeLaunchTarget(target, dir);
  assert.equal(refined.command, "node .output/server/index.mjs");
  assert.equal(refined.kind, "web");
  assert.match(refined.reason, /Nitro "node-server" build/);
  assert.match(note ?? "", /launching \.output\/server\/index\.mjs/);
});

test("a cloudflare Nitro build keeps its command and explains why", () => {
  const dir = tmpRoot("cloudflare");
  const target = viteTarget(dir);
  // A Cloudflare bundle exports a `fetch` handler and never opens a socket, so
  // running it with node would exit silently — worse than the dev server.
  writeNitroOutput(dir, { preset: "cloudflare-module", serverEntry: "server/index.mjs" });

  const { target: refined, note } = refineNodeLaunchTarget(target, dir);
  assert.equal(refined.command, target.command);
  assert.match(note ?? "", /cloudflare-module/);
  assert.match(note ?? "", /NITRO_PRESET=node-server/);
});

test("a non-Nitro build is left completely alone", () => {
  const dir = tmpRoot("plain");
  const target = viteTarget(dir);
  const { target: refined, note } = refineNodeLaunchTarget(target, dir);
  assert.equal(refined.command, target.command);
  assert.equal(note, undefined);
});

test("a nitro.json promising an entry that was not emitted is not trusted", () => {
  const dir = tmpRoot("missing");
  const target = viteTarget(dir);
  fs.mkdirSync(path.join(dir, ".output"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".output", "nitro.json"),
    JSON.stringify({ preset: "node-server", serverEntry: "server/index.mjs" })
  );

  const { target: refined } = refineNodeLaunchTarget(target, dir);
  assert.equal(refined.command, target.command);
});

test("serverEntry is honoured when it is not the default path", () => {
  const dir = tmpRoot("entry");
  const target = viteTarget(dir);
  writeNitroOutput(dir, { preset: "node-server", serverEntry: "server/custom.mjs" }, "server/custom.mjs");

  const { target: refined } = refineNodeLaunchTarget(target, dir);
  assert.equal(refined.command, "node .output/server/custom.mjs");
});

test("readNitroBuildOutput tolerates absent and malformed metadata", () => {
  const dir = tmpRoot("malformed");
  assert.equal(readNitroBuildOutput(dir), null);

  fs.mkdirSync(path.join(dir, ".output"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".output", "nitro.json"), "{ not json");
  assert.equal(readNitroBuildOutput(dir), null);

  fs.writeFileSync(path.join(dir, ".output", "nitro.json"), JSON.stringify({ serverEntry: "server/index.mjs" }));
  assert.equal(readNitroBuildOutput(dir), null, "a preset-less nitro.json says nothing useful");

  fs.writeFileSync(path.join(dir, ".output", "nitro.json"), JSON.stringify({ preset: "node-server" }));
  assert.deepEqual(readNitroBuildOutput(dir), { preset: "node-server", serverEntry: "server/index.mjs" });
});
