/**
 * AI Gateway management routes.
 *
 * These sit on the *main* Fastify instance and are therefore covered by the
 * dashboard's session-auth hook in routes/auth.ts (`/api` is registered in its
 * API_PREFIXES list, so GETs are gated too — without that entry they would
 * fall through to the SPA handler unauthenticated).
 *
 * The inference endpoints are deliberately NOT here; see
 * services/aiGatewayServer.ts.
 */

import { z } from "zod";
import type { AppContext } from "../types.js";
import { GatewayError } from "../subgate/errors.js";
import { listModels } from "../subgate/models.js";
import { chatCompletion } from "../subgate/gateway.js";
import {
  clearProviderKey,
  gatewayDeps,
  getGatewayConfig,
  getUsageSummary,
  listAvailableProviders,
  listConsumerTokens,
  mintConsumerToken,
  providerStatuses,
  revokeConsumerToken,
  setGatewayConfig,
  setProviderBaseUrl,
  setProviderKey,
  currentInFlight
} from "../services/aiGateway.js";
import {
  inferenceServerPort,
  inferenceServerRunning,
  startInferenceServer,
  stopInferenceServer
} from "../services/aiGatewayServer.js";
import {
  clearExternalTarget,
  externalMintToken,
  externalProviders,
  externalRevokeToken,
  externalStatus,
  externalTest,
  externalTokens,
  externalUsage,
  getExternalTarget,
  isExternalMode,
  setExternalTarget
} from "../services/aiGatewayExternal.js";
import type { ProviderId } from "../subgate/types.js";

const providerParamSchema = z.object({ id: z.enum(["anthropic", "openai"]) });

const providerKeySchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  baseUrl: z.string().url().optional().or(z.literal(""))
});

const configSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  publicUrl: z.string().url().optional().or(z.literal("")),
  rateLimitPerMinute: z.number().int().min(0).max(100000).optional(),
  maxConcurrent: z.number().int().min(1).max(1000).optional(),
  /** Minutes of body-shape logging to enable. 0 turns it off. */
  debugBodiesMinutes: z.number().int().min(0).max(120).optional()
});

const mintTokenSchema = z.object({ name: z.string().min(1).max(80) });

const testSchema = z.object({
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).max(2000).optional()
});

const externalSchema = z.object({
  url: z.string().url(),
  adminToken: z.string().min(1)
});

function actorOf(req: { actor?: string }): string {
  return req.actor ?? "unknown";
}

/**
 * Guard for in-process-only mutations. In external mode the container owns the
 * provider keys and runtime config (via its own env), so these must not
 * silently write local settings that do nothing.
 */
function ensureNotExternal(ctx: AppContext, what: string): void {
  if (isExternalMode(ctx)) {
    throw new GatewayError(
      "invalid_request",
      `${what} is managed on the SubGate container (its environment) while this tab is in external mode. ` +
        "Disconnect the external gateway to manage an in-process gateway here."
    );
  }
}

export function registerAiGatewayRoutes(ctx: AppContext): void {
  ctx.app.get("/api/ai-gateway/status", async () =>
    isExternalMode(ctx) ? externalStatus(ctx) : buildStatus(ctx)
  );

  /* -------------------------------------------------------------------- */
  /* External target (connect the tab to a standalone container)          */
  /* -------------------------------------------------------------------- */

  ctx.app.get("/api/ai-gateway/external", async () => {
    const target = getExternalTarget(ctx);
    // Never return the admin token — only whether one is set and the URL.
    return { configured: Boolean(target), url: target?.url ?? null };
  });

  ctx.app.put("/api/ai-gateway/external", async (req) => {
    const body = externalSchema.parse(req.body ?? {});
    setExternalTarget(ctx, body.url, body.adminToken, actorOf(req as { actor?: string }));
    // Verify immediately so a bad URL/token fails loudly here, not later.
    try {
      await externalStatus(ctx);
    } catch (err) {
      // Roll back a target we couldn't reach, so the tab doesn't get stuck.
      clearExternalTarget(ctx, actorOf(req as { actor?: string }));
      throw err;
    }
    return { ok: true, ...(await externalStatus(ctx)) };
  });

  ctx.app.delete("/api/ai-gateway/external", async (req) => {
    clearExternalTarget(ctx, actorOf(req as { actor?: string }));
    return { ok: true };
  });

  ctx.app.post("/api/ai-gateway/enable", async (req) => {
    // The container runs itself; enabling/disabling is meaningless externally.
    if (isExternalMode(ctx)) return externalStatus(ctx);
    setGatewayConfig(ctx, { enabled: true }, actorOf(req as { actor?: string }));
    await startInferenceServer(ctx);
    return buildStatus(ctx);
  });

  ctx.app.post("/api/ai-gateway/disable", async (req) => {
    if (isExternalMode(ctx)) return externalStatus(ctx);
    setGatewayConfig(ctx, { enabled: false }, actorOf(req as { actor?: string }));
    await stopInferenceServer();
    return buildStatus(ctx);
  });

  ctx.app.patch("/api/ai-gateway/config", async (req) => {
    ensureNotExternal(ctx, "Rate limit, concurrency, and port");
    const body = configSchema.parse(req.body ?? {});
    const patch: Parameters<typeof setGatewayConfig>[1] = {};
    if (body.port !== undefined) patch.port = body.port;
    if (body.publicUrl !== undefined) patch.publicUrl = body.publicUrl;
    if (body.rateLimitPerMinute !== undefined) patch.rateLimitPerMinute = body.rateLimitPerMinute;
    if (body.maxConcurrent !== undefined) patch.maxConcurrent = body.maxConcurrent;
    if (body.debugBodiesMinutes !== undefined) {
      // Time-boxed by construction (§7) — the UI cannot leave it on forever.
      patch.debugBodiesUntil =
        body.debugBodiesMinutes > 0
          ? new Date(Date.now() + body.debugBodiesMinutes * 60_000).toISOString()
          : null;
    }
    const next = setGatewayConfig(ctx, patch, actorOf(req as { actor?: string }));

    // A port change only takes effect on rebind.
    if (body.port !== undefined && inferenceServerRunning() && inferenceServerPort() !== body.port) {
      await stopInferenceServer();
      if (next.enabled) await startInferenceServer(ctx);
    }
    return buildStatus(ctx);
  });

  /* -------------------------------------------------------------------- */
  /* Providers                                                             */
  /* -------------------------------------------------------------------- */

  ctx.app.get("/api/ai-gateway/providers", async () =>
    isExternalMode(ctx)
      ? externalProviders(ctx)
      : {
          providers: providerStatuses(ctx),
          available: listAvailableProviders(ctx),
          models: listModels().map((model) => ({
            id: model.id,
            provider: model.provider,
            display_name: model.displayName,
            context_window: model.contextWindow,
            max_output_tokens: model.maxOutputTokens
          }))
        }
  );

  ctx.app.put("/api/ai-gateway/providers/:id", async (req) => {
    ensureNotExternal(ctx, "Provider keys");
    const { id } = providerParamSchema.parse(req.params);
    const body = providerKeySchema.parse(req.body ?? {});
    setProviderKey(ctx, id as ProviderId, body.apiKey, actorOf(req as { actor?: string }));
    if (body.baseUrl !== undefined) setProviderBaseUrl(ctx, id as ProviderId, body.baseUrl);
    // Deliberately returns status only — never the key that was just stored.
    return { ok: true, providers: providerStatuses(ctx) };
  });

  ctx.app.delete("/api/ai-gateway/providers/:id", async (req) => {
    ensureNotExternal(ctx, "Provider keys");
    const { id } = providerParamSchema.parse(req.params);
    clearProviderKey(ctx, id as ProviderId, actorOf(req as { actor?: string }));
    return { ok: true, providers: providerStatuses(ctx) };
  });

  /**
   * Validate a stored credential against the upstream.
   *
   * With API-key credentials there is no OAuth refresh to perform, so "refresh"
   * means "prove the key still works" — which is the question the dashboard
   * card actually needs answered.
   */
  ctx.app.post("/api/ai-gateway/providers/:id/refresh", async (req) => {
    // In external mode the container validates its own key; surface that.
    if (isExternalMode(ctx)) {
      const result = (await externalTest(ctx)) as { ok?: boolean; provider?: string; error?: string; code?: string };
      return {
        ok: Boolean(result.ok),
        provider: result.provider ?? "external",
        checked_at: new Date().toISOString(),
        error: result.error,
        code: result.code
      };
    }
    const { id } = providerParamSchema.parse(req.params);
    const provider = id as ProviderId;
    const started = Date.now();
    try {
      await chatCompletion(
        {
          model: provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        },
        gatewayDeps(ctx),
        { timeoutMs: 20_000 }
      );
      return { ok: true, provider, latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
    } catch (err) {
      const error = err instanceof GatewayError ? err : new GatewayError("upstream_error", String(err));
      return {
        ok: false,
        provider,
        latency_ms: Date.now() - started,
        checked_at: new Date().toISOString(),
        // Already redacted by GatewayError's constructor.
        error: error.message,
        code: error.code
      };
    }
  });

  /* -------------------------------------------------------------------- */
  /* Consumer tokens                                                       */
  /* -------------------------------------------------------------------- */

  ctx.app.get("/api/ai-gateway/tokens", async () =>
    isExternalMode(ctx) ? externalTokens(ctx) : { tokens: listConsumerTokens(ctx) }
  );

  ctx.app.post("/api/ai-gateway/tokens", async (req, reply) => {
    const body = mintTokenSchema.parse(req.body ?? {});
    if (isExternalMode(ctx)) {
      reply.code(201);
      return externalMintToken(ctx, body.name);
    }
    const { token, record } = mintConsumerToken(ctx, body.name, actorOf(req as { actor?: string }));
    reply.code(201);
    // The only response in the whole system that carries a live token. The UI
    // shows it once and it is never retrievable again.
    return {
      ok: true,
      token,
      record,
      warning: "Copy this now — it is shown once and stored only as a hash."
    };
  });

  ctx.app.delete("/api/ai-gateway/tokens/:id", async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    if (isExternalMode(ctx)) return externalRevokeToken(ctx, id);
    const record = revokeConsumerToken(ctx, id, actorOf(req as { actor?: string }));
    return { ok: true, record };
  });

  /* -------------------------------------------------------------------- */
  /* Usage + test                                                          */
  /* -------------------------------------------------------------------- */

  ctx.app.get("/api/ai-gateway/usage", async (req) => {
    const query = z
      .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
      .parse(req.query ?? {});
    return isExternalMode(ctx) ? externalUsage(ctx, query.hours) : getUsageSummary(ctx, query.hours);
  });

  /**
   * Round-trip a trivial completion through the full core path and return the
   * raw result, so the "Test" button proves translation and credentials rather
   * than just liveness.
   */
  ctx.app.post("/api/ai-gateway/test", async (req) => {
    const body = testSchema.parse(req.body ?? {});
    if (isExternalMode(ctx)) return externalTest(ctx);
    const available = listAvailableProviders(ctx);
    if (available.length === 0) {
      throw new GatewayError(
        "no_provider_configured",
        "No provider API key is configured yet. Add one above, then test."
      );
    }
    const model =
      body.model ?? (available.includes("anthropic") ? "claude-haiku-4-5-20251001" : "gpt-4o-mini");
    const started = Date.now();
    try {
      const { response, meta } = await chatCompletion(
        {
          model,
          messages: [{ role: "user", content: body.prompt ?? "Reply with exactly: ok" }],
          max_tokens: 32
        },
        gatewayDeps(ctx),
        { timeoutMs: 30_000 }
      );
      return {
        ok: true,
        duration_ms: Date.now() - started,
        provider: meta.provider,
        model: meta.requestedModel,
        translated: meta.translated,
        usage: meta.usage,
        content: response.choices[0]?.message?.content ?? "",
        raw: response
      };
    } catch (err) {
      const error = err instanceof GatewayError ? err : new GatewayError("upstream_error", String(err));
      return {
        ok: false,
        duration_ms: Date.now() - started,
        model,
        error: error.message,
        code: error.code,
        status: error.statusCode
      };
    }
  });
}

function buildStatus(ctx: AppContext): Record<string, unknown> {
  const config = getGatewayConfig(ctx);
  const running = inferenceServerRunning();
  const port = inferenceServerPort() ?? config.port;
  return {
    enabled: config.enabled,
    running,
    bound: { host: "127.0.0.1", port },
    public_url: config.publicUrl,
    // What the operator pastes into a consumer's env.
    openai_base_url: config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}/v1` : null,
    anthropic_base_url: config.publicUrl ? config.publicUrl.replace(/\/+$/, "") : null,
    rate_limit_per_minute: config.rateLimitPerMinute,
    max_concurrent: config.maxConcurrent,
    in_flight: currentInFlight(),
    debug_bodies_until: config.debugBodiesUntil,
    providers: providerStatuses(ctx),
    available_providers: listAvailableProviders(ctx),
    token_count: listConsumerTokens(ctx).filter((token) => token.active).length
  };
}
