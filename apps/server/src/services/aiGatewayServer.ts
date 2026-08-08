/**
 * The inference listener — a *separate* Fastify instance on its own loopback
 * port.
 *
 * §4.2 asked for a deliberate decision here. This is separate rather than a
 * path prefix on the main app for three reasons:
 *
 *   1. The dashboard's global auth hook (routes/auth.ts) gates every API path
 *      on a session bearer token. Machine traffic carries a *consumer* token
 *      instead; running it through the same instance would mean poking a hole
 *      in that hook for `/v1/*`, and a mistake there exposes the dashboard.
 *   2. The reverse proxy can publish this hostname without publishing the
 *      control plane at all.
 *   3. Streaming responses hijack the socket. Keeping that off the instance
 *      that serves the dashboard avoids any interaction with its onResponse
 *      audit hook.
 *
 * Bound to 127.0.0.1 unconditionally (§7). Public exposure is the reverse
 * proxy's job, over TLS.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppContext } from "../types.js";
import { GatewayError } from "../subgate/errors.js";
import { redact } from "../subgate/redact.js";
import { modelsPayload } from "../subgate/models.js";
import { formatSSEComment, formatSSEDone, formatSSEJson } from "../subgate/sse.js";
import {
  chatCompletion,
  chatCompletionStream,
  messages as anthropicMessages,
  messagesStream
} from "../subgate/gateway.js";
import type { AnthropicRequest, OpenAIChatRequest } from "../subgate/types.js";
import {
  authenticateConsumerToken,
  bodyLoggingActive,
  checkRateLimit,
  currentInFlight,
  gatewayDeps,
  getGatewayConfig,
  listAvailableProviders,
  recordUsage,
  releaseSlot,
  touchConsumerToken,
  tryAcquireSlot,
  type ConsumerTokenRow
} from "./aiGateway.js";

/** Body cap for inference requests — large prompts are legitimate. */
const INFERENCE_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Heartbeat interval while waiting on the upstream's first token. ServerHoster's
 * own reverse proxy and most CDNs drop an idle connection well before a slow
 * model produces its first byte.
 */
const KEEPALIVE_MS = 15_000;

let instance: FastifyInstance | null = null;
let boundPort: number | null = null;

export function inferenceServerRunning(): boolean {
  return instance !== null;
}

export function inferenceServerPort(): number | null {
  return boundPort;
}

type AuthedRequest = FastifyRequest & { consumerToken?: ConsumerTokenRow };

export async function startInferenceServer(ctx: AppContext): Promise<{ port: number }> {
  if (instance) return { port: boundPort ?? getGatewayConfig(ctx).port };

  const config = getGatewayConfig(ctx);
  const app = Fastify({
    // Inherit the parent's log level but never its body logging — see the
    // serializer below, which strips prompts.
    logger: ctx.app.log.child({ component: "ai-gateway" }),
    bodyLimit: INFERENCE_BODY_LIMIT,
    // Prompts are user data (§7). Fastify's default request logging includes
    // no body, but disable request id echoing of headers to be certain.
    disableRequestLogging: true
  });

  app.setErrorHandler((error, request, reply) => {
    const wire = request.url.startsWith("/v1/messages") ? "anthropic" : "openai";
    sendGatewayError(reply, toGatewayError(error), wire);
  });

  registerHealth(app, ctx);
  registerAuthGate(app, ctx);
  registerModels(app, ctx);
  registerChatCompletions(app, ctx);
  registerMessages(app, ctx);

  // 127.0.0.1 only. This is not configurable on purpose (§7).
  await app.listen({ port: config.port, host: "127.0.0.1" });
  instance = app;
  boundPort = config.port;
  ctx.app.log.info(
    { port: config.port },
    "AI Gateway inference server listening on 127.0.0.1 — expose via the reverse proxy, not directly"
  );
  return { port: config.port };
}

export async function stopInferenceServer(): Promise<void> {
  if (!instance) return;
  const app = instance;
  instance = null;
  boundPort = null;
  await app.close();
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                     */
/* ------------------------------------------------------------------------ */

function registerHealth(app: FastifyInstance, ctx: AppContext): void {
  // Unauthenticated on purpose: this is what the reverse proxy and any uptime
  // monitor probe. It reveals only liveness and which providers are usable.
  app.get("/health", async () => ({
    status: "ok",
    providers: listAvailableProviders(ctx),
    in_flight: currentInFlight()
  }));
}

function registerAuthGate(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (request: AuthedRequest, reply) => {
    if (request.url.split("?")[0] === "/health") return;

    const header = request.headers.authorization ?? "";
    const presented = header.replace(/^Bearer\s+/i, "").trim();
    if (!presented) {
      return sendGatewayError(
        reply,
        new GatewayError("authentication_error", "Missing bearer token."),
        wireFor(request)
      );
    }

    const token = authenticateConsumerToken(ctx, presented);
    if (!token) {
      return sendGatewayError(
        reply,
        new GatewayError(
          "authentication_error",
          "Invalid or revoked token. Mint a new one in the AI Gateway tab."
        ),
        wireFor(request)
      );
    }

    const config = getGatewayConfig(ctx);
    const retryAfter = checkRateLimit(token.id, config.rateLimitPerMinute);
    if (retryAfter !== null) {
      reply.header("retry-after", String(retryAfter));
      return sendGatewayError(
        reply,
        new GatewayError(
          "rate_limited",
          `Rate limit of ${config.rateLimitPerMinute}/min reached for this token.`,
          { retryAfterSeconds: retryAfter }
        ),
        wireFor(request)
      );
    }

    request.consumerToken = token;
    touchConsumerToken(ctx, token.id);
  });
}

function registerModels(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/models", async () => modelsPayload(listAvailableProviders(ctx)));
}

function registerChatCompletions(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/chat/completions", async (request: AuthedRequest, reply) => {
    const body = (request.body ?? {}) as OpenAIChatRequest;
    const started = Date.now();
    const config = getGatewayConfig(ctx);
    maybeLogBody(ctx, config, "openai", body);

    if (!tryAcquireSlot(config.maxConcurrent)) {
      reply.header("retry-after", "2");
      return sendGatewayError(
        reply,
        new GatewayError(
          "rate_limited",
          `Gateway is at its concurrency cap (${config.maxConcurrent} in flight).`,
          { retryAfterSeconds: 2 }
        ),
        "openai"
      );
    }

    try {
      if (body.stream) {
        return await streamOpenAI(ctx, request, reply, body, started);
      }

      const { response, meta } = await chatCompletion(body, gatewayDeps(ctx), {
        signal: abortOnDisconnect(request)
      });
      recordUsage(ctx, {
        tokenId: request.consumerToken?.id ?? null,
        tokenName: request.consumerToken?.name ?? null,
        provider: meta.provider,
        model: meta.requestedModel,
        wire: "openai",
        streamed: false,
        promptTokens: meta.usage.prompt_tokens,
        completionTokens: meta.usage.completion_tokens,
        statusCode: 200,
        durationMs: Date.now() - started
      });
      return reply.send(response);
    } catch (err) {
      const error = toGatewayError(err);
      recordFailure(ctx, request, "openai", body.model, error, started);
      return sendGatewayError(reply, error, "openai");
    } finally {
      releaseSlot();
    }
  });
}

function registerMessages(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/messages", async (request: AuthedRequest, reply) => {
    const body = (request.body ?? {}) as AnthropicRequest;
    const started = Date.now();
    const config = getGatewayConfig(ctx);
    maybeLogBody(ctx, config, "anthropic", body);

    if (!tryAcquireSlot(config.maxConcurrent)) {
      reply.header("retry-after", "2");
      return sendGatewayError(
        reply,
        new GatewayError(
          "rate_limited",
          `Gateway is at its concurrency cap (${config.maxConcurrent} in flight).`,
          { retryAfterSeconds: 2 }
        ),
        "anthropic"
      );
    }

    try {
      if (body.stream) {
        return await streamAnthropic(ctx, request, reply, body, started);
      }

      const { response, meta } = await anthropicMessages(body, gatewayDeps(ctx), {
        signal: abortOnDisconnect(request)
      });
      recordUsage(ctx, {
        tokenId: request.consumerToken?.id ?? null,
        tokenName: request.consumerToken?.name ?? null,
        provider: meta.provider,
        model: meta.requestedModel,
        wire: "anthropic",
        streamed: false,
        promptTokens: meta.usage.prompt_tokens,
        completionTokens: meta.usage.completion_tokens,
        statusCode: 200,
        durationMs: Date.now() - started
      });
      return reply.send(response);
    } catch (err) {
      const error = toGatewayError(err);
      recordFailure(ctx, request, "anthropic", body.model, error, started);
      return sendGatewayError(reply, error, "anthropic");
    } finally {
      releaseSlot();
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Streaming                                                                  */
/* ------------------------------------------------------------------------ */

async function streamOpenAI(
  ctx: AppContext,
  request: AuthedRequest,
  reply: FastifyReply,
  body: OpenAIChatRequest,
  started: number
): Promise<void> {
  const signal = abortOnDisconnect(request);
  // Resolve before hijacking: a bad model or missing key should still be a
  // real HTTP status, not an SSE error frame the client has to parse.
  const { chunks, sink, resolved } = chatCompletionStream(body, gatewayDeps(ctx), { signal });

  const stop = beginSSE(reply);
  let wroteAny = false;
  try {
    for await (const chunk of chunks) {
      wroteAny = true;
      stop.heartbeat();
      if (!reply.raw.write(formatSSEJson(chunk))) {
        // Respect backpressure — a slow consumer should slow the upstream read
        // rather than balloon the process's memory.
        await once(reply.raw, "drain");
      }
    }
    reply.raw.write(formatSSEDone());
    recordStreamUsage(ctx, request, "openai", resolved.requestedId, resolved.provider, sink, started, 200);
  } catch (err) {
    const error = toGatewayError(err);
    // Headers are long gone; the only honest signal left is an in-band error
    // frame followed by a clean terminator (§8.4).
    if (error.code !== "cancelled") {
      reply.raw.write(formatSSEJson(error.toOpenAIBody(), "error"));
      reply.raw.write(formatSSEDone());
    }
    recordStreamUsage(
      ctx,
      request,
      "openai",
      resolved.requestedId,
      resolved.provider,
      sink,
      started,
      error.statusCode,
      error.code
    );
    ctx.app.log.warn(
      { err: redact(error), wroteAny },
      "ai-gateway: openai stream ended in error"
    );
  } finally {
    stop.clear();
    reply.raw.end();
  }
}

async function streamAnthropic(
  ctx: AppContext,
  request: AuthedRequest,
  reply: FastifyReply,
  body: AnthropicRequest,
  started: number
): Promise<void> {
  const signal = abortOnDisconnect(request);
  const { events, sink, resolved } = messagesStream(body, gatewayDeps(ctx), { signal });

  const stop = beginSSE(reply);
  try {
    for await (const event of events) {
      stop.heartbeat();
      // Anthropic names its events; clients switch on the event field.
      if (!reply.raw.write(formatSSEJson(event, event.type))) {
        await once(reply.raw, "drain");
      }
    }
    recordStreamUsage(
      ctx,
      request,
      "anthropic",
      resolved.requestedId,
      resolved.provider,
      sink,
      started,
      200
    );
  } catch (err) {
    const error = toGatewayError(err);
    if (error.code !== "cancelled") {
      reply.raw.write(formatSSEJson(error.toAnthropicBody(), "error"));
    }
    recordStreamUsage(
      ctx,
      request,
      "anthropic",
      resolved.requestedId,
      resolved.provider,
      sink,
      started,
      error.statusCode,
      error.code
    );
    ctx.app.log.warn({ err: redact(error) }, "ai-gateway: anthropic stream ended in error");
  } finally {
    stop.clear();
    reply.raw.end();
  }
}

/**
 * Take over the socket and write SSE headers. Returns a heartbeat controller:
 * a comment frame goes out every KEEPALIVE_MS of silence, and `heartbeat()`
 * resets the timer whenever real data flows.
 */
function beginSSE(reply: FastifyReply): { heartbeat: () => void; clear: () => void } {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Tells nginx-family proxies not to buffer, which would defeat streaming.
    "x-accel-buffering": "no"
  });

  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(formatSSEComment());
        arm();
      }
    }, KEEPALIVE_MS);
  };
  arm();

  return {
    heartbeat: () => {
      if (timer) clearTimeout(timer);
      arm();
    },
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * An AbortSignal that fires when the client goes away, so the upstream call is
 * torn down instead of running to completion against a dead socket — that is
 * real money on a metered key.
 */
function abortOnDisconnect(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.on("close", () => {
    if (!request.raw.readableEnded || !controller.signal.aborted) controller.abort();
  });
  return controller.signal;
}

function wireFor(request: FastifyRequest): "openai" | "anthropic" {
  return request.url.startsWith("/v1/messages") ? "anthropic" : "openai";
}

function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  // Fastify's own validation/parse errors carry a statusCode.
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 400) {
    return new GatewayError("invalid_request", redact((err as Error).message));
  }
  return new GatewayError("upstream_error", redact(err));
}

function sendGatewayError(
  reply: FastifyReply,
  error: GatewayError,
  wire: "openai" | "anthropic"
): FastifyReply {
  if (error.retryAfterSeconds !== undefined && !reply.hasHeader("retry-after")) {
    reply.header("retry-after", String(error.retryAfterSeconds));
  }
  // `cancelled` maps to 499, which is nginx-only and not a real HTTP status —
  // nothing is listening anyway, so just close.
  if (error.code === "cancelled") return reply.code(499).send();
  return reply
    .code(error.statusCode)
    .send(wire === "anthropic" ? error.toAnthropicBody() : error.toOpenAIBody());
}

function recordFailure(
  ctx: AppContext,
  request: AuthedRequest,
  wire: "openai" | "anthropic",
  model: string | undefined,
  error: GatewayError,
  started: number
): void {
  recordUsage(ctx, {
    tokenId: request.consumerToken?.id ?? null,
    tokenName: request.consumerToken?.name ?? null,
    provider: error.provider ?? "unknown",
    model: model ?? "unknown",
    wire,
    streamed: false,
    promptTokens: 0,
    completionTokens: 0,
    statusCode: error.statusCode,
    errorCode: error.code,
    durationMs: Date.now() - started
  });
}

function recordStreamUsage(
  ctx: AppContext,
  request: AuthedRequest,
  wire: "openai" | "anthropic",
  model: string,
  provider: string,
  sink: { usage: { prompt_tokens: number; completion_tokens: number } },
  started: number,
  statusCode: number,
  errorCode?: string
): void {
  recordUsage(ctx, {
    tokenId: request.consumerToken?.id ?? null,
    tokenName: request.consumerToken?.name ?? null,
    provider,
    model,
    wire,
    streamed: true,
    // Partial usage from an aborted stream is still real spend — record it.
    promptTokens: sink.usage.prompt_tokens,
    completionTokens: sink.usage.completion_tokens,
    statusCode,
    errorCode: errorCode ?? null,
    durationMs: Date.now() - started
  });
}

/**
 * Opt-in, time-boxed request logging (§7). Off by default; when enabled it
 * still records only structure — role sequence and sizes — never text.
 */
function maybeLogBody(
  ctx: AppContext,
  config: ReturnType<typeof getGatewayConfig>,
  wire: string,
  body: unknown
): void {
  if (!bodyLoggingActive(config)) return;
  const typed = body as { model?: string; messages?: Array<{ role?: string }>; stream?: boolean };
  ctx.app.log.info(
    {
      wire,
      model: typed.model,
      stream: Boolean(typed.stream),
      message_count: typed.messages?.length ?? 0,
      roles: typed.messages?.map((m) => m.role ?? "?").join(",")
    },
    "ai-gateway: request shape (debug window active)"
  );
}
