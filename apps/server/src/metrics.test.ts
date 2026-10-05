import test from "node:test";
import assert from "node:assert/strict";
import { normalizeComposeProject } from "./services/compose.js";
import {
  aggregateProcessTreeSample,
  collectProcessTreePids,
  composeProjectLabelName,
  computeUnaccountedMb,
  parseDockerMemUsage,
  parseDockerStatsLine,
  parseDockerStatsOutput,
  parseMeminfo,
  parsePsProcessTable,
  parseSmapsRollupPssKb,
  sumContainerMemoryMb,
  type ProcessRow
} from "./services/metrics.js";

// ---------------------------------------------------------------------------
// Docker stats MemUsage — cache-adjusted figure from the CLI, not raw usage
// ---------------------------------------------------------------------------

test("parseDockerMemUsage reads MiB used side", () => {
  assert.equal(parseDockerMemUsage("12.3MiB / 256MiB"), 12.3);
  assert.equal(parseDockerMemUsage("1.5GiB / 8GiB"), 1536);
  assert.equal(parseDockerMemUsage("512KiB / 64MiB"), 0.5);
});

test("parseDockerMemUsage rejects garbage", () => {
  assert.equal(parseDockerMemUsage(""), null);
  assert.equal(parseDockerMemUsage("N/A"), null);
  assert.equal(parseDockerMemUsage("-- / --"), null);
});

test("parseDockerStatsLine splits name|cpu|mem", () => {
  const row = parseDockerStatsLine("supabase_db_app|3.5%|842.1MiB / 2GiB");
  assert.deepEqual(row, { name: "supabase_db_app", cpu: 3.5, memoryMb: 842.1 });
});

test("parseDockerStatsOutput skips blank / bad lines", () => {
  const rows = parseDockerStatsOutput(
    [
      "survhub-abc|1.0%|10MiB / 100MiB",
      "",
      "job-desk-xyz|0.2%|220.5MiB / 1GiB",
      "broken"
    ].join("\n")
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "survhub-abc");
  assert.equal(rows[1].memoryMb, 220.5);
  assert.equal(sumContainerMemoryMb(rows), 230.5);
});

// ---------------------------------------------------------------------------
// Process table + tree walk
// ---------------------------------------------------------------------------

test("parsePsProcessTable reads pid/ppid/cpu/rss", () => {
  const rows = parsePsProcessTable(
    ["  100  1  0.5  2048", "  101  100 12.0 102400", "  102  100  1.0  4096", "junk"].join("\n")
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { pid: 101, ppid: 100, cpu: 12, rssKb: 102400 });
});

test("collectProcessTreePids walks descendants and includes the root", () => {
  const rows: ProcessRow[] = [
    { pid: 1, ppid: 0, cpu: 0, rssKb: 100 },
    { pid: 100, ppid: 1, cpu: 0.1, rssKb: 2000 }, // sh -c wrapper
    { pid: 101, ppid: 100, cpu: 20, rssKb: 200000 }, // real node
    { pid: 102, ppid: 101, cpu: 5, rssKb: 50000 }, // worker
    { pid: 200, ppid: 1, cpu: 1, rssKb: 9999 } // unrelated
  ];
  assert.deepEqual(collectProcessTreePids(100, rows).sort((a, b) => a - b), [100, 101, 102]);
});

// ---------------------------------------------------------------------------
// PSS vs RSS aggregation — full-tree PSS only; never partial undercount
// ---------------------------------------------------------------------------

test("parseSmapsRollupPssKb reads the Pss line", () => {
  const content = [
    "Rss:                 50000 kB",
    "Pss:                 12000 kB",
    "Pss_Anon:            10000 kB",
    "Pss_File:             2000 kB"
  ].join("\n");
  assert.equal(parseSmapsRollupPssKb(content), 12000);
  assert.equal(parseSmapsRollupPssKb("Rss: 1 kB\n"), null);
});

test("aggregateProcessTreeSample prefers summed PSS over RSS when the FULL tree has PSS", () => {
  const rows: ProcessRow[] = [
    { pid: 100, ppid: 1, cpu: 0.5, rssKb: 2048 },
    { pid: 101, ppid: 100, cpu: 10, rssKb: 100000 },
    { pid: 102, ppid: 100, cpu: 8, rssKb: 100000 } // shared pages → RSS sum would overstate
  ];
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const pssByPid = new Map<number, number>([
    [100, 500],
    [101, 40000],
    [102, 40000]
  ]);
  const sample = aggregateProcessTreeSample([100, 101, 102], byPid, pssByPid);
  assert.ok(sample);
  assert.equal(sample!.memorySource, "pss");
  // 80500 kB ≈ 78.6 MB
  assert.equal(sample!.memoryMb, 78.6);
  // CPU is the SUM across the tree
  assert.equal(sample!.cpu, 18.5);
});

test("partial PSS must NOT return incomplete sum as authoritative PSS", () => {
  const rows: ProcessRow[] = [
    { pid: 100, ppid: 1, cpu: 0.5, rssKb: 2048 },
    { pid: 101, ppid: 100, cpu: 10, rssKb: 102400 }, // 100 MiB RSS
    { pid: 102, ppid: 100, cpu: 8, rssKb: 51200 } // missing smaps_rollup
  ];
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  // Only 2 of 3 pids have PSS — returning PSS here would undercount pid 102.
  const pssByPid = new Map<number, number>([
    [100, 500],
    [101, 40000]
  ]);
  const sample = aggregateProcessTreeSample([100, 101, 102], byPid, pssByPid);
  assert.ok(sample);
  assert.equal(sample!.memorySource, "rss");
  // Full RSS sum: (2048+102400+51200)/1024 = 152.0
  assert.equal(sample!.memoryMb, 152);
  assert.equal(sample!.cpu, 18.5);
});

test("aggregateProcessTreeSample falls back to RSS and labels memorySource=rss", () => {
  const rows: ProcessRow[] = [
    { pid: 100, ppid: 1, cpu: 1, rssKb: 10240 },
    { pid: 101, ppid: 100, cpu: 2, rssKb: 20480 }
  ];
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const sample = aggregateProcessTreeSample([100, 101], byPid, new Map());
  assert.ok(sample);
  assert.equal(sample!.memorySource, "rss");
  assert.equal(sample!.memoryMb, 30); // (10240+20480)/1024
  assert.equal(sample!.cpu, 3);
});

// ---------------------------------------------------------------------------
// Compose project label normalization (must match deploy)
// ---------------------------------------------------------------------------

test("composeProjectLabelName matches deploy normalizeComposeProject", () => {
  const cases = ["My App/Stack", "__gamehub", "PlayerZero-api", "playerzero_api", "///"];
  for (const raw of cases) {
    assert.equal(
      composeProjectLabelName(raw),
      normalizeComposeProject(raw),
      `label name must match deploy normalization for ${JSON.stringify(raw)}`
    );
  }
  // Concrete expectations shared with compose.test.ts
  assert.equal(composeProjectLabelName("My App/Stack"), "my-app-stack");
  assert.equal(composeProjectLabelName("__gamehub"), "gamehub");
  assert.equal(composeProjectLabelName("///"), "compose");
});

// ---------------------------------------------------------------------------
// Host meminfo + unaccounted remainder
// ---------------------------------------------------------------------------

test("parseMeminfo prefers MemAvailable", () => {
  const parsed = parseMeminfo(
    ["MemTotal:       16384000 kB", "MemFree:         1000000 kB", "MemAvailable:    4096000 kB"].join("\n")
  );
  assert.ok(parsed);
  assert.equal(parsed!.totalKb, 16384000);
  assert.equal(parsed!.availableKb, 4096000);
  assert.equal(parsed!.freeKb, 1000000);
});

test("computeUnaccountedMb is hostUsed − process − ALL docker (floored at 0)", () => {
  // Supabase / job-desk are already inside dockerAttributed (3072), not unaccounted.
  // Unaccounted here (~4.6 GB) is kernel / page-cache / non-docker processes.
  assert.equal(computeUnaccountedMb(8192, 400, 3072), 4720);
  assert.equal(computeUnaccountedMb(100, 80, 50), 0);
});

test("non-SH containers live in dockerAttributed, not unaccounted", () => {
  const rows = parseDockerStatsOutput(
    [
      "survhub-abc|1.0%|100MiB / 1GiB",
      "supabase_db_app|2.0%|800MiB / 2GiB",
      "job-desk-xyz|0.5%|200MiB / 1GiB"
    ].join("\n")
  );
  const dockerMb = sumContainerMemoryMb(rows);
  assert.equal(dockerMb, 1100);
  // Host used 2000, process 50, docker 1100 → unaccounted 850 (NOT the supabase/job-desk bytes).
  assert.equal(computeUnaccountedMb(2000, 50, dockerMb), 850);
});

test("compose-style sum of container MemUsage does not inflate with limit side", () => {
  const rows = parseDockerStatsOutput(
    [
      "playerzero-api-api-1|2.0%|256MiB / 2GiB",
      "playerzero-api-db-1|1.0%|512MiB / 2GiB",
      "playerzero-api-redis-1|0.1%|32MiB / 256MiB"
    ].join("\n")
  );
  assert.equal(sumContainerMemoryMb(rows), 800);
  assert.equal(computeUnaccountedMb(6000, 100, sumContainerMemoryMb(rows)), 5100);
});
