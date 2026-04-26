import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOutput, parsePortMapping } from "./lib/core.js";
import { parseDependsOn } from "./services/runtime.js";
import { parseRepoFullName } from "./services/github.js";

test("parsePortMapping: plain number", () => {
  assert.equal(parsePortMapping(3000), 3000);
});

test("parsePortMapping: string 'host:container'", () => {
  assert.equal(parsePortMapping("8080:80"), 8080);
});

test("parsePortMapping: string with protocol", () => {
  assert.equal(parsePortMapping("8080:80/tcp"), 8080);
});

test("parsePortMapping: returns null on garbage", () => {
  assert.equal(parsePortMapping("not-a-port"), null);
  assert.equal(parsePortMapping(null), null);
  assert.equal(parsePortMapping(undefined), null);
});

test("normalizeOutput: converts CRLF and trims", () => {
  assert.equal(normalizeOutput("hello\r\nworld\r\n"), "hello\nworld");
  assert.equal(normalizeOutput("  padded  "), "padded");
});

test("parseDependsOn: JSON array", () => {
  assert.deepEqual(parseDependsOn('["a","b","c"]'), ["a", "b", "c"]);
});

test("parseDependsOn: already-array input", () => {
  assert.deepEqual(parseDependsOn(["x", "y"]), ["x", "y"]);
});

test("parseDependsOn: garbage falls back to empty", () => {
  assert.deepEqual(parseDependsOn("not json"), []);
  assert.deepEqual(parseDependsOn(null), []);
  assert.deepEqual(parseDependsOn(undefined), []);
});

test("parseRepoFullName: HTTPS URL", () => {
  assert.equal(parseRepoFullName("https://github.com/anthropics/claude.git"), "anthropics/claude");
});

test("parseRepoFullName: URL without .git suffix", () => {
  assert.equal(parseRepoFullName("https://github.com/octocat/hello-world"), "octocat/hello-world");
});

test("parseRepoFullName: non-github host returns null", () => {
  assert.equal(parseRepoFullName("https://gitlab.com/foo/bar.git"), null);
});

test("parseRepoFullName: invalid URL returns null", () => {
  assert.equal(parseRepoFullName("not a url"), null);
});
