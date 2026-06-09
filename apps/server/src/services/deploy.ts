import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { nanoid } from "nanoid";
import {
  broadcast,
  detectBuildType,
  findStaticEntry,
  insertLog,
  nowIso,
  runCommand,
  sanitizedHostEnv,
  serializeError,
  updateServiceStatus
} from "../lib/core.js";
import type { AppContext } from "../types.js";
import { getServiceEnvWithLinks, startService, stopService, withLock } from "./runtime.js";
import { buildGitEnv, injectGitCredentials } from "./settings.js";
import { createNotification } from "./notifications.js";
import { transition, markFailed } from "./deployStateMachine.js";
import { recordDeployDuration, recordDeployFailure } from "./metrics.js";

export type DeployPhase = "queued" | "cloning" | "installing" | "building" | "starting" | "done" | "failed";
export type DeployTrigger = "manual" | "webhook" | "gitops-poller" | "rollback";

type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";
type NodeLaunchKind = "electron" | "web" | "node";
type NodeLaunchTarget = {
  kind: NodeLaunchKind;
  workingDir: string;
  command: string;
  buildCommand?: string;
  skipBuild?: boolean;
  reason: string;
};

// Native addon compiles (better-sqlite3, sharp, canvas, bcrypt) routinely blow
// past the 2-minute default; give installs real headroom.
const NODE_INSTALL_TIMEOUT_MS = 600_000;

function detectNodePackageManager(projectPath: string): NodePackageManager {
  const declared = detectDeclaredPackageManager(projectPath);
  // Never pick a package manager that isn't actually installed on the host —
  // fall back to npm (always present with Node). A Lovable/Bolt export often
  // declares `packageManager: "bun@…"` or ships a bun.lockb, which otherwise
  // fails the install with "bun: command not found".
  if (declared !== "npm" && !hasCommand(declared)) return "npm";
  return declared;
}

function detectDeclaredPackageManager(projectPath: string): NodePackageManager {
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectPath, "bun.lockb")) || fs.existsSync(path.join(projectPath, "bun.lock")))
    return "bun";
  // Fall back to the package.json "packageManager" field (Corepack) when no
  // lockfile is present, so a declared pnpm/yarn/bun repo isn't run with npm.
  const declared = readPackageJson(path.join(projectPath, "package.json"))?.packageManager;
  if (typeof declared === "string") {
    if (declared.startsWith("pnpm")) return "pnpm";
    if (declared.startsWith("yarn")) return "yarn";
    if (declared.startsWith("bun")) return "bun";
  }
  return "npm";
}

/**
 * Install commands for `installCwd`. The trap a plain `npm install` falls into:
 * a repo that committed its `node_modules` (built on another OS) has a matching
 * lockfile, so npm reports "up to date" and leaves the foreign prebuilt native
 * addons (e.g. a Linux `better-sqlite3.node`) in place — which then crash on
 * this host ("not a valid mach-o file").
 *
 * Fix it NON-DESTRUCTIVELY: `npm install` (respects the lockfile) followed by
 * `npm rebuild` whenever a node_modules already exists, so native addons are
 * recompiled for THIS host. We deliberately avoid `npm ci` — ci deletes
 * node_modules up front, so a redeploy that then fails (e.g. an unbuildable
 * native dep) would leave a previously-working service with NO deps at all.
 * `npm rebuild` is a no-op when there are no native addons. Only ever runs at
 * installCwd (resolveInstallCwd pins it to the workspace root for members).
 */
export function nodeInstallCommands(pm: NodePackageManager, installCwd: string): string[] {
  const hasModules = fs.existsSync(path.join(installCwd, "node_modules"));
  if (pm === "pnpm")
    return hasModules
      ? ["pnpm install --frozen-lockfile=false", "pnpm rebuild"]
      : ["pnpm install --frozen-lockfile=false"];
  if (pm === "yarn") return ["yarn install"];
  if (pm === "bun") return ["bun install"];
  return hasModules ? ["npm install", "npm rebuild"] : ["npm install"];
}

function nodeBuildCommand(pm: NodePackageManager): string {
  if (pm === "pnpm") return "pnpm run --if-present build";
  if (pm === "yarn") return "yarn run build";
  if (pm === "bun") return "bun run build";
  return "npm run build --if-present";
}

function packageRunCommand(pm: NodePackageManager, script: string): string {
  if (pm === "pnpm") return `pnpm run ${script}`;
  if (pm === "yarn") return `yarn run ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

/**
 * Command that builds a workspace member's dependency CLOSURE — its sibling
 * workspace packages, transitively — without building the member itself, in
 * topological order, run from the workspace root.
 *
 * A member's own build (e.g. `next build`) resolves sibling packages from their
 * compiled output (the `dist/` a `tsc` build emits, which their package.json
 * `main`/`types` point at). The member build does NOT build those siblings, so
 * on a fresh clone their `dist/` is missing and the build dies with
 * "Cannot find module '@scope/shared'". Building the closure first guarantees
 * every sibling it imports has emitted before the member builds.
 *
 * pnpm expresses this precisely with the `<name>^...` selector (dependencies of
 * the package, excluding it); it's a safe no-op (exit 0) when the member has no
 * workspace deps. npm/yarn/bun have no portable dependencies-only recursive
 * build, so defer to the repo's own root `build` script when it defines one —
 * the author orchestrates the graph there. Returns null when there is nothing
 * appropriate to run, leaving the member's own build to run alone.
 */
export function workspaceDepBuildCommand(
  pm: NodePackageManager,
  memberDir: string,
  projectPath: string
): string | null {
  if (pm === "pnpm") {
    const name = readPackageJson(path.join(memberDir, "package.json"))?.name;
    if (typeof name === "string" && name.length > 0) {
      return `pnpm --filter ${JSON.stringify(`${name}^...`)} run build`;
    }
    return null;
  }
  const rootScripts = readPackageJson(path.join(projectPath, "package.json"))?.scripts ?? {};
  return typeof rootScripts.build === "string" ? packageRunCommand(pm, "build") : null;
}

function packageDevCommand(pm: NodePackageManager, kind: NodeLaunchKind): string {
  const base = packageRunCommand(pm, "dev");
  return kind === "web" ? `${base} -- --host 0.0.0.0 --port $PORT` : base;
}

/** Run a locally-installed bin directly (not via an npm script). */
function packageExec(pm: NodePackageManager, command: string): string {
  if (pm === "pnpm") return `pnpm exec ${command}`;
  if (pm === "yarn") return `yarn exec ${command}`;
  if (pm === "bun") return `bunx ${command}`;
  return `npx ${command}`;
}

/**
 * Launch command for a Next.js app on the deploy port.
 *
 * We invoke `next` DIRECTLY rather than through the repo's `start`/`dev` script
 * for two reasons: (1) `<pm> run <script> -- <flags>` forwards a literal `--`,
 * which Next reads as end-of-options so appended `-p`/`-H` become bogus
 * positional directories ("Invalid project directory: …/--host"); and (2) those
 * scripts routinely hard-code their own port (e.g. `next dev -p 3000`), which
 * ignores the port ServerHoster assigned. When a build script exists we serve
 * the production build with `next start` (the build phase ran `next build`);
 * otherwise fall back to `next dev`. `-H 0.0.0.0` binds all interfaces for the
 * proxy.
 */
function nextLaunchCommand(pm: NodePackageManager, hasBuild: boolean): string {
  const sub = hasBuild ? "start" : "dev";
  return packageExec(pm, `next ${sub} -p $PORT -H 0.0.0.0`);
}

// Generated config that ServerHoster writes into a Vite app's directory at
// deploy time so the dev server accepts the proxied Host header.
const VITE_HOST_WRAPPER = ".survhub-vite.config.mjs";
const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
  "vite.config.cts"
];

function findViteConfig(dir: string): string | null {
  return VITE_CONFIG_NAMES.find((name) => fs.existsSync(path.join(dir, name))) ?? null;
}

/**
 * Launch command for a Vite app on the deploy port.
 *
 * Vite ≥5.4 added a Host-header check (DNS-rebinding protection) that rejects
 * requests arriving through ServerHoster's domain proxy/tunnel with
 * "Blocked request. This host is not allowed." Vite 5.x exposes no
 * `--allowedHosts` CLI flag, and editing the repo's vite config doesn't survive
 * the deploy's reset-to-origin. So we run `vite` directly against a generated
 * wrapper config (written by writeViteHostWrapper) that loads the user's real
 * config and merges `allowedHosts: true` — safe because the proxy is the only
 * ingress to the dev server.
 */
function viteLaunchCommand(pm: NodePackageManager): string {
  return packageExec(pm, `vite --host 0.0.0.0 --port $PORT --config ${VITE_HOST_WRAPPER}`);
}

/**
 * Write the wrapper config that lets a Vite dev server accept the proxied Host
 * header. Loads the user's real config (whatever its extension) via Vite's own
 * loader and merges `allowedHosts: true`. Rewritten on every deploy, so it
 * tracks config renames and survives the reset-to-origin that wipes it.
 */
export function writeViteHostWrapper(dir: string): void {
  const original = findViteConfig(dir);
  const loadBase = original
    ? `const loaded = await loadConfigFromFile(env, path.join(dir, ${JSON.stringify(original)}), dir);
  const base = loaded?.config ?? {};`
    : `const base = {};`;
  const contents = `// Generated by ServerHoster — do not edit. Lets the Vite dev server accept the
// Host header forwarded by the domain proxy/tunnel (the only ingress here), which
// Vite's DNS-rebinding guard would otherwise reject as "host not allowed".
import { loadConfigFromFile, mergeConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default async (env) => {
  ${loadBase}
  return mergeConfig(base, {
    server: { allowedHosts: true },
    preview: { allowedHosts: true }
  });
};
`;
  fs.writeFileSync(path.join(dir, VITE_HOST_WRAPPER), contents);
}

function staticServeCommand(): string {
  const candidates = [
    path.resolve(process.cwd(), "apps/server/dist/static-server.js"),
    path.resolve(process.cwd(), "dist/static-server.js")
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  return entry ? `node ${JSON.stringify(entry)}` : "python3 -m http.server $PORT --bind 0.0.0.0";
}

function hasCommand(command: string): boolean {
  return (
    process.env.PATH?.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, command))) ?? false
  );
}

function godotCommand(): string {
  if (hasCommand("godot")) return "godot";
  if (hasCommand("godot4")) return "godot4";
  return "godot";
}

function godotTemplatesDir(templateVersion: string): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Godot",
      "export_templates",
      templateVersion
    );
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "Godot", "export_templates", templateVersion);
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "godot",
    "export_templates",
    templateVersion
  );
}

async function ensureGodotWebExportTemplates(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  stream: (chunk: string, s: "stdout" | "stderr") => void
): Promise<string> {
  const cmd = godotCommand();
  const versionResult = await runCommand(`${cmd} --version`, projectPath, env, { timeoutMs: 30000 });
  if (versionResult.code !== 0) throw new Error(`Godot is not available: ${versionResult.output}`);
  const versionLine = versionResult.output.split(/\r?\n/).find(Boolean) ?? "";
  const match = versionLine.match(/(\d+\.\d+\.\d+)\.(stable|beta|rc|dev)/);
  if (!match) throw new Error(`Could not parse Godot version from: ${versionLine}`);

  const [, version, channel] = match;
  const templateVersion = `${version}.${channel}`;
  const dest = godotTemplatesDir(templateVersion);
  if (fs.existsSync(path.join(dest, "web_release.zip")) && fs.existsSync(path.join(dest, "web_debug.zip"))) {
    return cmd;
  }

  const tag = `${version}-${channel}`;
  const fileName = `Godot_v${version}-${channel}_export_templates.tpz`;
  const url = `https://github.com/godotengine/godot/releases/download/${tag}/${fileName}`;
  const tmpDir = path.join(os.tmpdir(), `survhub-godot-templates-${templateVersion}`);
  const archivePath = path.join(tmpDir, fileName);
  const installCommand = [
    `rm -rf ${JSON.stringify(tmpDir)}`,
    `mkdir -p ${JSON.stringify(tmpDir)} ${JSON.stringify(dest)}`,
    `curl -L --fail -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`,
    `unzip -q -o ${JSON.stringify(archivePath)} -d ${JSON.stringify(tmpDir)}`,
    `cp -R ${JSON.stringify(path.join(tmpDir, "templates"))}/. ${JSON.stringify(dest)}/`
  ].join(" && ");
  stream(`Godot Web export templates missing; installing ${templateVersion} from ${url}\n`, "stdout");
  const install = await runCommand(installCommand, projectPath, env, {
    timeoutMs: 240000,
    onChunk: stream
  });
  if (install.code !== 0) {
    throw new Error(`Failed to install Godot export templates: ${install.output}`);
  }
  return cmd;
}

function parseGodotWebExportPath(projectPath: string): string {
  const presetsPath = path.join(projectPath, "export_presets.cfg");
  if (!fs.existsSync(presetsPath)) return path.join(projectPath, "build", "web", "index.html");
  const raw = fs.readFileSync(presetsPath, "utf8");
  const sections = raw.split(/\n(?=\[preset\.\d+\])/);
  for (const section of sections) {
    if (!/\bplatform="Web"/.test(section)) continue;
    const match = section.match(/\bexport_path="([^"]+)"/);
    if (match?.[1]) return path.resolve(projectPath, match[1]);
  }
  return path.join(projectPath, "build", "web", "index.html");
}

type ParsedPackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  engines?: { node?: string };
};

/**
 * If the repo pins a Node version (.nvmrc, .node-version, or engines.node) whose
 * major differs from the host's, return a clear warning. A mismatch is the
 * usual cause of cryptic native-module compile errors (e.g. better-sqlite3@9
 * cannot build on Node 25 — it needs C++20). Non-fatal: a loud warning beats a
 * silent gyp error.
 */
export function nodeVersionWarning(dir: string): string | null {
  let spec: string | null = null;
  let source = "";
  const nvmrc = path.join(dir, ".nvmrc");
  const nodeVersion = path.join(dir, ".node-version");
  if (fs.existsSync(nvmrc)) {
    spec = fs.readFileSync(nvmrc, "utf8").trim();
    source = ".nvmrc";
  } else if (fs.existsSync(nodeVersion)) {
    spec = fs.readFileSync(nodeVersion, "utf8").trim();
    source = ".node-version";
  } else {
    const eng = readPackageJson(path.join(dir, "package.json"))?.engines?.node;
    if (eng) {
      spec = eng;
      source = "engines.node";
    }
  }
  if (!spec) return null;
  const wantMajor = spec.match(/(\d+)/)?.[1];
  const haveMajor = process.versions.node.split(".")[0];
  if (wantMajor && wantMajor !== haveMajor) {
    return (
      `WARNING: this repo requests Node ${spec} (${source}) but the host runs Node ${process.versions.node}. ` +
      `Native modules (better-sqlite3, sharp, bcrypt, canvas) may fail to compile or run. ` +
      `Switch the host Node (nvm/asdf/fnm) to match before deploying.\n`
    );
  }
  return null;
}

/**
 * Native addons whose old pinned majors won't build against newer Node majors,
 * with the lowest major that does. `better-sqlite3` < 11 fails to compile on
 * Node 23+ (the V8 headers require C++20) — by far the most common reason a
 * freshly-imported repo crash-loops on this Node-25 host. Extend this table as
 * other native deps hit the same wall.
 */
const NATIVE_DEP_FLOORS: ReadonlyArray<{
  name: string;
  hostNodeAtLeast: number;
  minMajor: number;
  bumpTo: string;
}> = [{ name: "better-sqlite3", hostNodeAtLeast: 23, minMajor: 11, bumpTo: "^11.10.0" }];

/**
 * Rewrite known-incompatible native dependency ranges in `dir`/package.json to a
 * version that builds on the host's Node — BEFORE install — so a repo pinning
 * e.g. better-sqlite3@9 deploys out of the box on Node 25 instead of dying in
 * node-gyp. Returns build-log notes (empty when nothing changed). Idempotent and
 * safe to run every deploy: a git reset restores the original pins and we
 * re-apply. npm reconciles a now-out-of-range package-lock entry on install, so
 * the lockfile doesn't need touching.
 */
export function remediateNativeDeps(dir: string): string[] {
  const pkgPath = path.join(dir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const hostMajor = Number(process.versions.node.split(".")[0]);
  const notes: string[] = [];
  let changed = false;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const map = deps as Record<string, string>;
    for (const floor of NATIVE_DEP_FLOORS) {
      const current = map[floor.name];
      if (typeof current !== "string" || hostMajor < floor.hostNodeAtLeast) continue;
      const major = Number(current.match(/(\d+)/)?.[1]);
      if (Number.isFinite(major) && major >= floor.minMajor) continue; // already compatible
      if (current === floor.bumpTo) continue;
      map[floor.name] = floor.bumpTo;
      changed = true;
      notes.push(
        `Auto-fix: ${floor.name} "${current}" → "${floor.bumpTo}" — the pinned version can't build ` +
          `on Node ${process.versions.node} (needs C++20); bumped to a host-compatible range so the ` +
          `deploy runs out of the box.`
      );
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    } catch {
      return [];
    }
  }
  return notes;
}

function readPackageJson(packagePath: string): ParsedPackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")) as ParsedPackageJson;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` is the root of a JS monorepo workspace — a pnpm-workspace.yaml
 * or a package.json "workspaces" field. Members of such a root share a single
 * install at the root (deps are hoisted), so we must not install inside them.
 */
function isWorkspaceRoot(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  const pkg = readPackageJson(path.join(dir, "package.json"));
  if (!pkg?.workspaces) return false;
  return Array.isArray(pkg.workspaces)
    ? pkg.workspaces.length > 0
    : Array.isArray(pkg.workspaces.packages) && pkg.workspaces.packages.length > 0;
}

/**
 * Where to run the install for a node launch target. When the target is a
 * subdirectory (e.g. an app nested under the repo), install inside that
 * directory so its node_modules lands where the app — and tools like Vite that
 * walk up for the nearest node_modules — resolve dependencies. Exception: if the
 * repo root is a workspace root, install there so the package manager hoists
 * dependencies for the member as designed.
 */
export function resolveInstallCwd(projectPath: string, targetDir: string): string {
  if (path.resolve(targetDir) === path.resolve(projectPath)) return projectPath;
  return isWorkspaceRoot(projectPath) ? projectPath : targetDir;
}

/**
 * Package manager that governs a launch target: a workspace member inherits the
 * root's (the lockfile lives at the workspace root), while a standalone nested
 * package uses its own lockfile, defaulting to npm.
 */
function targetPackageManager(
  projectPath: string,
  targetDir: string,
  rootPackageManager: NodePackageManager
): NodePackageManager {
  if (path.resolve(targetDir) === path.resolve(projectPath)) return rootPackageManager;
  if (isWorkspaceRoot(projectPath)) return rootPackageManager;
  return detectNodePackageManager(targetDir);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findPackageDirs(rootPath: string): string[] {
  const out: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "out", "release", ".turbo"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    if (fs.existsSync(path.join(dir, "package.json"))) out.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(rootPath, 0);
  return out;
}

/** True if any package dir under `rootPath` has a launchable web/node app. */
function hasLaunchableNodePackage(rootPath: string): boolean {
  return findPackageDirs(rootPath).some((dir) => {
    const pkg = readPackageJson(path.join(dir, "package.json"));
    if (!pkg) return false;
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Boolean(
      scripts.dev ||
        scripts.start ||
        scripts.build ||
        deps.vite ||
        deps.next ||
        deps.astro ||
        deps.nuxt ||
        deps["@sveltejs/kit"] ||
        deps.electron
    );
  });
}

/** Shallowest subdirectory holding a Python project marker, or null. */
function findPythonProjectDir(rootPath: string): string | null {
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
  const found: Array<{ dir: string; depth: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    const hasMarker =
      fs.existsSync(path.join(dir, "requirements.txt")) ||
      fs.existsSync(path.join(dir, "pyproject.toml"));
    if (hasMarker) found.push({ dir, depth });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(rootPath, 0);
  if (found.length === 0) return null;
  found.sort((a, b) => a.depth - b.depth);
  return found[0].dir;
}

/** System Python: prefer python3 (stock macOS and many Linux have no bare `python`). */
function pythonBaseExe(): string {
  if (hasCommand("python3")) return "python3";
  if (hasCommand("python")) return "python";
  return "python3";
}

// The per-project venv interpreter, relative to the app dir (= working_dir at
// run time). runBuildPipeline always provisions this venv for python builds.
const VENV_PY_REL = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";

/** Grep the usual entrypoint files for `var = FastAPI()/Flask()/Starlette()`. */
function detectPyAppObject(dir: string, classRe: RegExp): { module: string; attr: string } | null {
  for (const file of ["main.py", "app.py", "asgi.py", "wsgi.py", "server.py", "application.py"]) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    let src = "";
    try {
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const m = src.match(classRe);
    if (m) return { module: file.replace(/\.py$/, ""), attr: m[1] };
  }
  return null;
}

/**
 * Run command for a Python app dir. Uses the project venv interpreter and binds
 * 0.0.0.0:$PORT explicitly — a bare `python app.py` Flask/FastAPI app defaults
 * to 127.0.0.1 on a fixed port, ignoring the injected PORT, so the proxy and
 * healthchecks can never reach it.
 */
export function pythonEntryCommand(dir: string): string {
  const py = VENV_PY_REL;
  if (fs.existsSync(path.join(dir, "manage.py"))) return `${py} manage.py runserver 0.0.0.0:$PORT`;
  const asgi = detectPyAppObject(dir, /(\w+)\s*=\s*(?:FastAPI|Starlette)\s*\(/);
  if (asgi) return `${py} -m uvicorn ${asgi.module}:${asgi.attr} --host 0.0.0.0 --port $PORT`;
  const wsgi = detectPyAppObject(dir, /(\w+)\s*=\s*Flask\s*\(/);
  if (wsgi) return `${py} -m gunicorn ${wsgi.module}:${wsgi.attr} --bind 0.0.0.0:$PORT`;
  if (fs.existsSync(path.join(dir, "main.py"))) return `${py} main.py`;
  return `${py} app.py`;
}

/** Which extra server package the chosen run command needs (installed into the venv). */
function pythonServerPackage(dir: string): string | null {
  if (fs.existsSync(path.join(dir, "manage.py"))) return null;
  if (detectPyAppObject(dir, /(\w+)\s*=\s*(?:FastAPI|Starlette)\s*\(/)) return "uvicorn";
  if (detectPyAppObject(dir, /(\w+)\s*=\s*Flask\s*\(/)) return "gunicorn";
  return null;
}

/**
 * detectBuildType only inspects the repo ROOT. When the root has no build
 * markers, an app nested in a subdirectory (the `project/uploads/<app>` layout)
 * gets misclassified — a Vite app's index.html makes the repo look "static" and
 * it's served as raw source. This widens detection: when the root yields
 * static/unknown but a launchable node app or a Python project lives in a
 * subdir, classify accordingly so the proper (subdir-aware) pipeline runs.
 */
export function resolveBuildType(projectPath: string): ReturnType<typeof detectBuildType> {
  const base = detectBuildType(projectPath);
  if (base !== "static" && base !== "unknown") return base;
  if (findDockerfile(projectPath)) return "docker";
  if (hasLaunchableNodePackage(projectPath)) return "node";
  if (findPythonProjectDir(projectPath)) return "python";
  // A "static" classification that points at raw SPA source (index.html loading
  // /src/main.tsx) must not be served as-is. If there's a buildable package,
  // build it as node instead of serving the unbundled source.
  if (base === "static") {
    const entry = findStaticEntry(projectPath);
    if (entry && looksLikeUnbuiltSpa(entry) && findPackageDirs(projectPath).length > 0) return "node";
  }
  return base;
}

/** An index.html that references a dev entry (e.g. /src/main.tsx) is unbuilt SPA source. */
export function looksLikeUnbuiltSpa(dir: string): boolean {
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) return false;
  let html = "";
  try {
    html = fs.readFileSync(idx, "utf8");
  } catch {
    return false;
  }
  return (
    /<script[^>]+src=["']\/?src\/(main|index)\.(t|j)sx?["']/i.test(html) ||
    /type=["']module["'][^>]+src=["']\/?src\//i.test(html)
  );
}

/**
 * Shallowest Dockerfile under the repo (root preferred), returned relative to
 * projectPath, or null. Lets a repo whose only build marker is a subdirectory
 * Dockerfile still deploy as docker. detectBuildType only checks the root.
 */
export function findDockerfile(projectPath: string): string | null {
  if (fs.existsSync(path.join(projectPath, "Dockerfile"))) return "Dockerfile";
  const ignored = new Set([".git", "node_modules", "dist", "build", "out", ".venv", "venv"]);
  const found: Array<{ rel: string; depth: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && /^Dockerfile(\..+)?$/.test(e.name)) {
        found.push({ rel: path.relative(projectPath, path.join(dir, e.name)), depth });
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !ignored.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(projectPath, 0);
  if (found.length === 0) return null;
  found.sort((a, b) => a.depth - b.depth || a.rel.length - b.rel.length);
  return found[0].rel;
}

export function detectNodeLaunchTarget(
  projectPath: string,
  serviceName = "",
  packageManager: NodePackageManager = detectNodePackageManager(projectPath)
): NodeLaunchTarget {
  const normalizedServiceName = normalizeName(serviceName);
  const packageDirs = findPackageDirs(projectPath);
  let best: {
    score: number;
    target: NodeLaunchTarget;
  } | null = null;

  for (const dir of packageDirs) {
    const pkg = readPackageJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const rel = path.relative(projectPath, dir) || ".";
    const relNorm = rel.split(path.sep).join("/");
    // Build this candidate's commands with the package manager that will
    // actually run them, so install/build/run agree even for a nested app
    // whose lockfile differs from the repo root.
    const pm = targetPackageManager(projectPath, dir, packageManager);
    const nameText = normalizeName(`${pkg.name ?? ""} ${rel}`);
    // A package whose name (or path) matches the service name is the strongest
    // signal of which app the user actually wants — it must dominate the generic
    // "this looks like a web framework" score. Otherwise a service named after
    // the root app loses to a stray nested app (e.g. a Vite export committed
    // under uploads/).
    const matchesName = Boolean(normalizedServiceName) && nameText.includes(normalizedServiceName);
    const nameBonus = matchesName ? 1000 : 0;
    // Penalize apps living in directories that are clearly not the project to
    // run — uploaded/bundled/example content rather than the repo's own app.
    const inNonAppDir =
      /(^|\/)(uploads?|examples?|samples?|fixtures?|templates?|vendor|demos?|tests?|__tests__|node_modules)(\/|$)/i.test(
        relNorm
      );
    const hasDev = Boolean(scripts.dev);
    const hasStart = Boolean(scripts.start);
    const hasBuild = Boolean(scripts.build);
    const scriptText = Object.values(scripts).join(" ");

    let score = 0;
    let kind: NodeLaunchKind = "node";
    let command = hasDev ? packageRunCommand(pm, "dev") : packageRunCommand(pm, "start");
    let buildCommand = hasBuild ? packageRunCommand(pm, "build") : undefined;
    let skipBuild = false;
    let reason = rel === "." ? "root package" : `workspace package ${rel}`;

    if (deps.electron || deps["electron-vite"] || /electron(-vite)?\b/i.test(scriptText)) {
      score = 100;
      kind = "electron";
      command = packageDevCommand(pm, "electron");
      buildCommand = undefined;
      skipBuild = true;
      reason = `Electron package ${rel}`;
    } else if (deps.vitepress || /vitepress\b/i.test(scriptText)) {
      score = 80;
      kind = "web";
      command = packageDevCommand(pm, "web");
      reason = `VitePress package ${rel}`;
    } else if (deps.next) {
      // Next.js needs its own launch command — its CLI rejects the Vite-style
      // `--host/--port` flags, and going through the repo's npm script breaks on
      // a forwarded `--` plus a hard-coded port. See nextLaunchCommand().
      score = 70;
      kind = "web";
      command = nextLaunchCommand(pm, hasBuild);
      reason = `Next.js package ${rel}`;
    } else if (deps.vite) {
      // Vite needs its own launch command: a generated wrapper config that
      // allows the proxied Host header (Vite 5.x has no --allowedHosts flag).
      // See viteLaunchCommand() / writeViteHostWrapper().
      score = 70;
      kind = "web";
      command = viteLaunchCommand(pm);
      reason = `Vite package ${rel}`;
    } else if (deps.astro || deps.nuxt || deps["@sveltejs/kit"]) {
      score = 70;
      kind = "web";
      command = packageDevCommand(pm, "web");
      reason = `web package ${rel}`;
    } else if (hasStart || hasDev) {
      score = rel === "." ? 30 : 45;
      kind = "node";
      command = hasStart ? packageRunCommand(pm, "start") : packageRunCommand(pm, "dev");
    }

    if (score === 0) continue;
    score += nameBonus;
    if (inNonAppDir) score -= 50;
    if (relNorm.includes("apps/desktop")) score += 5;
    if (relNorm.includes("website") && kind === "web") score += 3;
    if (matchesName) reason += ` (matches service name "${serviceName}")`;

    const target = { kind, workingDir: dir, command, buildCommand, skipBuild, reason };
    if (!best || score > best.score) best = { score, target };
  }

  return (
    best?.target ?? {
      kind: "node",
      workingDir: projectPath,
      command: nodeStartCommand(packageManager),
      buildCommand: nodeBuildCommand(packageManager),
      reason: "root package fallback"
    }
  );
}

function emitBuildLog(
  ctx: AppContext,
  serviceId: string,
  deploymentId: string,
  line: string,
  stream: "stdout" | "stderr" = "stdout"
): void {
  if (!line) return;
  broadcast(ctx, {
    type: "build_log",
    serviceId,
    deploymentId,
    line,
    stream,
    timestamp: nowIso()
  });
}

function emitProgress(ctx: AppContext, serviceId: string, deploymentId: string, phase: DeployPhase): void {
  broadcast(ctx, {
    type: "build_progress",
    serviceId,
    deploymentId,
    phase,
    timestamp: nowIso()
  });
}

export async function runBuildPipeline(
  ctx: AppContext,
  serviceId: string,
  projectPath: string,
  opts: {
    deploymentId?: string;
    onPhase?: (phase: DeployPhase) => void;
    nodeTarget?: NodeLaunchTarget;
    pythonDir?: string;
  } = {}
): Promise<{ status: "success" | "failed"; buildLog: string; artifactPath: string }> {
  const deploymentId = opts.deploymentId;
  // Build with the SAME env the runtime gets (project env + linked DATABASE_URL
  // + service env), so build-time-inlined vars (VITE_*, NEXT_PUBLIC_*, SSG data)
  // match what the running service expects instead of silently differing.
  // sanitizedHostEnv() keeps the control-plane secrets (SURVHUB_SECRET_KEY etc.)
  // out of every npm/pip/docker build — a postinstall script in an untrusted
  // dependency would otherwise read the master key that decrypts other services.
  const env = { ...sanitizedHostEnv(), ...getServiceEnvWithLinks(ctx, serviceId) };
  const serviceBuild = ctx.db.prepare("SELECT dockerfile FROM services WHERE id = ?").get(serviceId) as
    | { dockerfile?: string }
    | undefined;
  const dockerfile = String(serviceBuild?.dockerfile ?? "").trim();
  const buildType = resolveBuildType(projectPath);
  let buildLog = `Detected build type: ${buildType}\n`;
  let artifactPath = projectPath;

  const stream = (chunk: string, s: "stdout" | "stderr") => {
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, chunk, s);
  };

  if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, buildLog, "stdout");

  if (buildType === "node") {
    const rootPackageManager = detectNodePackageManager(projectPath);
    const nodeTarget = opts.nodeTarget ?? detectNodeLaunchTarget(projectPath, "", rootPackageManager);
    const buildCwd = nodeTarget.workingDir || projectPath;
    // Install where the app actually resolves its node_modules: inside the
    // launch target for a nested app, or at the workspace root for a member.
    // Installing at projectPath while the app lives in a subdirectory leaves the
    // app without its deps (e.g. Vite) and crash-loops at "Cannot find package".
    const installCwd = resolveInstallCwd(projectPath, buildCwd);
    const packageManager = targetPackageManager(projectPath, buildCwd, rootPackageManager);
    const installCommands = nodeInstallCommands(packageManager, installCwd);
    const buildCommand = nodeTarget.buildCommand ?? nodeBuildCommand(packageManager);
    const targetRel = path.relative(projectPath, nodeTarget.workingDir) || ".";
    const installRel = path.relative(projectPath, installCwd) || ".";
    const versionWarning = nodeVersionWarning(buildCwd) ?? nodeVersionWarning(projectPath);
    buildLog += `Detected package manager: ${packageManager}\n`;
    buildLog += `Selected launch target: ${targetRel} (${nodeTarget.reason})\n`;
    buildLog += `Installing dependencies in: ${installRel}\n`;
    if (versionWarning) buildLog += versionWarning;
    if (deploymentId)
      emitBuildLog(ctx, serviceId, deploymentId, `Detected package manager: ${packageManager}\n`);
    if (deploymentId)
      emitBuildLog(
        ctx,
        serviceId,
        deploymentId,
        `Selected launch target: ${targetRel} (${nodeTarget.reason})\n`
      );
    if (deploymentId)
      emitBuildLog(ctx, serviceId, deploymentId, `Installing dependencies in: ${installRel}\n`);
    if (versionWarning && deploymentId)
      emitBuildLog(ctx, serviceId, deploymentId, versionWarning, "stderr");

    // Make incompatible native deps (e.g. better-sqlite3@9 on Node 25) build out
    // of the box: rewrite their pins to host-compatible ranges before install,
    // rather than dying in node-gyp with a cryptic C++ error. Both the install
    // root and the launch target are checked (the dep may live in a workspace
    // member that installs from the root).
    for (const remediationDir of Array.from(new Set([installCwd, buildCwd]))) {
      for (const note of remediateNativeDeps(remediationDir)) {
        buildLog += note + "\n";
        if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, note + "\n", "stdout");
      }
    }

    opts.onPhase?.("installing");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "installing");
    for (const installCommand of installCommands) {
      if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${installCommand}\n`, "stdout");
      const install = await runCommand(installCommand, installCwd, env, {
        onChunk: stream,
        timeoutMs: NODE_INSTALL_TIMEOUT_MS
      });
      buildLog += `\n$ ${installCommand}\n${install.output}\n`;
      // `npm rebuild` failing means a native addon couldn't compile for this
      // host (e.g. better-sqlite3 vs Node's V8 ABI) — fail the deploy with the
      // error in the log rather than starting an app that will crash on require.
      if (install.code !== 0) return { status: "failed", buildLog, artifactPath };
    }

    // A Vite launch command runs against a generated wrapper config that allows
    // the proxied Host header — write it now (before the service starts), and
    // rewrite it every deploy so it survives the reset-to-origin and tracks any
    // rename of the user's own vite config.
    if (nodeTarget.command.includes(VITE_HOST_WRAPPER)) {
      writeViteHostWrapper(buildCwd);
      const msg = `Wrote ${VITE_HOST_WRAPPER} so the Vite dev server accepts the proxied host.\n`;
      buildLog += msg;
      if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stdout");
    }

    if (nodeTarget.skipBuild) {
      const msg = `\nSkipping package build for ${nodeTarget.reason}; the launch command performs its own development build.\n`;
      buildLog += msg;
      if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stdout");
      return { status: "success", buildLog, artifactPath };
    }

    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");

    // When the launch target is a workspace member, build its workspace-
    // dependency closure first (run at the workspace root, in topological
    // order) so every sibling package it imports has emitted its dist/ before
    // the member's own build resolves them. Skipped for the repo root itself
    // and for non-workspace nested apps.
    const isWorkspaceMember =
      isWorkspaceRoot(projectPath) && path.resolve(buildCwd) !== path.resolve(projectPath);
    if (isWorkspaceMember) {
      const depBuildCommand = workspaceDepBuildCommand(packageManager, buildCwd, projectPath);
      if (depBuildCommand) {
        if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${depBuildCommand}\n`, "stdout");
        const depBuild = await runCommand(depBuildCommand, projectPath, env, {
          onChunk: stream,
          timeoutMs: NODE_INSTALL_TIMEOUT_MS
        });
        buildLog += `\n$ ${depBuildCommand}\n${depBuild.output}\n`;
        if (depBuild.code !== 0) return { status: "failed", buildLog, artifactPath };
      }
    }

    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${buildCommand}\n`, "stdout");
    const build = await runCommand(buildCommand, buildCwd, env, {
      onChunk: stream,
      timeoutMs: NODE_INSTALL_TIMEOUT_MS
    });
    buildLog += `\n$ ${buildCommand}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    if (fs.existsSync(path.join(buildCwd, "dist"))) artifactPath = path.join(buildCwd, "dist");
  } else if (buildType === "python") {
    opts.onPhase?.("installing");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "installing");
    // Install in the directory that actually holds the Python project — which
    // may be a subdir, not the repo root — so the deps land next to the app.
    const pythonCwd = opts.pythonDir ?? findPythonProjectDir(projectPath) ?? projectPath;
    const installRel = path.relative(projectPath, pythonCwd) || ".";
    const base = pythonBaseExe();
    const venvPyAbs = path.join(pythonCwd, VENV_PY_REL);
    const vpy = JSON.stringify(venvPyAbs);
    const emit = (line: string, s: "stdout" | "stderr" = "stdout") => {
      buildLog += line;
      if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, line, s);
    };
    emit(`Installing Python dependencies in: ${installRel}\n`);

    // 1) Per-project venv so installs don't hit PEP 668 ("externally-managed
    //    environment") on Homebrew/Debian and don't pollute global site-packages.
    if (!fs.existsSync(venvPyAbs)) {
      emit(`\n$ ${base} -m venv .venv\n`);
      const mk = await runCommand(`${base} -m venv .venv`, pythonCwd, env, {
        onChunk: stream,
        timeoutMs: NODE_INSTALL_TIMEOUT_MS
      });
      buildLog += mk.output + "\n";
      if (mk.code !== 0) return { status: "failed", buildLog, artifactPath };
    }

    // 2) Install project deps using the venv interpreter.
    const projInstall = fs.existsSync(path.join(pythonCwd, "requirements.txt"))
      ? `${vpy} -m pip install -r requirements.txt`
      : `${vpy} -m pip install .`;
    const installCmd = `${vpy} -m pip install --upgrade pip && ${projInstall}`;
    emit(`\n$ ${projInstall}\n`);
    const install = await runCommand(installCmd, pythonCwd, env, {
      onChunk: stream,
      timeoutMs: NODE_INSTALL_TIMEOUT_MS
    });
    buildLog += install.output + "\n";
    if (install.code !== 0) return { status: "failed", buildLog, artifactPath };

    // 3) Ensure the server the run command needs (uvicorn/gunicorn) is present.
    const serverPkg = pythonServerPackage(pythonCwd);
    if (serverPkg) {
      emit(`\n$ ${serverPkg} (ensuring server is installed)\n`);
      const ensure = await runCommand(`${vpy} -m pip install ${serverPkg}`, pythonCwd, env, {
        onChunk: stream,
        timeoutMs: NODE_INSTALL_TIMEOUT_MS
      });
      buildLog += ensure.output + "\n"; // non-fatal: may already be a project dep
    }
  } else if (buildType === "godot") {
    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    const exportPath = parseGodotWebExportPath(projectPath);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    const godot = await ensureGodotWebExportTemplates(projectPath, env, stream);
    const command = `${godot} --headless --path . --export-release Web ${JSON.stringify(exportPath)}`;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${command}\n`, "stdout");
    const build = await runCommand(command, projectPath, env, {
      timeoutMs: 240000,
      onChunk: stream
    });
    buildLog += `\n$ ${command}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    artifactPath = path.dirname(exportPath);
  } else if (buildType === "static") {
    const staticDir = findStaticEntry(projectPath);
    artifactPath = staticDir ?? projectPath;
    const msg = `Static site detected at ${path.relative(projectPath, artifactPath) || "."}; no build step required.\n`;
    buildLog += msg;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stdout");
  } else if (buildType === "docker") {
    opts.onPhase?.("building");
    if (deploymentId) emitProgress(ctx, serviceId, deploymentId, "building");
    const imageSafeServiceId = serviceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    const imageTag = `survhub-build-${imageSafeServiceId}:latest`;
    const dockerfileArg = dockerfile ? ` -f ${JSON.stringify(dockerfile)}` : "";
    const buildCommand = `docker build${dockerfileArg} -t ${imageTag} .`;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, `\n$ ${buildCommand}\n`, "stdout");
    const build = await runCommand(buildCommand, projectPath, env, {
      timeoutMs: 240000,
      onChunk: stream
    });
    buildLog += `\n$ ${buildCommand}\n${build.output}\n`;
    if (build.code !== 0) return { status: "failed", buildLog, artifactPath };
    ctx.db
      .prepare("UPDATE services SET docker_image = ?, updated_at = ? WHERE id = ?")
      .run(imageTag, nowIso(), serviceId);
  } else if (buildType === "unknown") {
    const msg =
      "\nNo Dockerfile, package.json, Python markers, Godot project, or static index.html found. Cannot deploy this repository layout.\n";
    buildLog += msg;
    if (deploymentId) emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
    return { status: "failed", buildLog, artifactPath };
  }

  return { status: "success", buildLog, artifactPath };
}

export function deployFromGit(
  ctx: AppContext,
  serviceId: string,
  repoUrl: string,
  branch: string = "main",
  trigger: DeployTrigger = "manual"
) {
  // Serialize per service against other deploys AND start/stop/restart, so a
  // poller tick, a webhook, and a manual redeploy can't run concurrent git
  // pulls / installs in the same working tree and corrupt it. Throws
  // "Service action already in progress" if something else holds the lock.
  return withLock(ctx, serviceId, () =>
    deployFromGitLocked(ctx, serviceId, repoUrl, branch, trigger)
  );
}

async function deployFromGitLocked(
  ctx: AppContext,
  serviceId: string,
  repoUrl: string,
  branch: string = "main",
  trigger: DeployTrigger = "manual"
) {
  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const gitEnv = buildGitEnv(ctx);
  const git = simpleGit().env(gitEnv as Record<string, string>);
  const authedUrl = injectGitCredentials(ctx, repoUrl);
  let buildLog = "";
  let commitHash = "";
  let status: "success" | "failed" = "success";
  let artifactPath = targetPath;

  const deploymentId = nanoid();
  const startedAt = nowIso();

  // Pre-create the deployment row so the UI can observe in-flight state.
  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(deploymentId, serviceId, "", "running", "", targetPath, startedAt, startedAt, branch, trigger);

  emitProgress(ctx, serviceId, deploymentId, "cloning");
  transition(ctx, deploymentId, "cloning");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch, trigger });

  let failureStage: "queued" | "cloning" | "building" | "starting" | "unknown" = "unknown";
  try {
    failureStage = "cloning";
    if (fs.existsSync(path.join(targetPath, ".git"))) {
      // Reset origin URL so an updated PAT or switched remote takes effect.
      try {
        await git.cwd(targetPath).remote(["set-url", "origin", authedUrl]);
      } catch {
        /* first-time */
      }
      await git.cwd(targetPath).fetch(["origin", branch]);
      // Force the working tree to EXACTLY match the remote branch instead of
      // merging. A plain `pull` aborts on a dirty tree — and our own native-dep
      // remediation (remediateNativeDeps) leaves backend/package.json + the lock
      // modified after every build — so the next deploy died with "Your local
      // changes would be overwritten by merge". `checkout -f` + `reset --hard` is
      // the correct deploy semantic (deploy = exact remote state) and is
      // idempotent with remediation, which re-applies during the build.
      await git.cwd(targetPath).raw(["checkout", "-f", branch]);
      await git.cwd(targetPath).reset(["--hard", `origin/${branch}`]);
      buildLog += `Reset working tree to origin/${branch} (deploy = exact remote state).\n`;
      emitBuildLog(ctx, serviceId, deploymentId, `Reset working tree to origin/${branch}.\n`);
    } else {
      await git.clone(authedUrl, targetPath, ["--branch", branch]);
      buildLog += `Cloned repository branch: ${branch}.\n`;
      emitBuildLog(ctx, serviceId, deploymentId, `Cloned repository branch: ${branch}.\n`);
    }
    const buildType = resolveBuildType(targetPath);
    const preferredDockerfile =
      buildType === "docker"
        ? fs.existsSync(path.join(targetPath, "Dockerfile.frontend"))
          ? "Dockerfile.frontend"
          : (findDockerfile(targetPath) ?? "")
        : "";
    const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
      | { name?: string }
      | undefined;
    const nodeTarget =
      buildType === "node" ? detectNodeLaunchTarget(targetPath, service?.name ?? "") : undefined;
    const pythonDir = buildType === "python" ? (findPythonProjectDir(targetPath) ?? targetPath) : undefined;
    const inferred = inferServiceRuntimeDefaults(buildType, nodeTarget?.workingDir ?? pythonDir ?? targetPath);
    const runtimeWorkingDir = nodeTarget?.workingDir ?? pythonDir ?? targetPath;
    const runtimeCommand =
      nodeTarget?.command ?? (pythonDir ? pythonEntryCommand(pythonDir) : inferred.command);
    // Persist only the dockerfile up front — the docker build step reads it.
    // type/command/working_dir are written ONLY after a successful build (below)
    // so a failed deploy doesn't overwrite the last-good runtime config with a
    // broken target that the next start would then try (and fail) to run.
    ctx.db
      .prepare("UPDATE services SET dockerfile = ?, updated_at = ? WHERE id = ?")
      .run(preferredDockerfile, nowIso(), serviceId);
    commitHash = (await git.cwd(targetPath).revparse(["HEAD"])).trim();
    failureStage = "building";
    transition(ctx, deploymentId, "building", { gitSha: commitHash });
    const result = await runBuildPipeline(ctx, serviceId, targetPath, {
      deploymentId,
      nodeTarget,
      pythonDir
    });
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
    if (status === "success") {
      if (buildType === "godot" || buildType === "static") {
        ctx.db
          .prepare(
            "UPDATE services SET type = 'static', command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
          )
          .run(staticServeCommand(), artifactPath, nowIso(), serviceId);
      } else {
        ctx.db
          .prepare(
            "UPDATE services SET type = ?, command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
          )
          .run(inferred.type, runtimeCommand, runtimeWorkingDir, nowIso(), serviceId);
      }
      transition(ctx, deploymentId, "starting", { gitSha: commitHash });
    }
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  if (status === "success") {
    transition(ctx, deploymentId, "healthy", { gitSha: commitHash });
    recordDeployDuration(ctx, serviceId, durationMs);
  } else {
    markFailed(ctx, deploymentId, failureStage);
    recordDeployFailure(ctx, serviceId, failureStage);
  }

  ctx.db
    .prepare(
      `UPDATE deployments
     SET commit_hash = ?, status = ?, build_log = ?, artifact_path = ?, finished_at = ?, duration_ms = ?, git_sha = COALESCE(git_sha, ?)
     WHERE id = ?`
    )
    .run(commitHash, status, buildLog, artifactPath, finishedAt, durationMs, commitHash, deploymentId);

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId,
    status,
    durationMs
  });

  return {
    id: deploymentId,
    service_id: serviceId,
    commit_hash: commitHash,
    status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch,
    trigger_source: trigger
  };
}

/** Sync DB status and optional autostart after deployFromGit (GitHub deploy or redeploy). */
export async function applyPostDeployServiceState(
  ctx: AppContext,
  serviceId: string,
  deployment: { status: string; build_log: string },
  options: { startAfterDeploy: boolean }
): Promise<void> {
  const svcRow = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
    | { name?: string }
    | undefined;
  const serviceName = svcRow?.name ?? serviceId;
  if (deployment.status === "success") {
    createNotification(ctx, {
      kind: "deployment",
      severity: "success",
      title: `Deployment succeeded: ${serviceName}`,
      serviceId
    });
    if (options.startAfterDeploy) {
      try {
        await startService(ctx, serviceId);
      } catch (error) {
        updateServiceStatus(ctx, serviceId, "stopped");
        insertLog(ctx, serviceId, "error", `Start after deploy failed: ${serializeError(error)}`);
      }
    } else {
      updateServiceStatus(ctx, serviceId, "stopped");
    }
  } else {
    updateServiceStatus(ctx, serviceId, "stopped");
    const log = deployment.build_log ?? "";
    const snippet = log.length > 2000 ? `${log.slice(0, 2000)}…` : log;
    insertLog(ctx, serviceId, "error", snippet ? `Deploy failed:\n${snippet}` : "Deploy failed.");
    createNotification(ctx, {
      kind: "deployment",
      severity: "error",
      title: `Deployment failed: ${serviceName}`,
      body: snippet.slice(0, 400),
      serviceId
    });
  }
}

/** Stop a running service before redeploying so git can update files safely. */
export async function stopServiceIfRunning(ctx: AppContext, serviceId: string): Promise<void> {
  const row = ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(serviceId) as
    | { status?: string }
    | undefined;
  if (row?.status === "running") {
    await stopService(ctx, serviceId);
  }
}

function nodeStartCommand(pm: NodePackageManager): string {
  if (pm === "pnpm") return "pnpm run start";
  if (pm === "yarn") return "yarn run start";
  if (pm === "bun") return "bun run start";
  return "npm run start";
}

export function inferServiceRuntimeDefaults(
  buildType: ReturnType<typeof detectBuildType>,
  projectPath?: string
): {
  type: "process" | "docker" | "static";
  command: string;
} {
  if (buildType === "docker") {
    return { type: "docker", command: "" };
  }
  if (buildType === "python") {
    return { type: "process", command: "python app.py" };
  }
  if (buildType === "node") {
    const packageManager = projectPath ? detectNodePackageManager(projectPath) : "npm";
    return { type: "process", command: nodeStartCommand(packageManager) };
  }
  if (buildType === "godot" || buildType === "static") {
    return { type: "static", command: staticServeCommand() };
  }
  return { type: "process", command: "" };
}

export async function deployFromLocalPath(
  ctx: AppContext,
  serviceId: string,
  localPath: string,
  trigger: DeployTrigger = "manual",
  options: { command?: string } = {}
) {
  if (!fs.existsSync(localPath)) throw new Error(`Local path does not exist: ${localPath}`);
  if (!fs.statSync(localPath).isDirectory()) throw new Error(`Path is not a directory: ${localPath}`);

  const deploymentId = nanoid();
  const startedAt = nowIso();
  let buildLog = `Source: local directory ${localPath}\n`;
  let status: "success" | "failed" = "success";
  let artifactPath = localPath;

  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(deploymentId, serviceId, "", "running", "", localPath, startedAt, startedAt, null, trigger);

  emitProgress(ctx, serviceId, deploymentId, "installing");
  broadcast(ctx, { type: "deployment_started", serviceId, deploymentId, branch: null, trigger });

  try {
    const buildType = resolveBuildType(localPath);
    const service = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
      | { name?: string }
      | undefined;
    const nodeTarget =
      buildType === "node" ? detectNodeLaunchTarget(localPath, service?.name ?? "") : undefined;
    const pythonDir = buildType === "python" ? (findPythonProjectDir(localPath) ?? localPath) : undefined;
    const inferred = inferServiceRuntimeDefaults(buildType, nodeTarget?.workingDir ?? pythonDir ?? localPath);
    const detectedCommand =
      nodeTarget?.command ?? (pythonDir ? pythonEntryCommand(pythonDir) : inferred.command);
    const command = options.command !== undefined ? options.command : detectedCommand;
    ctx.db
      .prepare("UPDATE services SET type = ?, command = ?, working_dir = ?, updated_at = ? WHERE id = ?")
      .run(inferred.type, command, nodeTarget?.workingDir ?? pythonDir ?? localPath, nowIso(), serviceId);

    emitBuildLog(ctx, serviceId, deploymentId, `Detected build type: ${buildType}\n`);
    const result = await runBuildPipeline(ctx, serviceId, localPath, { deploymentId, nodeTarget, pythonDir });
    status = result.status;
    buildLog += result.buildLog;
    artifactPath = result.artifactPath;
    if (status === "success" && (buildType === "godot" || buildType === "static")) {
      ctx.db
        .prepare(
          "UPDATE services SET type = 'static', command = ?, working_dir = ?, updated_at = ? WHERE id = ?"
        )
        .run(staticServeCommand(), artifactPath, nowIso(), serviceId);
    }
  } catch (error) {
    status = "failed";
    const msg = `Deploy failed: ${error instanceof Error ? error.message : String(error)}\n`;
    buildLog += msg;
    emitBuildLog(ctx, serviceId, deploymentId, msg, "stderr");
  }

  const finishedAt = nowIso();
  emitProgress(ctx, serviceId, deploymentId, status === "success" ? "done" : "failed");

  ctx.db
    .prepare(
      `UPDATE deployments SET status = ?, build_log = ?, artifact_path = ?, finished_at = ? WHERE id = ?`
    )
    .run(status, buildLog, artifactPath, finishedAt, deploymentId);

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId,
    status,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  });

  return {
    id: deploymentId,
    service_id: serviceId,
    commit_hash: "",
    status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch: null,
    trigger_source: trigger
  };
}

export function rollbackDeployment(ctx: AppContext, serviceId: string, deploymentId: string) {
  // Same per-service serialization as deployFromGit — a rollback does a git
  // checkout + rebuild and must not race a concurrent deploy/start/stop.
  return withLock(ctx, serviceId, () => rollbackDeploymentLocked(ctx, serviceId, deploymentId));
}

async function rollbackDeploymentLocked(ctx: AppContext, serviceId: string, deploymentId: string) {
  const deployment = ctx.db
    .prepare("SELECT commit_hash, artifact_path, branch FROM deployments WHERE id = ? AND service_id = ?")
    .get(deploymentId, serviceId) as
    | { commit_hash?: string; artifact_path?: string; branch?: string }
    | undefined;
  if (!deployment?.commit_hash) throw new Error("Deployment not found");

  await stopServiceIfRunning(ctx, serviceId);

  const newDeployId = nanoid();
  const startedAt = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO deployments
     (id, service_id, commit_hash, status, build_log, artifact_path, created_at, started_at, branch, trigger_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newDeployId,
      serviceId,
      deployment.commit_hash,
      "running",
      "",
      deployment.artifact_path ?? "",
      startedAt,
      startedAt,
      deployment.branch ?? null,
      "rollback"
    );
  emitProgress(ctx, serviceId, newDeployId, "building");
  broadcast(ctx, {
    type: "deployment_started",
    serviceId,
    deploymentId: newDeployId,
    branch: deployment.branch ?? null,
    trigger: "rollback"
  });
  emitBuildLog(ctx, serviceId, newDeployId, `Rollback to ${deployment.commit_hash}\n`);

  const targetPath = path.join(ctx.config.projectsDir, serviceId);
  const git = simpleGit(targetPath);
  await git.checkout(deployment.commit_hash);
  // Re-detect the launch target WITH the service name so a repo containing more
  // than one launchable app resolves to the same package this service uses —
  // otherwise the empty-name fallback could install/build a different sub-app.
  const buildType = resolveBuildType(targetPath);
  const svc = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
    | { name?: string }
    | undefined;
  const nodeTarget =
    buildType === "node" ? detectNodeLaunchTarget(targetPath, svc?.name ?? "") : undefined;
  const pythonDir = buildType === "python" ? (findPythonProjectDir(targetPath) ?? targetPath) : undefined;
  const result = await runBuildPipeline(ctx, serviceId, targetPath, {
    deploymentId: newDeployId,
    nodeTarget,
    pythonDir
  });

  const buildLog = `Rollback to ${deployment.commit_hash}\n${result.buildLog}`;
  const finishedAt = nowIso();
  const artifactPath = deployment.artifact_path ?? result.artifactPath;
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  emitProgress(ctx, serviceId, newDeployId, result.status === "success" ? "done" : "failed");

  // Record canonical state on the new (rollback) deployment row, plus mark
  // the source deployment as rolled_back so the timeline reflects intent.
  if (result.status === "success") {
    transition(ctx, newDeployId, "rolled_back", { gitSha: deployment.commit_hash });
  } else {
    markFailed(ctx, newDeployId, "building");
  }
  transition(ctx, deploymentId, "rolled_back");

  ctx.db
    .prepare(
      `UPDATE deployments
     SET status = ?, build_log = ?, artifact_path = ?, finished_at = ?, duration_ms = ?, git_sha = COALESCE(git_sha, ?)
     WHERE id = ?`
    )
    .run(
      result.status === "success" ? "rolled_back" : "failed",
      buildLog,
      artifactPath,
      finishedAt,
      durationMs,
      deployment.commit_hash,
      newDeployId
    );

  broadcast(ctx, {
    type: "deployment_finished",
    serviceId,
    deploymentId: newDeployId,
    status: result.status,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  });

  const row = {
    id: newDeployId,
    service_id: serviceId,
    commit_hash: deployment.commit_hash,
    status: result.status,
    build_log: buildLog,
    artifact_path: artifactPath,
    created_at: startedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    branch: deployment.branch ?? null,
    trigger_source: "rollback" as const
  };
  await applyPostDeployServiceState(ctx, serviceId, row, { startAfterDeploy: false });
  return row;
}
