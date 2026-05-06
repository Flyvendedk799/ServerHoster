import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../types.js";
import { getReleasesLatestUrl, isUpstreamConfigured } from "../lib/upstream.js";

/**
 * Lightweight "is there a newer release on GitHub?" probe.
 *
 * Runs once on boot and then every 24h. Result is stored in the `settings`
 * table under `update_check.latest_version` / `update_check.checked_at` so
 * the dashboard can render a passive banner. No auto-install — the user
 * remains in control. Disable with `LOCALSURV_NO_UPDATE_CHECK=1`. Also
 * skipped silently when the upstream slug is the unfilled sentinel.
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../package.json"),
      path.resolve(here, "../../../package.json")
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return "0.0.0";
}

function setKv(ctx: AppContext, key: string, value: string): void {
  ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function compareSemver(a: string, b: string): number {
  // Returns >0 if a > b, <0 if a < b, 0 if equal. Strips leading "v".
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => Number(n) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

async function fetchLatestRelease(): Promise<{ tag_name: string; html_url: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(getReleasesLatestUrl(), {
      headers: { "user-agent": "localsurv-update-check", accept: "application/vnd.github+json" },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!data.tag_name) return null;
    return { tag_name: data.tag_name, html_url: data.html_url ?? "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(ctx: AppContext): Promise<void> {
  const current = readPackageVersion();
  const latest = await fetchLatestRelease();
  setKv(ctx, "update_check.checked_at", new Date().toISOString());
  if (!latest) return;
  setKv(ctx, "update_check.latest_version", latest.tag_name);
  setKv(ctx, "update_check.release_url", latest.html_url);
  setKv(ctx, "update_check.current_version", current);
  setKv(ctx, "update_check.update_available", compareSemver(latest.tag_name, current) > 0 ? "1" : "0");
}

export function startUpdateCheckLoop(ctx: AppContext): () => void {
  if (process.env.LOCALSURV_NO_UPDATE_CHECK === "1") {
    return () => undefined;
  }
  // Until the project owner sets a real upstream slug, skip the check so
  // we don't spam api.github.com/repos/<GITHUB_OWNER>/localsurv with 404s.
  if (!isUpstreamConfigured()) {
    return () => undefined;
  }
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void runCheck(ctx).catch((err) => ctx.app.log?.warn?.({ err }, "update_check_failed"));
  };
  tick();
  const handle = setInterval(tick, CHECK_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
