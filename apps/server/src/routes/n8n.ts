import { z } from "zod";
import type { AppContext } from "../types.js";
import { getN8nStatus, setN8nPower, readN8nLog } from "../services/n8n.js";
import { ClaudeCodeCredential } from "@flyvendedk799/ai-auth";
import { GatewayError } from "../subgate/errors.js";
import { resolveModel } from "../subgate/models.js";
import { chatCompletion, chatCompletionStream } from "../subgate/gateway.js";
import type { OpenAIChatRequest, ProviderId, ProviderCredentials } from "../subgate/types.js";

const powerSchema = z.object({
  action: z.enum(["start", "stop", "restart"])
});

const logQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200)
});

// Create a local gateway deps that ONLY uses ai-auth
const aiAuthGatewayDeps = {
  async credentialsFor(provider: ProviderId): Promise<ProviderCredentials | null> {
    if (provider === "anthropic") {
      const claude = new ClaudeCodeCredential();
      const status = await claude.status();
      if (!status.connected) return null;
      try {
        const token = await claude.token();
        return { provider: "anthropic", apiKey: token, baseUrl: undefined };
      } catch {
        return null;
      }
    }
    return null; // Add gemini/openai later if needed
  }
};

export function registerN8nRoutes(ctx: AppContext): void {
  ctx.app.get("/n8n/status", async () => getN8nStatus(ctx));

  ctx.app.post("/n8n/power", async (req) => {
    const { action } = powerSchema.parse(req.body);
    if (ctx.actionLocks.has("n8n")) {
      const error = new Error("An n8n power action is already in progress") as Error & { statusCode: number };
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

  ctx.app.get("/n8n/logs", async (req) => {
    const { lines } = logQuerySchema.parse(req.query ?? {});
    return { log: await readN8nLog(ctx, lines) };
  });

  // AI Auth Proxy for n8n
  ctx.app.post("/n8n/ai/v1/chat/completions", async (req, reply) => {
    const request = req.body as OpenAIChatRequest;
    
    // Resolve model to know which provider we need
    const resolved = resolveModel(request.model, ["anthropic", "openai"]);
    const credentials = await aiAuthGatewayDeps.credentialsFor(resolved.provider);
    
    if (!credentials) {
      return reply.code(401).send({
        error: { message: `No active ai-auth login found on host for ${resolved.provider}. Run \`claude\` on the server to sign in.` }
      });
    }

    // subgate's chatCompletion requires GatewayDeps which is synchronous.
    // Since we fetched credentials async, we can create a sync mock deps:
    const syncDeps = {
      credentialsFor: (prov: ProviderId) => prov === resolved.provider ? credentials : null
    };

    if (request.stream) {
      const { chunks } = chatCompletionStream(request, syncDeps, { signal: req.raw.aborted ? AbortSignal.abort() : undefined });
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      
      for await (const chunk of chunks) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    } else {
      const { response } = await chatCompletion(request, syncDeps, { signal: req.raw.aborted ? AbortSignal.abort() : undefined });
      return response;
    }
  });
}
