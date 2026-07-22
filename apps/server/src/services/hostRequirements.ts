/**
 * Host requirement preflight.
 *
 * Process services run directly on the host, so they inherit whatever the box
 * happens to have installed. A repo needing Node 22, pnpm and Playwright's
 * Chromium will clone and build fine on a machine that has them, then fail with
 * an opaque ENOENT or a version error on one that doesn't — and the operator is
 * left reading a stack trace to work out what to `apt install`.
 *
 * This module resolves what a repo needs, checks each item against the host, and
 * reports precisely what's missing plus the command to install it, so the UI can
 * say "Node 22+ required, found 18" instead of "spawn pnpm ENOENT".
 *
 * Requirements come from two places:
 *   1. An explicit `requires` array in serverhoster.json (authoritative).
 *   2. Auto-detection from the repo (engines.node, a pnpm lockfile, a
 *      Dockerfile, requirements.txt, a playwright dependency).
 * Explicit entries win over auto-detected ones with the same id.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 15000;

export type HostRequirement = {
  /** Stable key; used to dedupe manifest entries against auto-detected ones. */
  id: string;
  label: string;
  /** Executable that must be on PATH. */
  command?: string;
  /** Minimum acceptable version of `command`, e.g. "22" or "9.15". */
  minVersion?: string;
  /**
   * Shell command whose exit code decides satisfaction (0 = satisfied). Use for
   * things PATH can't answer, e.g. whether a Playwright browser is downloaded.
   */
  probe?: string;
  /** Copy-pasteable command that installs this on a typical Linux host. */
  install?: string;
  /** Missing optional requirements are reported but don't block. */
  optional?: boolean;
  /** Where this requirement came from, for UI grouping. */
  source: "manifest" | "detected";
};

export type HostRequirementResult = HostRequirement & {
  satisfied: boolean;
  /** Version string found on the host, when discoverable. */
  detected?: string;
  /** Why it failed, in operator-readable terms. */
  reason?: string;
};

export type HostPreflightReport = {
  ok: boolean;
  /** Unsatisfied and non-optional. */
  missingRequired: HostRequirementResult[];
  results: HostRequirementResult[];
};

/** Compare dotted numeric versions. Returns true when `found` >= `min`. */
export function versionSatisfies(found: string, min: string): boolean {
  const parse = (value: string): number[] => {
    const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return [];
    return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };
  const a = parse(found);
  const b = parse(min);
  if (a.length === 0 || b.length === 0) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function run(command: string, args: string[], shell = false): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, shell, windowsHide: true },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, out });
      }
    );
    child.on("error", () => resolve({ code: 1, out: "" }));
  });
}

/** Is `command` on PATH? Uses the platform's own resolver rather than guessing. */
async function commandExists(command: string): Promise<boolean> {
  const { code } =
    process.platform === "win32"
      ? await run("where", [command])
      : await run("sh", ["-c", `command -v ${JSON.stringify(command)}`]);
  return code === 0;
}

async function detectVersion(command: string): Promise<string | undefined> {
  const { code, out } = await run(command, ["--version"]);
  if (code !== 0 || !out) return undefined;
  return out.split("\n")[0]?.trim().replace(/^v/, "");
}

export async function checkHostRequirement(req: HostRequirement): Promise<HostRequirementResult> {
  // `probe` is a repo-supplied shell command. That is the same trust level as
  // the build/start commands ServerHoster already runs from serverhoster.json —
  // deploying a repo means executing its code — so this adds no new exposure.
  if (req.probe) {
    const { code, out } = await run(req.probe, [], true);
    if (code === 0) return { ...req, satisfied: true };
    // Surface the first meaningful line, capped. Tool output tails are usually
    // log-file paths and "run npm audit" noise, which buries the actual cause.
    const firstLine = out
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    const reason = firstLine
      ? firstLine.length > 180
        ? `${firstLine.slice(0, 177)}…`
        : firstLine
      : // A quiet non-zero exit (e.g. `... | grep -q .`) is the normal "absent"
        // signal for a probe, not a malfunction — say so in operator terms.
        "not detected on this host";
    return { ...req, satisfied: false, reason };
  }

  if (!req.command) return { ...req, satisfied: true };

  if (!(await commandExists(req.command))) {
    return { ...req, satisfied: false, reason: `\`${req.command}\` is not installed or not on PATH` };
  }
  if (!req.minVersion) return { ...req, satisfied: true };

  const detected = await detectVersion(req.command);
  if (!detected) {
    // Present but unqueryable — don't fail the deploy over an unparseable banner.
    return { ...req, satisfied: true, reason: "installed (version could not be determined)" };
  }
  return versionSatisfies(detected, req.minVersion)
    ? { ...req, satisfied: true, detected }
    : {
        ...req,
        satisfied: false,
        detected,
        reason: `found ${detected}, needs ${req.minVersion}+`
      };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Explicit `requires` entries from serverhoster.json. */
export function manifestRequirements(root: string): HostRequirement[] {
  const manifest = readJson(path.join(root, "serverhoster.json"));
  const requires = manifest?.["requires"];
  if (!Array.isArray(requires)) return [];
  const out: HostRequirement[] = [];
  requires.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as Record<string, unknown>;
    const command = typeof entry["command"] === "string" ? entry["command"] : undefined;
    const probe = typeof entry["probe"] === "string" ? entry["probe"] : undefined;
    if (!command && !probe) return;
    const id = typeof entry["id"] === "string" && entry["id"] ? entry["id"] : (command ?? `req-${index}`);
    out.push({
      id,
      label: typeof entry["label"] === "string" && entry["label"] ? entry["label"] : id,
      ...(command ? { command } : {}),
      ...(typeof entry["minVersion"] === "string" ? { minVersion: entry["minVersion"] } : {}),
      ...(probe ? { probe } : {}),
      ...(typeof entry["install"] === "string" ? { install: entry["install"] } : {}),
      ...(entry["optional"] === true ? { optional: true } : {}),
      source: "manifest"
    });
  });
  return out;
}

/** Infer requirements from well-known project files, for repos with no manifest. */
export function detectedRequirements(root: string): HostRequirement[] {
  const out: HostRequirement[] = [];
  const pkg = readJson(path.join(root, "package.json"));

  if (pkg) {
    const engines = pkg["engines"];
    const nodeRange =
      engines && typeof engines === "object"
        ? (engines as Record<string, unknown>)["node"]
        : undefined;
    const minNode = typeof nodeRange === "string" ? nodeRange.match(/(\d+)/)?.[1] : undefined;
    out.push({
      id: "node",
      label: minNode ? `Node.js ${minNode}+` : "Node.js",
      command: "node",
      ...(minNode ? { minVersion: minNode } : {}),
      install: minNode
        ? `curl -fsSL https://deb.nodesource.com/setup_${minNode}.x | sudo -E bash - && sudo apt-get install -y nodejs`
        : "sudo apt-get install -y nodejs",
      source: "detected"
    });

    const packageManager = pkg["packageManager"];
    const usesPnpm =
      fs.existsSync(path.join(root, "pnpm-lock.yaml")) ||
      (typeof packageManager === "string" && packageManager.startsWith("pnpm"));
    if (usesPnpm) {
      out.push({
        id: "pnpm",
        label: "pnpm",
        command: "pnpm",
        install:
          typeof packageManager === "string"
            ? `corepack enable && corepack prepare ${packageManager} --activate`
            : "corepack enable && corepack prepare pnpm@latest --activate",
        source: "detected"
      });
    }
    if (fs.existsSync(path.join(root, "yarn.lock"))) {
      out.push({ id: "yarn", label: "Yarn", command: "yarn", install: "corepack enable", source: "detected" });
    }

    // Playwright needs both the package AND a downloaded browser plus system
    // libraries — the browser download is the part that silently isn't there.
    const deps = {
      ...((pkg["dependencies"] as Record<string, unknown>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, unknown>) ?? {})
    };
    const wantsPlaywright = Object.keys(deps).some((name) => name === "playwright" || name === "@playwright/test");
    if (wantsPlaywright) {
      out.push({
        id: "playwright-chromium",
        label: "Playwright Chromium + system libraries",
        probe: "npx --no-install playwright install --dry-run chromium",
        install: "npx playwright install --with-deps chromium",
        source: "detected"
      });
    }
  }

  if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    out.push({
      id: "python3",
      label: "Python 3",
      command: "python3",
      install: "sudo apt-get install -y python3 python3-venv python3-pip",
      source: "detected"
    });
  }

  if (fs.existsSync(path.join(root, "Dockerfile"))) {
    out.push({
      id: "docker",
      label: "Docker",
      command: "docker",
      install: "curl -fsSL https://get.docker.com | sudo sh",
      source: "detected"
    });
  }

  return out;
}

/** Manifest entries win over auto-detected ones sharing an id. */
export function collectHostRequirements(root: string): HostRequirement[] {
  const manifest = manifestRequirements(root);
  const seen = new Set(manifest.map((entry) => entry.id));
  return [...manifest, ...detectedRequirements(root).filter((entry) => !seen.has(entry.id))];
}

export async function runHostPreflight(root: string): Promise<HostPreflightReport> {
  const requirements = collectHostRequirements(root);
  const results = await Promise.all(requirements.map((entry) => checkHostRequirement(entry)));
  const missingRequired = results.filter((entry) => !entry.satisfied && !entry.optional);
  return { ok: missingRequired.length === 0, missingRequired, results };
}
