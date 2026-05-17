import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  createAgentAuthSession,
  createAgentInstallSession,
  createAgentProfile,
  createAgentRunSession,
  deleteAgentSecret,
  listAgentProfiles,
  listAgentProviders,
  updateAgentProfile,
  upsertAgentSecret,
  type AgentProviderId
} from "../services/agents.js";

const createProfileSchema = z.object({
  provider: z.enum(["claude", "gemini"]),
  name: z.string().min(1).default("default"),
  authMode: z.enum(["cli", "managed"]).default("cli")
});

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  authMode: z.enum(["cli", "managed"]).optional()
});

const secretSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1)
});

const runSchema = z.object({
  allowMutations: z.boolean().default(false)
});

export function registerAgentRoutes(ctx: AppContext): void {
  ctx.app.get("/agents/providers", async () => listAgentProviders());

  ctx.app.get("/services/:id/agent-profiles", async (req) => {
    const { id } = req.params as { id: string };
    return listAgentProfiles(ctx, id);
  });

  ctx.app.post("/services/:id/agent-profiles", async (req) => {
    const { id } = req.params as { id: string };
    const body = createProfileSchema.parse(req.body ?? {});
    return createAgentProfile(ctx, id, body.provider as AgentProviderId, body.name, body.authMode);
  });

  ctx.app.patch("/services/:id/agent-profiles/:profileId", async (req) => {
    const { id, profileId } = req.params as { id: string; profileId: string };
    const body = updateProfileSchema.parse(req.body ?? {});
    return updateAgentProfile(ctx, id, profileId, body);
  });

  ctx.app.post("/services/:id/agent-profiles/:profileId/secrets", async (req) => {
    const { id, profileId } = req.params as { id: string; profileId: string };
    const body = secretSchema.parse(req.body ?? {});
    return upsertAgentSecret(ctx, id, profileId, body.key, body.value);
  });

  ctx.app.delete("/services/:id/agent-profiles/:profileId/secrets/:key", async (req) => {
    const { id, profileId, key } = req.params as { id: string; profileId: string; key: string };
    return deleteAgentSecret(ctx, id, profileId, key);
  });

  ctx.app.post("/services/:id/agent-profiles/:profileId/install-session", async (req) => {
    const { id, profileId } = req.params as { id: string; profileId: string };
    return createAgentInstallSession(ctx, id, profileId);
  });

  ctx.app.post("/services/:id/agent-profiles/:profileId/auth-session", async (req) => {
    const { id, profileId } = req.params as { id: string; profileId: string };
    return createAgentAuthSession(ctx, id, profileId);
  });

  ctx.app.post("/services/:id/agent-profiles/:profileId/run-session", async (req) => {
    const { id, profileId } = req.params as { id: string; profileId: string };
    const body = runSchema.parse(req.body ?? {});
    return createAgentRunSession(ctx, id, profileId, body.allowMutations);
  });
}
