import { z } from "zod";
import type { AppContext } from "../types.js";
import { writeCiCapacitySettings } from "../services/ciCapacity.js";
import { ciFirewallStatus } from "../services/ciNetwork.js";
import { clearRepoCache } from "../services/ciCache.js";
import {
  CiConfigError,
  ciSchedulerState,
  createCiPipeline,
  deleteCiPipeline,
  getCiRun,
  listCiPipelines,
  listCiRuns,
  queueManualCiRun,
  requestCancelCiRun,
  updateCiPipeline
} from "../services/ci.js";

const pipelineSchema = z.object({
  serviceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  gateDeploy: z.boolean().optional(),
  configSource: z.enum(["repo", "inline"]).optional(),
  inlineConfig: z.string().max(50_000).nullable().optional(),
  image: z.string().trim().min(1).max(200).optional(),
  timeoutMinutes: z.number().int().min(1).max(120).optional(),
  memoryMb: z.number().int().min(128).max(8192).optional(),
  cpus: z.number().min(0.25).max(4).optional(),
  triggerBranches: z.string().max(2000).nullable().optional(),
  triggerPullRequests: z.boolean().optional()
});

const settingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(16).nullable().optional(),
  budgetPercent: z.number().int().min(10).max(90).optional(),
  readonlyRootfs: z.boolean().optional(),
  cacheMaxMb: z.number().int().min(0).max(512_000).optional(),
  workspaceMaxMb: z.number().int().min(512).max(512_000).optional()
});

function asConfigError(error: unknown): Error {
  if (error instanceof CiConfigError) {
    const wrapped = new Error(error.message) as Error & { statusCode: number };
    wrapped.statusCode = 400;
    return wrapped;
  }
  return error as Error;
}

export function registerCiRoutes(ctx: AppContext): void {
  ctx.app.get("/api/ci/pipelines", async () => listCiPipelines(ctx));

  ctx.app.post("/api/ci/pipelines", async (req) => {
    try {
      return createCiPipeline(ctx, pipelineSchema.parse(req.body ?? {}));
    } catch (error) {
      throw asConfigError(error);
    }
  });

  ctx.app.patch("/api/ci/pipelines/:id", async (req) => {
    const { id } = req.params as { id: string };
    try {
      return updateCiPipeline(ctx, id, pipelineSchema.parse(req.body ?? {}));
    } catch (error) {
      throw asConfigError(error);
    }
  });

  ctx.app.delete("/api/ci/pipelines/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteCiPipeline(ctx, id);
    return { ok: true };
  });

  ctx.app.post("/api/ci/pipelines/:id/run", async (req) => {
    const { id } = req.params as { id: string };
    return queueManualCiRun(ctx, id);
  });

  ctx.app.get("/api/ci/runs", async (req) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(req.query ?? {});
    return { runs: listCiRuns(ctx, query.limit ?? 40) };
  });

  ctx.app.get("/api/ci/runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getCiRun(ctx, id);
  });

  ctx.app.post("/api/ci/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    requestCancelCiRun(ctx, id);
    return { ok: true };
  });

  const settingsView = () => ({
    ...ciSchedulerState(ctx),
    firewall: ciFirewallStatus(),
    webhookInsecure: ctx.config.webhookInsecure,
    webhookSecretConfigured: Boolean(ctx.config.webhookSecret),
    publicUrlConfigured: Boolean(ctx.config.publicUrl)
  });

  ctx.app.get("/api/ci/settings", async () => settingsView());

  ctx.app.put("/api/ci/settings", async (req) => {
    writeCiCapacitySettings(ctx, settingsSchema.parse(req.body ?? {}));
    return settingsView();
  });

  ctx.app.delete("/api/ci/pipelines/:id/cache", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = ctx.db
      .prepare(
        `SELECT s.github_repo_url AS repoUrl FROM ci_pipelines p JOIN services s ON s.id = p.service_id WHERE p.id = ?`
      )
      .get(id) as { repoUrl: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "Pipeline not found" });
    if (row.repoUrl) await clearRepoCache(ctx, row.repoUrl);
    return { ok: true };
  });
}
