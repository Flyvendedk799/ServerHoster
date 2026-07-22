import test from "node:test";
import assert from "node:assert/strict";
import { healthcheckPathFromCompose, matchProxyRoute, normalizeRoutePrefix } from "./lib/core.js";
import { versionSatisfies } from "./services/hostRequirements.js";

test("normalizeRoutePrefix: defaults and trims", () => {
  assert.equal(normalizeRoutePrefix(undefined), "/");
  assert.equal(normalizeRoutePrefix(""), "/");
  assert.equal(normalizeRoutePrefix("/"), "/");
  assert.equal(normalizeRoutePrefix("v1"), "/v1");
  assert.equal(normalizeRoutePrefix("/v1/"), "/v1");
  assert.equal(normalizeRoutePrefix("  /api/  "), "/api");
});

test("matchProxyRoute: longest prefix wins over catch-all", () => {
  const routes = [
    { path_prefix: "/", target_port: 3004 },
    { path_prefix: "/v1", target_port: 3191 }
  ];
  assert.equal(matchProxyRoute(routes, "/")?.target_port, 3004);
  assert.equal(matchProxyRoute(routes, "/projects/abc")?.target_port, 3004);
  assert.equal(matchProxyRoute(routes, "/v1")?.target_port, 3191);
  assert.equal(matchProxyRoute(routes, "/v1/runs/123")?.target_port, 3191);
});

test("matchProxyRoute: prefix match is boundary-aware", () => {
  const routes = [
    { path_prefix: "/", target_port: 3004 },
    { path_prefix: "/v1", target_port: 3191 }
  ];
  // /v1beta must NOT be captured by the /v1 route — a naive startsWith would.
  assert.equal(matchProxyRoute(routes, "/v1beta")?.target_port, 3004);
  assert.equal(matchProxyRoute(routes, "/v1x/y")?.target_port, 3004);
});

test("matchProxyRoute: no catch-all means unmatched paths return null", () => {
  const routes = [{ path_prefix: "/v1", target_port: 3191 }];
  assert.equal(matchProxyRoute(routes, "/dashboard"), null);
  assert.equal(matchProxyRoute([], "/"), null);
});

test("matchProxyRoute: missing path_prefix is treated as catch-all", () => {
  // Rows created before the path_prefix migration.
  const routes: Array<{ path_prefix?: string | null; target_port: number }> = [{ target_port: 8080 }];
  assert.equal(matchProxyRoute(routes, "/anything")?.target_port, 8080);
});

test("healthcheckPathFromCompose: extracts path from a CMD url", () => {
  assert.equal(
    healthcheckPathFromCompose({ test: ["CMD", "curl", "-f", "http://localhost:3191/health"] }),
    "/health"
  );
  assert.equal(healthcheckPathFromCompose({ test: "curl -f https://example.com/api/ready" }), "/api/ready");
});

test("healthcheckPathFromCompose: non-HTTP probes yield no path", () => {
  assert.equal(healthcheckPathFromCompose({ test: ["CMD-SHELL", "pg_isready -U app -d app"] }), "");
  assert.equal(healthcheckPathFromCompose({ test: ["CMD", "redis-cli", "ping"] }), "");
  assert.equal(healthcheckPathFromCompose(undefined), "");
  assert.equal(healthcheckPathFromCompose({}), "");
});

test("healthcheckPathFromCompose: bare origin becomes /", () => {
  assert.equal(healthcheckPathFromCompose({ test: ["CMD", "curl", "http://localhost:8080"] }), "/");
});

test("versionSatisfies: compares dotted versions numerically", () => {
  assert.equal(versionSatisfies("22.1.0", "22"), true);
  assert.equal(versionSatisfies("18.20.4", "22"), false);
  assert.equal(versionSatisfies("9.15.0", "9.15"), true);
  assert.equal(versionSatisfies("9.14.9", "9.15"), false);
  // 10 > 9 numerically, not lexicographically.
  assert.equal(versionSatisfies("10.0.0", "9"), true);
});

test("versionSatisfies: tolerates version banners and v-prefixes", () => {
  assert.equal(versionSatisfies("v22.18.0", "22"), true);
  assert.equal(versionSatisfies("Python 3.12.3", "3.10"), true);
  assert.equal(versionSatisfies("unparseable", "1"), false);
});
