import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBuildType } from "./lib/core.js";

test("detectBuildType prefers Dockerfile over package.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-detect1-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "Dockerfile"), "FROM alpine\n");
    assert.equal(detectBuildType(root), "docker");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectBuildType unknown when no markers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-detect2-"));
  try {
    fs.writeFileSync(path.join(root, "README.md"), "# x");
    assert.equal(detectBuildType(root), "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectBuildType detects Godot projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-detect-godot-"));
  try {
    fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
    assert.equal(detectBuildType(root), "godot");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectBuildType detects nested static web apps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-detect-static-"));
  try {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "index.html"), "<!doctype html>");
    assert.equal(detectBuildType(root), "static");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
