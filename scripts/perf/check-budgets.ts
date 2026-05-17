#!/usr/bin/env node
/**
 * check-budgets.ts
 *
 * Sequence 8 — performance smoke runner. Executes a small set of
 * measurements against the built server and the dashboard bundle, then
 * compares each result to a max threshold from `ops/perf-budgets.json`.
 *
 * Designed for CI: writes `ops/perf-results.json` with the latest sample,
 * exits non-zero when any budget is violated.
 *
 * Measurements:
 *   server_cold_boot_ms   — `node apps/server/dist/cli.js version` wall-clock
 *   server_warm_boot_ms   — second invocation; warm Node start
 *   deploy_simple_ms      — placeholder; integration test handles real deploy
 *   web_bundle_gz_bytes   — gzip(apps/web/dist/assets/index*.js) when present
 *   health_p95_ms         — placeholder; covered by integration smoke
 *
 * Anything that can't be measured (e.g. dashboard bundle missing) is
 * recorded as `null` and skipped, not failed — the budget verifier reports
 * skips loudly so they show up in CI logs.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import process from "node:process";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

type Budget = {
  id: string;
  label: string;
  metric: string;
  max: number;
  rationale: string;
};

type BudgetsManifest = {
  version: number;
  budgets: Budget[];
};

type Sample = { metric: string; value: number | null; durationMs?: number; note?: string };

async function measureColdBoot(): Promise<Sample> {
  const cli = path.join(repoRoot, "apps", "server", "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    return { metric: "server_cold_boot_ms", value: null, note: "dist/cli.js missing — build first" };
  }
  const start = performance.now();
  await exec(process.execPath, [cli, "version"]);
  return { metric: "server_cold_boot_ms", value: Math.round(performance.now() - start) };
}

async function measureWarmBoot(): Promise<Sample> {
  const cli = path.join(repoRoot, "apps", "server", "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    return { metric: "server_warm_boot_ms", value: null, note: "dist/cli.js missing — build first" };
  }
  // The first invocation in measureColdBoot warmed Node; treat the second as warm.
  const start = performance.now();
  await exec(process.execPath, [cli, "version"]);
  return { metric: "server_warm_boot_ms", value: Math.round(performance.now() - start) };
}

function measureBundleSize(): Sample {
  const candidates = [
    path.join(repoRoot, "apps", "web", "dist", "assets"),
    path.join(repoRoot, "apps", "server", "dist", "web-dist", "assets")
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    if (files.length === 0) continue;
    let totalGz = 0;
    for (const f of files) {
      const body = fs.readFileSync(path.join(dir, f));
      totalGz += zlib.gzipSync(body).length;
    }
    return { metric: "web_bundle_gz_bytes", value: totalGz, note: `from ${dir}` };
  }
  return { metric: "web_bundle_gz_bytes", value: null, note: "no built dashboard bundle found" };
}

async function main(): Promise<void> {
  const manifestPath = path.join(repoRoot, "ops", "perf-budgets.json");
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`check-budgets: missing ${manifestPath}\n`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BudgetsManifest;

  const samples: Sample[] = [];
  samples.push(await measureColdBoot());
  samples.push(await measureWarmBoot());
  samples.push(measureBundleSize());
  // deploy_simple_ms / health_p95_ms are covered by the integration-test
  // suite; we don't re-measure them here. Reporting null + budget skipped
  // is intentional.
  samples.push({ metric: "deploy_simple_ms", value: null, note: "covered by deploy.integration.test.ts" });
  samples.push({ metric: "health_p95_ms", value: null, note: "covered by integration smoke" });

  const samplesByMetric = new Map<string, Sample>(samples.map((s) => [s.metric, s]));
  let failures = 0;

  for (const budget of manifest.budgets) {
    const sample = samplesByMetric.get(budget.metric);
    if (!sample || sample.value === null) {
      process.stdout.write(
        `[SKIP]  ${budget.id} (${budget.label}) — no measurement (${sample?.note ?? "missing"})\n`
      );
      continue;
    }
    if (sample.value > budget.max) {
      process.stdout.write(
        `[FAIL]  ${budget.id} (${budget.label}) — measured ${sample.value} > budget ${budget.max}\n         rationale: ${budget.rationale}\n`
      );
      failures++;
    } else {
      process.stdout.write(
        `[PASS]  ${budget.id} (${budget.label}) — measured ${sample.value} <= ${budget.max}\n`
      );
    }
  }

  fs.writeFileSync(
    path.join(repoRoot, "ops", "perf-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), samples }, null, 2) + "\n"
  );

  if (failures > 0) {
    process.stderr.write(`check-budgets: ${failures} budget(s) violated\n`);
    process.exit(1);
  }
}

void main();
