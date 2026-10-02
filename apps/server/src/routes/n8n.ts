import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  autoInstallN8nEventStarter,
  bootstrapN8nSecrets,
  deleteN8nExecution,
  deleteN8nWorkflow,
  exportN8nWorkflows,
  getN8nMetrics,
  getN8nStatus,
  getN8nWorkflowJson,
  importN8nWorkflow,
  installN8nEventStarter,
  listN8nEventStarters,
  listN8nExecutions,
  listN8nWorkflows,
  n8nStarterWorkflowJson,
  N8N_EVENT_STARTERS,
  readN8nLog,
  removeN8nEventStarter,
  retryN8nExecution,
  setN8nApiKey,
  setN8nAutostart,
  setN8nConfig,
  setN8nPower,
  setN8nPublicUrl,
  setN8nWorkflowActive,
  testN8nEventStarter,
  updateN8nImage,
  wireN8nAiGateway
} from "../services/n8n.js";

const powerSchema = z.object({
  action: z.enum(["start", "stop", "restart"])
});

const autostartSchema = z.object({
  enabled: z.boolean()
});

const publicUrlSchema = z.object({
  url: z.string().max(500)
});

const logQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200)
});

const webhookInstallSchema = z.object({
  event: z.string().min(1),
  webhookUrl: z.string().url()
});

const configSchema = z.object({
  imageTag: z.string().max(64).optional(),
  timezone: z.string().max(64).optional(),
  pruneEnabled: z.boolean().optional(),
  pruneMaxAgeHours: z.number().optional(),
  runnersEnabled: z.boolean().optional(),
  useSharedSmtp: z.boolean().optional(),
  extraEnv: z.record(z.string()).optional(),
  apply: z.boolean().optional()
});

const executionQuerySchema = z.object({
  workflowId: z.string().optional(),
  status: z.enum(["success", "error", "waiting", "running", "canceled"]).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().optional()
});

function actorOf(req: { actor?: string }): string {
  return req.actor ?? "unknown";
}

function decodedEvent(params: unknown): string {
  return decodeURIComponent((params as { event: string }).event);
}

/** Power, image updates and config-apply all recreate the container. */
async function withLock<T>(ctx: AppContext, fn: () => Promise<T>): Promise<T> {
  if (ctx.actionLocks.has("n8n")) {
    const error = new Error("An n8n container action is already in progress") as Error & {
      statusCode: number;
    };
    error.statusCode = 409;
    throw error;
  }
  ctx.actionLocks.add("n8n");
  try {
    return await fn();
  } finally {
    ctx.actionLocks.delete("n8n");
  }
}

export function registerN8nRoutes(ctx: AppContext): void {
  ctx.app.get("/n8n/status", async () => getN8nStatus(ctx));

  ctx.app.get("/n8n/metrics", async () => getN8nMetrics(ctx));

  ctx.app.post("/n8n/power", async (req) => {
    const { action } = powerSchema.parse(req.body);
    return withLock(ctx, () => setN8nPower(ctx, action));
  });

  ctx.app.post("/n8n/update", async (req) =>
    withLock(ctx, () => updateN8nImage(ctx, actorOf(req as { actor?: string })))
  );

  ctx.app.post("/n8n/autostart", async (req) => {
    const { enabled } = autostartSchema.parse(req.body);
    return withLock(ctx, () => setN8nAutostart(ctx, enabled));
  });

  ctx.app.post("/n8n/public-url", async (req) => {
    const { url } = publicUrlSchema.parse(req.body ?? {});
    return withLock(ctx, () => setN8nPublicUrl(ctx, url));
  });

  ctx.app.put("/n8n/config", async (req) => {
    const { apply, ...patch } = configSchema.parse(req.body ?? {});
    const run = () => setN8nConfig(ctx, patch, { apply, actor: actorOf(req as { actor?: string }) });
    return apply ? withLock(ctx, run) : run();
  });

  ctx.app.post("/n8n/bootstrap", async () => bootstrapN8nSecrets(ctx));

  ctx.app.put("/n8n/api-key", async (req) => {
    const { key } = z.object({ key: z.string().max(2000) }).parse(req.body ?? {});
    return setN8nApiKey(ctx, key, actorOf(req as { actor?: string }));
  });

  ctx.app.post("/n8n/ai-gateway/wire", async (req) =>
    withLock(ctx, () => wireN8nAiGateway(ctx, actorOf(req as { actor?: string })))
  );

  // ---- Workflows ------------------------------------------------------------
  ctx.app.get("/n8n/workflows", async () => listN8nWorkflows(ctx));

  ctx.app.get("/n8n/workflows/export", async () => exportN8nWorkflows(ctx));

  ctx.app.post("/n8n/workflows/import", { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const body = z
      .object({ workflow: z.unknown(), activate: z.boolean().optional() })
      .parse(req.body ?? {});
    return importN8nWorkflow(ctx, body.workflow, {
      activate: body.activate,
      actor: actorOf(req as { actor?: string })
    });
  });

  ctx.app.get("/n8n/workflows/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getN8nWorkflowJson(ctx, id);
  });

  ctx.app.post("/n8n/workflows/:id/active", async (req) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body ?? {});
    return setN8nWorkflowActive(ctx, id, active, actorOf(req as { actor?: string }));
  });

  ctx.app.delete("/n8n/workflows/:id", async (req) => {
    const { id } = req.params as { id: string };
    await deleteN8nWorkflow(ctx, id, actorOf(req as { actor?: string }));
    return { ok: true };
  });

  // ---- Executions -----------------------------------------------------------
  ctx.app.get("/n8n/executions", async (req) => {
    const q = executionQuerySchema.parse(req.query ?? {});
    return listN8nExecutions(ctx, q);
  });

  ctx.app.post("/n8n/executions/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    return retryN8nExecution(ctx, id, actorOf(req as { actor?: string }));
  });

  ctx.app.delete("/n8n/executions/:id", async (req) => {
    const { id } = req.params as { id: string };
    await deleteN8nExecution(ctx, id);
    return { ok: true };
  });

  // ---- Logs -----------------------------------------------------------------
  ctx.app.get("/n8n/logs", async (req) => {
    const { lines } = logQuerySchema.parse(req.query ?? {});
    return { log: await readN8nLog(ctx, lines) };
  });

  // ---- LocalSURV event webhooks ---------------------------------------------
  ctx.app.get("/n8n/webhooks", async () => ({
    items: listN8nEventStarters(ctx),
    catalog: N8N_EVENT_STARTERS
  }));

  ctx.app.post("/n8n/webhooks", async (req) => {
    const body = webhookInstallSchema.parse(req.body ?? {});
    return installN8nEventStarter(ctx, body.event, body.webhookUrl, actorOf(req as { actor?: string }));
  });

  ctx.app.post("/n8n/webhooks/:event/auto-install", async (req) =>
    autoInstallN8nEventStarter(ctx, decodedEvent(req.params), actorOf(req as { actor?: string }))
  );

  ctx.app.post("/n8n/webhooks/:event/test", async (req) => testN8nEventStarter(ctx, decodedEvent(req.params)));

  ctx.app.delete("/n8n/webhooks/:event", async (req) => {
    removeN8nEventStarter(ctx, decodedEvent(req.params), actorOf(req as { actor?: string }));
    return { ok: true };
  });

  ctx.app.get("/n8n/webhooks/:event/workflow.json", async (req) => {
    const decoded = decodedEvent(req.params);
    if (!N8N_EVENT_STARTERS.some((s) => s.event === decoded)) {
      const err = new Error("Unknown event") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    const status = await getN8nStatus(ctx);
    return n8nStarterWorkflowJson(decoded, status.publicUrl);
  });
}
