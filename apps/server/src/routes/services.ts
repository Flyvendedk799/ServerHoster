import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import yaml from "js-yaml";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso, parsePortMapping, findFreePort } from "../lib/core.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security.js";
import { getDependents, restartService, startService, stopService } from "../services/runtime.js";
import { insertLog } from "../lib/core.js";
import { applyPostDeployServiceState, deployFromGit, deployFromLocalPath } from "../services/deploy.js";

const serviceSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  type: z.enum(["process", "docker", "static"]),
  command: z.string().optional(),
  workingDir: z.string().optional(),
  dockerImage: z.string().optional(),
  dockerfile: z.string().optional(),
  port: z.number().int().optional(),
  autoRestart: z.boolean().default(true),
  maxRestarts: z.number().int().default(5),
  startMode: z.enum(["manual", "auto"]).default("manual"),
  healthcheckPath: z.string().optional(),
  quickTunnelEnabled: z.number().int().min(0).max(1).default(0).optional()
});

const envSchema = z.object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().default(false) });
const composeImportSchema = z.object({
  projectId: z.string(),
  composeFilePath: z.string().optional(),
  composeContent: z.string().optional(),
  workingDir: z.string().optional()
});
const directDeploySchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  repoUrl: z.string().url(),
  branch: z.string().default("main"),
  port: z.number().int().optional(),
  startAfterDeploy: z.boolean().default(false),
  domain: z.string().optional(),
  autoPull: z.boolean().default(true),
  enableQuickTunnel: z.boolean().default(false)
});

const localDeploySchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  localPath: z.string().min(1),
  command: z.string().optional(),
  port: z.number().int().optional(),
  startAfterDeploy: z.boolean().default(false),
  enableQuickTunnel: z.boolean().default(false)
});

const localProjectScanSchema = z.object({
  localPath: z.string().min(1)
});

type DevServerCandidate = {
  id: string;
  label: string;
  command: string;
  source: string;
  port?: number;
  recommended?: boolean;
};

function normalizeProjectName(localPath: string): string {
  return path.basename(localPath).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "local-app";
}

function extractPort(command: string): number | undefined {
  const envMatch = command.match(/\bPORT=(\d{2,5})\b/);
  if (envMatch) return Number(envMatch[1]);
  const flagMatch = command.match(/(?:--port|-p)\s+(\d{2,5})\b/);
  if (flagMatch) return Number(flagMatch[1]);
  return undefined;
}

function pushCandidate(candidates: DevServerCandidate[], candidate: DevServerCandidate): void {
  if (candidates.some((item) => item.command === candidate.command)) return;
  candidates.push(candidate);
}

function scanLocalProject(localPath: string): {
  name: string;
  buildType: string;
  candidates: DevServerCandidate[];
  warnings: string[];
  files: string[];
} {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) throw new Error(`Local path does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);

  const files = fs.readdirSync(resolved).slice(0, 200);
  const candidates: DevServerCandidate[] = [];
  const warnings: string[] = [];
  const packagePath = path.join(resolved, "package.json");
  const hasDockerfile = files.includes("Dockerfile");
  const hasRequirements = files.includes("requirements.txt");
  const hasPyproject = files.includes("pyproject.toml");

  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const preferred = ["dev", "start", "serve", "preview", "watch"];
      for (const scriptName of preferred) {
        if (!scripts[scriptName]) continue;
        const command = `npm run ${scriptName}`;
        pushCandidate(candidates, {
          id: `npm-${scriptName}`,
          label: `npm script: ${scriptName}`,
          command,
          source: scripts[scriptName],
          port: extractPort(scripts[scriptName]),
          recommended: candidates.length === 0 && (scriptName === "dev" || scriptName === "start")
        });
      }
      for (const [scriptName, scriptValue] of Object.entries(scripts)) {
        if (preferred.includes(scriptName)) continue;
        if (!/(dev|serve|start|preview|watch|server)/i.test(scriptName) && !/(vite|next|astro|nuxt|remix|svelte|serve|node|tsx|ts-node)/i.test(scriptValue)) continue;
        pushCandidate(candidates, {
          id: `npm-${scriptName}`,
          label: `npm script: ${scriptName}`,
          command: `npm run ${scriptName}`,
          source: scriptValue,
          port: extractPort(scriptValue)
        });
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.vite && !candidates.some((item) => item.command === "npm run dev")) {
        pushCandidate(candidates, { id: "vite-dev", label: "Vite dev server", command: "npm run dev", source: "vite", port: 5173, recommended: true });
      }
      if (deps.next && !candidates.some((item) => item.command === "npm run dev")) {
        pushCandidate(candidates, { id: "next-dev", label: "Next.js dev server", command: "npm run dev", source: "next dev", port: 3000, recommended: true });
      }
    } catch (error) {
      warnings.push(`package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (hasRequirements || hasPyproject) {
    if (files.includes("main.py")) {
      pushCandidate(candidates, { id: "python-main", label: "Python app", command: "python main.py", source: "main.py", recommended: candidates.length === 0 });
    }
    if (files.includes("app.py")) {
      pushCandidate(candidates, { id: "python-app", label: "Python app", command: "python app.py", source: "app.py", recommended: candidates.length === 0 });
    }
    if (files.includes("manage.py")) {
      pushCandidate(candidates, { id: "django", label: "Django dev server", command: "python manage.py runserver 0.0.0.0:$PORT", source: "manage.py", port: 8000 });
    }
    if (files.includes("main.py") || files.includes("app.py")) {
      const moduleName = files.includes("main.py") ? "main" : "app";
      pushCandidate(candidates, { id: "uvicorn", label: "Uvicorn ASGI server", command: `python -m uvicorn ${moduleName}:app --host 0.0.0.0 --port $PORT`, source: `${moduleName}.py`, port: 8000 });
    }
  }

  if (hasDockerfile) {
    pushCandidate(candidates, { id: "docker", label: "Dockerfile", command: "", source: "Dockerfile", recommended: candidates.length === 0 });
  }

  if (candidates.length === 0) {
    warnings.push("No obvious dev server script was found. Add a command manually before launching.");
  }

  const buildType = hasDockerfile ? "docker" : fs.existsSync(packagePath) ? "node" : hasRequirements || hasPyproject ? "python" : "unknown";
  return {
    name: normalizeProjectName(resolved),
    buildType,
    candidates,
    warnings,
    files
  };
}

export function registerServiceRoutes(ctx: AppContext): void {
  ctx.app.get("/services", async () => {
    return ctx.db.prepare(`
      SELECT
        s.*,
        p.domain,
        (SELECT commit_hash FROM deployments d WHERE d.service_id = s.id AND d.status = 'success' ORDER BY d.created_at DESC LIMIT 1) as latest_commit_hash
      FROM services s
      LEFT JOIN proxy_routes p ON p.service_id = s.id
      ORDER BY s.created_at DESC
    `).all();
  });

  ctx.app.get("/services/:id", async (req) => {
    const { id } = req.params as { id: string };
    const service = ctx.db.prepare(`
      SELECT s.*, p.domain
      FROM services s
      LEFT JOIN proxy_routes p ON p.service_id = s.id
      WHERE s.id = ?
    `).get(id);
    if (!service) throw new Error("Service not found");
    return service;
  });

  ctx.app.post("/services/scan-local-project", async (req) => {
    const p = localProjectScanSchema.parse(req.body);
    return scanLocalProject(p.localPath);
  });

  ctx.app.post("/services/deploy-from-local", async (req) => {
    const p = localDeploySchema.parse(req.body);
    const createdAt = nowIso();
    const serviceId = nanoid();
    const assignedPort = p.port ?? await findFreePort(3000, 3999);

    ctx.db.prepare(`INSERT INTO services (
      id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
      auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at, quick_tunnel_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        serviceId, p.projectId, p.name,
        "process", "", p.localPath, "", "",
        assignedPort, "building",
        1, 0, 5, "manual",
        createdAt, createdAt,
        p.enableQuickTunnel ? 1 : 0
      );

    const deployment = await deployFromLocalPath(ctx, serviceId, p.localPath, "manual", { command: p.command });
    await applyPostDeployServiceState(ctx, serviceId, deployment, { startAfterDeploy: p.startAfterDeploy });

    if (p.enableQuickTunnel && p.startAfterDeploy && deployment.status === "success") {
      try {
        const { startQuickTunnel } = await import("../services/cloudflare.js");
        startQuickTunnel(ctx, serviceId, assignedPort);
      } catch (err) {
        insertLog(ctx, serviceId, "warn", `Quick tunnel start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
    return { service, deployment };
  });

  ctx.app.post("/services", async (req) => {
    const p = serviceSchema.parse(req.body);
    const assignedPort = p.port ?? await findFreePort(3000, 3999);
    const row = {
      id: nanoid(),
      project_id: p.projectId,
      name: p.name,
      type: p.type,
      command: p.command ?? "",
      working_dir: p.workingDir ?? "",
      docker_image: p.dockerImage ?? "",
      dockerfile: p.dockerfile ?? "",
      port: assignedPort,
      status: "stopped",
      auto_restart: p.autoRestart ? 1 : 0,
      restart_count: 0,
      max_restarts: p.maxRestarts,
      healthcheck_path: p.healthcheckPath ?? "",
      start_mode: p.startMode,
      quick_tunnel_enabled: p.quickTunnelEnabled ?? 0,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    ctx.db.prepare(`INSERT INTO services (
      id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
      auto_restart, restart_count, max_restarts, healthcheck_path, start_mode, quick_tunnel_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.project_id, row.name, row.type, row.command, row.working_dir, row.docker_image, row.dockerfile, row.port,
        row.status, row.auto_restart, row.restart_count, row.max_restarts, row.healthcheck_path, row.start_mode,
        row.quick_tunnel_enabled, row.created_at, row.updated_at
      );
    return row;
  });

  ctx.app.delete("/services/:id", async (req) => {
    const { id } = req.params as { id: string };
    const purgeDisk = (req.query as { purgeDisk?: string })?.purgeDisk === "true";
    const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(id) as
      | { id: string; type: string; working_dir?: string; status?: string }
      | undefined;
    if (!service) throw new Error("Service not found");

    // Stop the service (best effort)
    try {
      await stopService(ctx, id);
    } catch {
      /* ignore: service may not be running */
    }

    // Force-remove any lingering docker container
    if (service.type === "docker") {
      try {
        const container = ctx.docker.getContainer(`survhub-${id}`);
        await container.remove({ force: true });
      } catch {
        /* ignore */
      }
    }

    // Cascade delete child rows
    ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ?").run(id);
    ctx.db.prepare("DELETE FROM deployments WHERE service_id = ?").run(id);
    ctx.db.prepare("DELETE FROM logs WHERE service_id = ?").run(id);
    ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(id);
    try {
      ctx.db.prepare("DELETE FROM certificates WHERE domain IN (SELECT domain FROM proxy_routes WHERE service_id = ?)").run(id);
    } catch {
      /* certificates table may not yet exist on older installs */
    }

    // Optional: remove the cloned project directory from disk
    if (purgeDisk && service.working_dir) {
      const wd = path.resolve(service.working_dir);
      // Refuse to touch anything outside a plausible survhub data dir
      if (wd.includes(".survhub") || wd.includes("survhub-repos")) {
        try {
          fs.rmSync(wd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }

    ctx.runtimeProcesses.delete(id);
    ctx.manuallyStopped.delete(id);
    ctx.actionLocks.delete(id);
    ctx.db.prepare("DELETE FROM services WHERE id = ?").run(id);
    return { ok: true };
  });

  ctx.app.post("/services/:id/start", async (req) => ({ ok: true, ...(await startService(ctx, (req.params as { id: string }).id).then(() => ({}))) }));
  ctx.app.post("/services/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    const dependents = getDependents(ctx, id).filter((depId) => {
      const s = ctx.db.prepare("SELECT status FROM services WHERE id = ?").get(depId) as { status?: string } | undefined;
      return s?.status === "running";
    });
    if (dependents.length > 0) {
      for (const depId of dependents) {
        insertLog(ctx, depId, "warn", `Upstream dependency ${id} is being stopped — this service may break.`);
      }
    }
    await stopService(ctx, id);
    return { ok: true, warnedDependents: dependents };
  });
  ctx.app.post("/services/:id/restart", async (req) => ({ ok: true, ...(await restartService(ctx, (req.params as { id: string }).id).then(() => ({}))) }));
  
  const updateServiceSchema = z.object({
    name: z.string().optional(),
    type: z.enum(["process", "docker", "static"]).optional(),
    command: z.string().optional(),
    workingDir: z.string().optional(),
    port: z.number().int().optional(),
    domain: z.string().optional(),
    githubAutoPull: z.boolean().optional(),
    autoRestart: z.boolean().optional(),
    dependsOn: z.array(z.string()).optional(),
    environment: z.enum(["production", "staging", "development"]).optional(),
    linkedDatabaseId: z.string().nullable().optional()
  });

  ctx.app.patch("/services/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = updateServiceSchema.parse(req.body);
    const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(id) as any;
    if (!service) throw new Error("Service not found");

    // --- Validation: collect errors, return 400 with per-field messages -----
    const errors: Record<string, string> = {};

    if (p.port !== undefined) {
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
        errors.port = "Port must be an integer between 1 and 65535";
      } else {
        const conflict = ctx.db
          .prepare("SELECT id, name FROM services WHERE port = ? AND id != ?")
          .get(p.port, id) as { id: string; name: string } | undefined;
        if (conflict) {
          errors.port = `Port ${p.port} already in use by service "${conflict.name}"`;
        }
      }
    }

    if (p.domain !== undefined && p.domain) {
      const domainLower = p.domain.toLowerCase().trim();
      // Hostname validation: labels of [a-z0-9-], no leading/trailing hyphen, TLD required.
      const domainRe = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
      const isLocal = domainLower === "localhost" || domainLower.endsWith(".localhost") || domainLower.endsWith(".local");
      if (!isLocal && !domainRe.test(domainLower)) {
        errors.domain = `"${p.domain}" is not a valid domain`;
      } else {
        const conflict = ctx.db
          .prepare("SELECT service_id FROM proxy_routes WHERE domain = ? AND service_id != ?")
          .get(domainLower, id) as { service_id: string } | undefined;
        if (conflict) {
          errors.domain = `Domain ${domainLower} is already mapped to another service`;
        }
      }
    }

    if (p.workingDir !== undefined && p.workingDir) {
      try {
        const stat = fs.statSync(p.workingDir);
        if (!stat.isDirectory()) {
          errors.workingDir = `${p.workingDir} exists but is not a directory`;
        }
      } catch {
        errors.workingDir = `Working directory does not exist: ${p.workingDir}`;
      }
    }

    if (Object.keys(errors).length > 0) {
      return reply.code(400).send({ error: "Validation failed", fields: errors });
    }

    if (p.name !== undefined) ctx.db.prepare("UPDATE services SET name = ?, updated_at = ? WHERE id = ?").run(p.name, nowIso(), id);
    if (p.type !== undefined) ctx.db.prepare("UPDATE services SET type = ? WHERE id = ?").run(p.type, id);
    if (p.command !== undefined) ctx.db.prepare("UPDATE services SET command = ? WHERE id = ?").run(p.command, id);
    if (p.workingDir !== undefined) ctx.db.prepare("UPDATE services SET working_dir = ? WHERE id = ?").run(p.workingDir, id);
    if (p.githubAutoPull !== undefined) ctx.db.prepare("UPDATE services SET github_auto_pull = ? WHERE id = ?").run(p.githubAutoPull ? 1 : 0, id);
    if (p.autoRestart !== undefined) ctx.db.prepare("UPDATE services SET auto_restart = ? WHERE id = ?").run(p.autoRestart ? 1 : 0, id);
    if (p.dependsOn !== undefined) {
      ctx.db.prepare("UPDATE services SET depends_on = ? WHERE id = ?").run(JSON.stringify(p.dependsOn), id);
    }
    if (p.environment !== undefined) {
      ctx.db.prepare("UPDATE services SET environment = ? WHERE id = ?").run(p.environment, id);
    }
    if (p.linkedDatabaseId !== undefined) {
      ctx.db.prepare("UPDATE services SET linked_database_id = ? WHERE id = ?").run(p.linkedDatabaseId, id);
    }

    let finalPort = p.port !== undefined ? p.port : service.port;
    if (p.port !== undefined) {
      ctx.db.prepare("UPDATE services SET port = ? WHERE id = ?").run(p.port, id);
    }

    if (p.domain !== undefined || p.port !== undefined) {
      const finalDomain = p.domain !== undefined ? p.domain.toLowerCase() : null;
      
      // Update proxy routes
      // Remove old ingress from Cloudflare tunnel if any existed
      try {
        const oldRoutes = ctx.db.prepare("SELECT domain FROM proxy_routes WHERE service_id = ?").all(id) as Array<{ domain: string }>;
        const { getTunnelStatus, removeTunnelIngress } = await import("../services/cloudflare.js");
        const status = getTunnelStatus(ctx);
        if (status.tunnelId && status.apiTokenConfigured) {
          for (const r of oldRoutes) {
            await removeTunnelIngress(ctx, r.domain).catch(() => undefined);
          }
        }
      } catch {
        /* ignore tunnel cleanup errors */
      }

      ctx.db.prepare("DELETE FROM proxy_routes WHERE service_id = ?").run(id);
      if (finalDomain && finalPort) {
        ctx.db.prepare("INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(nanoid(), id, finalDomain, finalPort, nowIso());

        const isRealDomain =
          finalDomain.includes(".") && !finalDomain.endsWith(".localhost") && !finalDomain.endsWith(".local");

        // Prefer Cloudflare Tunnel registration if configured — Cloudflare
        // terminates TLS at the edge so we skip Let's Encrypt in that case.
        let handledByTunnel = false;
        if (isRealDomain) {
          try {
            const { getTunnelStatus, upsertDnsCname, upsertTunnelIngress } = await import("../services/cloudflare.js");
            const status = getTunnelStatus(ctx);
            if (status.tunnelId && status.zoneId && status.apiTokenConfigured) {
              await upsertDnsCname(ctx, finalDomain);
              await upsertTunnelIngress(ctx, finalDomain, finalPort);
              ctx.db.prepare("UPDATE services SET ssl_status = ? WHERE id = ?").run("cloudflare", id);
              handledByTunnel = true;
            }
          } catch (err) {
            console.error(`Cloudflare Tunnel registration failed for ${finalDomain}:`, err);
          }
        }

        // Fall back to Let's Encrypt HTTP-01 provisioning for real domains.
        if (isRealDomain && !handledByTunnel) {
          const { provisionCertificate } = await import("../services/ssl.js");
          provisionCertificate(ctx, id, finalDomain).catch((err) => {
            console.error(`Automatic SSL failed for ${finalDomain}:`, err);
          });
        }
      }
    }

    ctx.db.prepare("UPDATE services SET updated_at = ? WHERE id = ?").run(nowIso(), id);
    return { ok: true };
  });

  ctx.app.get("/services/:id/env", async (req) => {
    const serviceId = (req.params as { id: string }).id;
    const rows = ctx.db.prepare("SELECT id, key, value, is_secret FROM env_vars WHERE service_id = ?").all(serviceId) as Array<{
      id: string; key: string; value: string; is_secret: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.is_secret ? maskSecret(decryptSecret(row.value, ctx.config.secretKey)) : row.value,
      is_secret: row.is_secret
    }));
  });

  ctx.app.post("/services/:id/env", async (req) => {
    const serviceId = (req.params as { id: string }).id;
    const p = envSchema.parse(req.body);
    const storedValue = p.isSecret ? encryptSecret(p.value, ctx.config.secretKey) : p.value;
    const rowId = nanoid();
    ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
      .run(rowId, serviceId, p.key, storedValue, p.isSecret ? 1 : 0);
    return { ok: true, id: rowId };
  });

  ctx.app.delete("/services/:id/env/:envId", async (req) => {
    const { id, envId } = req.params as { id: string; envId: string };
    ctx.db.prepare("DELETE FROM env_vars WHERE id = ? AND service_id = ?").run(envId, id);
    return { ok: true };
  });

  ctx.app.get("/services/:id/logs", async (req) => {
    const serviceId = (req.params as { id: string }).id;
    return ctx.db.prepare("SELECT * FROM logs WHERE service_id = ? ORDER BY timestamp DESC LIMIT 1000").all(serviceId);
  });

  ctx.app.post("/services/import-compose", async (req) => {
    const p = composeImportSchema.parse(req.body);
    let composeRaw = p.composeContent ?? "";
    if (!composeRaw && p.composeFilePath) {
      composeRaw = fs.readFileSync(p.composeFilePath, "utf8");
    }
    if (!composeRaw) throw new Error("composeContent or composeFilePath is required");

    const parsed = yaml.load(composeRaw) as {
      services?: Record<string, Record<string, unknown>>;
      volumes?: Record<string, unknown>;
      networks?: Record<string, unknown>;
    } | null;
    const services = parsed?.services ?? {};

    // Map compose service name → SURVHub service id (for both existing and new)
    // so we can resolve depends_on references even if the compose file refers
    // to a service that also gets created in this same import call.
    const nameToId = new Map<string, string>();
    for (const [serviceName] of Object.entries(services)) {
      const existing = ctx.db
        .prepare("SELECT id FROM services WHERE project_id = ? AND compose_service_name = ?")
        .get(p.projectId, serviceName) as { id?: string } | undefined;
      nameToId.set(serviceName, existing?.id ?? nanoid());
    }

    const composeHash = crypto.createHash("sha1").update(composeRaw).digest("hex");
    const created: Array<{ id: string; name: string; action: "created" | "updated" }> = [];

    for (const [serviceName, definition] of Object.entries(services)) {
      const id = nameToId.get(serviceName)!;
      const existing = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(id) as { id?: string } | undefined;

      const image = typeof definition.image === "string" ? definition.image : "";
      const commandValue = definition.command;
      const command = Array.isArray(commandValue)
        ? commandValue.map((v) => String(v)).join(" ")
        : typeof commandValue === "string"
          ? commandValue
          : "";
      const ports = Array.isArray(definition.ports) ? definition.ports : [];
      const hostPort = parsePortMapping(ports[0] ?? null);
      const workDir = p.workingDir ?? "";
      const now = nowIso();

      // Resolve depends_on against the in-import map first, then fall back to
      // existing services by compose name.
      const rawDeps = definition.depends_on;
      const depNames: string[] =
        Array.isArray(rawDeps) ? rawDeps.map(String) :
        rawDeps && typeof rawDeps === "object" ? Object.keys(rawDeps as Record<string, unknown>) :
        [];
      const depIds = depNames
        .map((n) => {
          const mapped = nameToId.get(n);
          if (mapped) return mapped;
          const existingDep = ctx.db
            .prepare("SELECT id FROM services WHERE project_id = ? AND compose_service_name = ?")
            .get(p.projectId, n) as { id?: string } | undefined;
          return existingDep?.id ?? null;
        })
        .filter((v): v is string => Boolean(v));

      const healthcheckPath = typeof (definition.healthcheck as Record<string, unknown> | undefined)?.test === "string"
        ? ""
        : "";

      if (existing) {
        ctx.db
          .prepare(
            `UPDATE services SET
              name = ?, type = ?, command = ?, working_dir = ?, docker_image = ?, port = ?,
              depends_on = ?, compose_service_name = ?, compose_file_hash = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            serviceName,
            "docker",
            command,
            workDir,
            image,
            hostPort,
            JSON.stringify(depIds),
            serviceName,
            composeHash,
            now,
            id
          );
        // Replace env vars for this service on re-import.
        ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ?").run(id);
      } else {
        ctx.db
          .prepare(
            `INSERT INTO services (
              id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
              auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at,
              depends_on, compose_service_name, compose_file_hash, healthcheck_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id, p.projectId, serviceName, "docker", command, workDir, image, "", hostPort, "stopped",
            1, 0, 5, "manual", now, now,
            JSON.stringify(depIds), serviceName, composeHash, healthcheckPath
          );
      }

      const env = definition.environment;
      if (Array.isArray(env)) {
        for (const value of env) {
          const raw = String(value);
          const sep = raw.indexOf("=");
          if (sep > 0) {
            ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
              .run(nanoid(), id, raw.slice(0, sep), raw.slice(sep + 1), 0);
          }
        }
      } else if (env && typeof env === "object") {
        for (const [key, value] of Object.entries(env)) {
          ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
            .run(nanoid(), id, key, String(value ?? ""), 0);
        }
      }

      created.push({ id, name: serviceName, action: existing ? "updated" : "created" });
    }
    return {
      imported: created.length,
      services: created,
      topLevelVolumes: Object.keys(parsed?.volumes ?? {}),
      topLevelNetworks: Object.keys(parsed?.networks ?? {})
    };
  });

  ctx.app.post("/services/deploy-from-github", async (req) => {
    const p = directDeploySchema.parse(req.body);
    const createdAt = nowIso();
    const serviceId = nanoid();
    const assignedPort = p.port ?? await findFreePort(3000, 3999);
    ctx.db.prepare(`INSERT INTO services (
      id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
      auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at, github_repo_url, github_branch, github_auto_pull,
      quick_tunnel_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serviceId,
      p.projectId,
      p.name,
      "process",
      "",
      "",
      "",
      "",
      assignedPort,
      "building",
      1,
      0,
      5,
      "manual",
      createdAt,
      createdAt,
      p.repoUrl,
      p.branch,
      p.autoPull ? 1 : 0,
      p.enableQuickTunnel ? 1 : 0
    );

    const deployment = await deployFromGit(ctx, serviceId, p.repoUrl, p.branch);
    await applyPostDeployServiceState(ctx, serviceId, deployment, { startAfterDeploy: p.startAfterDeploy });

    if (p.enableQuickTunnel && p.startAfterDeploy && deployment.status === "success") {
      try {
        const { startQuickTunnel } = await import("../services/cloudflare.js");
        startQuickTunnel(ctx, serviceId, assignedPort);
      } catch (err) {
        insertLog(ctx, serviceId, "warn", `Quick tunnel start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (p.domain) {
      const domain = p.domain.toLowerCase();
      const existingDomain = ctx.db.prepare("SELECT id FROM proxy_routes WHERE domain = ?").get(domain);
      if (!existingDomain) {
        ctx.db.prepare("INSERT INTO proxy_routes (id, service_id, domain, target_port, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(nanoid(), serviceId, domain, assignedPort, nowIso());
      }
    }

    const service = ctx.db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
    return { service, deployment };
  });
}
