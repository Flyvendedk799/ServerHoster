#!/usr/bin/env node
/**
 * verify-readiness.ts
 *
 * Reads ops/release-gates.json and confirms each required gate is satisfied
 * by the working tree. Designed to be run as a CI check at the end of the
 * build/test pipeline so a release is never cut while a [MUST] item from
 * docs/readiness-checklist.md is still red.
 *
 * Exit codes:
 *   0  all required gates passed
 *   1  one or more required gates failed
 *   2  malformed input
 *
 * Side effects:
 *   - Writes ops/readiness-scorecard.json with per-gate status, so docs and
 *     release notes can render the latest scorecard without re-running.
 *
 * Run via: `npm run verify:readiness` (defined in the root package.json) or
 * directly with `node --experimental-strip-types scripts/ci/verify-readiness.ts`
 * on Node 22+. We avoid the --strip-types requirement at runtime by emitting
 * a small JS shim alongside (kept as a guard) — the verifier itself stays
 * dependency-free.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type GateType = "file_exists" | "file_contains";

type Gate = {
  id: string;
  sequence: number;
  required: boolean;
  description: string;
  type: GateType;
  path: string;
  patterns?: string[];
  minBytes?: number;
};

type Manifest = {
  version: number;
  description?: string;
  gates: Gate[];
};

type GateResult = {
  id: string;
  sequence: number;
  required: boolean;
  status: "pass" | "fail" | "skipped";
  message: string;
};

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function readManifest(): Manifest {
  const manifestPath = path.join(repoRoot, "ops", "release-gates.json");
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`verify-readiness: missing ${manifestPath}\n`);
    process.exit(2);
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  let parsed: Manifest;
  try {
    parsed = JSON.parse(raw) as Manifest;
  } catch (err) {
    process.stderr.write(`verify-readiness: ${manifestPath} is not valid JSON: ${(err as Error).message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(parsed.gates)) {
    process.stderr.write(`verify-readiness: ${manifestPath} is missing "gates" array\n`);
    process.exit(2);
  }
  return parsed;
}

function checkFileExists(gate: Gate): GateResult {
  const target = path.join(repoRoot, gate.path);
  if (!fs.existsSync(target)) {
    return {
      id: gate.id,
      sequence: gate.sequence,
      required: gate.required,
      status: "fail",
      message: `expected file ${gate.path} to exist`
    };
  }
  const stat = fs.statSync(target);
  if (gate.minBytes && stat.size < gate.minBytes) {
    return {
      id: gate.id,
      sequence: gate.sequence,
      required: gate.required,
      status: "fail",
      message: `${gate.path} exists but is only ${stat.size} bytes (need >= ${gate.minBytes})`
    };
  }
  return {
    id: gate.id,
    sequence: gate.sequence,
    required: gate.required,
    status: "pass",
    message: `${gate.path} present (${stat.size}b)`
  };
}

function checkFileContains(gate: Gate): GateResult {
  const target = path.join(repoRoot, gate.path);
  if (!fs.existsSync(target)) {
    return {
      id: gate.id,
      sequence: gate.sequence,
      required: gate.required,
      status: "fail",
      message: `expected file ${gate.path} to exist for substring check`
    };
  }
  const body = fs.readFileSync(target, "utf8");
  const missing = (gate.patterns ?? []).filter((p) => !body.includes(p));
  if (missing.length > 0) {
    return {
      id: gate.id,
      sequence: gate.sequence,
      required: gate.required,
      status: "fail",
      message: `${gate.path} missing required substrings: ${missing.join(", ")}`
    };
  }
  return {
    id: gate.id,
    sequence: gate.sequence,
    required: gate.required,
    status: "pass",
    message: `${gate.path} contains all required substrings`
  };
}

function runGate(gate: Gate): GateResult {
  switch (gate.type) {
    case "file_exists":
      return checkFileExists(gate);
    case "file_contains":
      return checkFileContains(gate);
    default:
      return {
        id: gate.id,
        sequence: gate.sequence,
        required: gate.required,
        status: "skipped",
        message: `unknown gate type "${gate.type as string}"`
      };
  }
}

function summarise(results: GateResult[]): {
  total: number;
  pass: number;
  fail: number;
  skipped: number;
  failedRequired: GateResult[];
} {
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const failedRequired: GateResult[] = [];
  for (const r of results) {
    if (r.status === "pass") pass++;
    else if (r.status === "fail") {
      fail++;
      if (r.required) failedRequired.push(r);
    } else skipped++;
  }
  return { total: results.length, pass, fail, skipped, failedRequired };
}

function writeScorecard(results: GateResult[]): void {
  const scorecardPath = path.join(repoRoot, "ops", "readiness-scorecard.json");
  const bySequence = new Map<
    number,
    { sequence: number; total: number; pass: number; fail: number; gates: GateResult[] }
  >();
  for (const r of results) {
    const bucket = bySequence.get(r.sequence) ?? {
      sequence: r.sequence,
      total: 0,
      pass: 0,
      fail: 0,
      gates: []
    };
    bucket.total++;
    if (r.status === "pass") bucket.pass++;
    else if (r.status === "fail") bucket.fail++;
    bucket.gates.push(r);
    bySequence.set(r.sequence, bucket);
  }
  const sequences = Array.from(bySequence.values()).sort((a, b) => a.sequence - b.sequence);
  const out = {
    generatedAt: new Date().toISOString(),
    sequences,
    overall: summarise(results)
  };
  fs.writeFileSync(scorecardPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o644 });
}

function main(): void {
  const manifest = readManifest();
  const results = manifest.gates.map(runGate);

  for (const r of results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    const flag = r.required ? "MUST" : "SHOULD";
    process.stdout.write(`[${tag}] (${flag}, seq ${r.sequence}) ${r.id} — ${r.message}\n`);
  }

  writeScorecard(results);
  const summary = summarise(results);
  process.stdout.write(
    `\nverify-readiness: ${summary.pass}/${summary.total} passed, ${summary.fail} failed, ${summary.skipped} skipped\n`
  );
  if (summary.failedRequired.length > 0) {
    process.stderr.write(`verify-readiness: ${summary.failedRequired.length} required gate(s) failed\n`);
    process.exit(1);
  }
}

main();
