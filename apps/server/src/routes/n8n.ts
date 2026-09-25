import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  bootstrapN8nSecrets,
  getN8nStatus,
  installN8nEventStarter,
  listN8nEventStarters,
  listN8nWorkflows,
  n8nStarterWorkflowJson,
  N8N_EVENT_STARTERS,
  readN8nLog,
  removeN8nEventStarter,
  setN8nAutostart,
  setN8nPower,
  setN8nPublicUrl,
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

function actorOf(req: { actor?: string }): string {
  return req.actor ?? "unknown";
}

export function registerN8nRoutes(ctx: AppContext): void {
  ctx.app.get("/n8n/status", async () => getN8nStatus(ctx));

  ctx.app.post("/n8n/power", async (req) => {
    const { action } = powerSchema.parse(req.body);
    if (ctx.actionLocks.has("n8n")) {
      const error = new Error("An n8n power action is already in progress") as Error & {
        statusCode: number;
      };
      error.statusCode = 409;
      throw error;
    }
    ctx.actionLocks.add("n8n");
    try {
      return await setN8nPower(ctx, action);
    } finally {
      ctx.actionLocks.delete("n8n");
    }
  });

  ctx.app.post("/n8n/autostart", async (req) => {
    const { enabled } = autostartSchema.parse(req.body);
    return setN8nAutostart(ctx, enabled);
  });

  ctx.app.post("/n8n/public-url", async (req) => {
    const { url } = publicUrlSchema.parse(req.body ?? {});
    return setN8nPublicUrl(ctx, url);
  });

  ctx.app.post("/n8n/bootstrap", async () => bootstrapN8nSecrets(ctx));

  ctx.app.post("/n8n/ai-gateway/wire", async (req) =>
    wireN8nAiGateway(ctx, actorOf(req as { actor?: string }))
  );

  ctx.app.get("/n8n/workflows", async () => listN8nWorkflows(ctx));

  ctx.app.get("/n8n/logs", async (req) => {
    const { lines } = logQuerySchema.parse(req.query ?? {});
    return { log: await readN8nLog(ctx, lines) };
  });

  ctx.app.get("/n8n/webhooks", async () => ({
    items: listN8nEventStarters(ctx),
    catalog: N8N_EVENT_STARTERS
  }));

  ctx.app.post("/n8n/webhooks", async (req) => {
    const body = webhookInstallSchema.parse(req.body ?? {});
    return installN8nEventStarter(ctx, body.event, body.webhookUrl, actorOf(req as { actor?: string }));
  });

  ctx.app.delete("/n8n/webhooks/:event", async (req) => {
    const { event } = req.params as { event: string };
    removeN8nEventStarter(ctx, decodeURIComponent(event), actorOf(req as { actor?: string }));
    return { ok: true };
  });

  ctx.app.get("/n8n/webhooks/:event/workflow.json", async (req) => {
    const { event } = req.params as { event: string };
    const decoded = decodeURIComponent(event);
    if (!N8N_EVENT_STARTERS.some((s) => s.event === decoded)) {
      const err = new Error("Unknown event") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    const status = await getN8nStatus(ctx);
    return n8nStarterWorkflowJson(decoded, status.publicUrl);
  });
}
