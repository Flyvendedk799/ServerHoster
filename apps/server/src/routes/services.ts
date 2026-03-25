import fs from "node:fs";
import { nanoid } from "nanoid";
import yaml from "js-yaml";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso, parsePortMapping } from "../lib/core.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security.js";
import { restartService, startService, stopService } from "../services/runtime.js";

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
  healthcheckPath: z.string().optional()
});

const envSchema = z.object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().default(false) });
const composeImportSchema = z.object({
  projectId: z.string(),
  composeFilePath: z.string().optional(),
  composeContent: z.string().optional(),
  workingDir: z.string().optional()
});

export function registerServiceRoutes(ctx: AppContext): void {
  ctx.app.get("/services", async () => ctx.db.prepare("SELECT * FROM services ORDER BY created_at DESC").all());

  ctx.app.post("/services", async (req) => {
    const p = serviceSchema.parse(req.body);
    const row = {
      id: nanoid(),
      project_id: p.projectId,
      name: p.name,
      type: p.type,
      command: p.command ?? "",
      working_dir: p.workingDir ?? "",
      docker_image: p.dockerImage ?? "",
      dockerfile: p.dockerfile ?? "",
      port: p.port ?? null,
      status: "stopped",
      auto_restart: p.autoRestart ? 1 : 0,
      restart_count: 0,
      max_restarts: p.maxRestarts,
      healthcheck_path: p.healthcheckPath ?? "",
      start_mode: p.startMode,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    ctx.db.prepare(`INSERT INTO services (
      id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
      auto_restart, restart_count, max_restarts, healthcheck_path, start_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.project_id, row.name, row.type, row.command, row.working_dir, row.docker_image, row.dockerfile, row.port,
        row.status, row.auto_restart, row.restart_count, row.max_restarts, row.healthcheck_path, row.start_mode, row.created_at, row.updated_at
      );
    return row;
  });

  ctx.app.post("/services/:id/start", async (req) => ({ ok: true, ...(await startService(ctx, (req.params as { id: string }).id).then(() => ({}))) }));
  ctx.app.post("/services/:id/stop", async (req) => ({ ok: true, ...(await stopService(ctx, (req.params as { id: string }).id).then(() => ({}))) }));
  ctx.app.post("/services/:id/restart", async (req) => ({ ok: true, ...(await restartService(ctx, (req.params as { id: string }).id).then(() => ({}))) }));

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

    const parsed = yaml.load(composeRaw) as { services?: Record<string, Record<string, unknown>> } | null;
    const services = parsed?.services ?? {};
    const created: Array<{ id: string; name: string }> = [];

    for (const [serviceName, definition] of Object.entries(services)) {
      const id = nanoid();
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
      const createdAt = nowIso();
      ctx.db.prepare(`INSERT INTO services (
        id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
        auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, p.projectId, serviceName, "docker", command, workDir, image, "", hostPort, "stopped",
        1, 0, 5, "manual", createdAt, createdAt
      );

      const env = definition.environment;
      if (Array.isArray(env)) {
        for (const value of env) {
          const raw = String(value);
          const sep = raw.indexOf("=");
          if (sep > 0) {
            const key = raw.slice(0, sep);
            const envValue = raw.slice(sep + 1);
            ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
              .run(nanoid(), id, key, envValue, 0);
          }
        }
      } else if (env && typeof env === "object") {
        for (const [key, value] of Object.entries(env)) {
          ctx.db.prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
            .run(nanoid(), id, key, String(value ?? ""), 0);
        }
      }
      created.push({ id, name: serviceName });
    }
    return { imported: created.length, services: created };
  });
}
