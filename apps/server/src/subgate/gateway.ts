/**
 * The gateway core: resolve → translate → call upstream → translate back.
 *
 * Four paths, because either wire format can front either upstream:
 *
 *   openai-in  → openai-up      passthrough (model id rewritten)
 *   openai-in  → anthropic-up   translate both ways
 *   anthropic-in → anthropic-up passthrough (model id rewritten)
 *   anthropic-in → openai-up    translate both ways
 *
 * Nothing here knows about HTTP frameworks, SQLite, or ServerHoster. The
 * caller supplies credentials through `GatewayDeps` and gets back either a
 * response object or an async iterable of chunks; SSE framing, auth, metering,
 * and rate limiting all live above this layer.
 */

import { GatewayError } from "./errors.js";
import { resolveModel, type ResolvedModel } from "./models.js";
import { anthropicComplete, anthropicStream } from "./upstream/anthropic.js";
import { openaiComplete, openaiStream } from "./upstream/openai.js";
import { anthropicRequestToOpenAI, openaiRequestToAnthropic } from "./translate/request.js";
import {
  anthropicResponseToOpenAI,
  anthropicUsageToOpenAI,
  openaiResponseToAnthropic
} from "./translate/response.js";
import {
  anthropicStreamToOpenAI,
  createUsageSink,
  openaiStreamToAnthropic,
  type UsageSink
} from "./translate/stream.js";
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent,
  OpenAIChatChunk,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
  ProviderCredentials,
  ProviderId,
  UpstreamCallOptions
} from "./types.js";

export type GatewayDeps = {
  /** Returns credentials for a provider, or null when none are configured. */
  credentialsFor(provider: ProviderId): ProviderCredentials | null;
};

function requireCredentials(deps: GatewayDeps, provider: ProviderId): ProviderCredentials {
  const credentials = deps.credentialsFor(provider);
  if (!credentials?.apiKey) {
    throw new GatewayError(
      "no_provider_configured",
      `No ${provider} API key is configured on this gateway. Add one in the AI Gateway tab.`
    );
  }
  return credentials;
}

/** Which providers currently have a usable key. Drives /v1/models and routing. */
export function availableProviders(deps: GatewayDeps): ProviderId[] {
  return (["anthropic", "openai"] as ProviderId[]).filter(
    (provider) => Boolean(deps.credentialsFor(provider)?.apiKey)
  );
}

export type CompletionMeta = {
  provider: ProviderId;
  /** The id we sent upstream (may differ from what the consumer asked for). */
  upstreamModel: string;
  /** What the consumer asked for. Echoed in the response. */
  requestedModel: string;
  usage: OpenAIUsage;
  translated: boolean;
};

/* ------------------------------------------------------------------------ */
/* OpenAI wire in                                                             */
/* ------------------------------------------------------------------------ */

export async function chatCompletion(
  request: OpenAIChatRequest,
  deps: GatewayDeps,
  options: UpstreamCallOptions = {}
): Promise<{ response: OpenAIChatResponse; meta: CompletionMeta }> {
  const resolved = resolveModel(request.model, availableProviders(deps));
  const credentials = requireCredentials(deps, resolved.provider);

  if (resolved.provider === "openai") {
    const upstream = await openaiComplete(
      credentials,
      { ...request, model: resolved.upstreamId, stream: false },
      options
    );
    // Echo the consumer's own id back, not the resolved one.
    const response = { ...upstream, model: resolved.requestedId };
    return { response, meta: meta(resolved, response.usage, false) };
  }

  const anthropicRequest = openaiRequestToAnthropic(request, resolved);
  const upstream = await anthropicComplete(credentials, anthropicRequest, options);
  const response = anthropicResponseToOpenAI(upstream, resolved.requestedId);
  return { response, meta: meta(resolved, response.usage, true) };
}

/**
 * Streaming variant. Returns the chunk iterable plus a `sink` the caller reads
 * *after* the stream is exhausted to meter it — usage is only known at the end.
 */
export function chatCompletionStream(
  request: OpenAIChatRequest,
  deps: GatewayDeps,
  options: UpstreamCallOptions = {}
): { chunks: AsyncIterable<OpenAIChatChunk>; sink: UsageSink; resolved: ResolvedModel } {
  const resolved = resolveModel(request.model, availableProviders(deps));
  const credentials = requireCredentials(deps, resolved.provider);
  const sink = createUsageSink();

  if (resolved.provider === "openai") {
    const upstream = openaiStream(
      credentials,
      { ...request, model: resolved.upstreamId, stream: true },
      options
    );
    return { chunks: relabelOpenAIChunks(upstream, resolved.requestedId, sink), sink, resolved };
  }

  const anthropicRequest = openaiRequestToAnthropic(request, resolved);
  const upstream = anthropicStream(credentials, { ...anthropicRequest, stream: true }, options);
  return {
    chunks: anthropicStreamToOpenAI(upstream, { requestedModel: resolved.requestedId, sink }),
    sink,
    resolved
  };
}

/**
 * Rewrite the model id on a passthrough stream and capture usage. Cheap, but
 * it has to be a generator rather than a map because usage only appears on the
 * final chunk.
 */
async function* relabelOpenAIChunks(
  chunks: AsyncIterable<OpenAIChatChunk>,
  requestedModel: string,
  sink: UsageSink
): AsyncGenerator<OpenAIChatChunk, void, undefined> {
  for await (const chunk of chunks) {
    if (chunk.usage) sink.usage = chunk.usage;
    const finish = chunk.choices?.[0]?.finish_reason;
    if (finish) sink.finishReason = finish;
    yield { ...chunk, model: requestedModel };
  }
  sink.completed = true;
}

/* ------------------------------------------------------------------------ */
/* Anthropic wire in                                                          */
/* ------------------------------------------------------------------------ */

export async function messages(
  request: AnthropicRequest,
  deps: GatewayDeps,
  options: UpstreamCallOptions = {}
): Promise<{ response: AnthropicResponse; meta: CompletionMeta }> {
  const resolved = resolveModel(request.model, availableProviders(deps));
  const credentials = requireCredentials(deps, resolved.provider);

  if (resolved.provider === "anthropic") {
    const upstream = await anthropicComplete(
      credentials,
      { ...request, model: resolved.upstreamId, stream: false },
      options
    );
    const response = { ...upstream, model: resolved.requestedId };
    return { response, meta: meta(resolved, anthropicUsageToOpenAI(response.usage), false) };
  }

  const openaiRequest = anthropicRequestToOpenAI(request, resolved);
  const upstream = await openaiComplete(credentials, openaiRequest, options);
  const response = openaiResponseToAnthropic(upstream, resolved.requestedId);
  return { response, meta: meta(resolved, upstream.usage, true) };
}

export function messagesStream(
  request: AnthropicRequest,
  deps: GatewayDeps,
  options: UpstreamCallOptions = {}
): { events: AsyncIterable<AnthropicStreamEvent>; sink: UsageSink; resolved: ResolvedModel } {
  const resolved = resolveModel(request.model, availableProviders(deps));
  const credentials = requireCredentials(deps, resolved.provider);
  const sink = createUsageSink();

  if (resolved.provider === "anthropic") {
    const upstream = anthropicStream(
      credentials,
      { ...request, model: resolved.upstreamId, stream: true },
      options
    );
    return { events: relabelAnthropicEvents(upstream, resolved.requestedId, sink), sink, resolved };
  }

  const openaiRequest = anthropicRequestToOpenAI(request, resolved);
  const upstream = openaiStream(credentials, { ...openaiRequest, stream: true }, options);
  return {
    events: openaiStreamToAnthropic(upstream, { requestedModel: resolved.requestedId, sink }),
    sink,
    resolved
  };
}

async function* relabelAnthropicEvents(
  events: AsyncIterable<AnthropicStreamEvent>,
  requestedModel: string,
  sink: UsageSink
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  let inputTokens = 0;
  for await (const event of events) {
    if (event.type === "message_start") {
      inputTokens = event.message?.usage?.input_tokens ?? 0;
      sink.usage = anthropicUsageToOpenAI(event.message?.usage);
      yield {
        ...event,
        message: { ...event.message, model: requestedModel }
      };
      continue;
    }
    if (event.type === "message_delta") {
      const output = event.usage?.output_tokens ?? 0;
      sink.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: output,
        total_tokens: inputTokens + output
      };
    }
    if (event.type === "message_stop") sink.completed = true;
    yield event;
  }
}

function meta(resolved: ResolvedModel, usage: OpenAIUsage, translated: boolean): CompletionMeta {
  return {
    provider: resolved.provider,
    upstreamModel: resolved.upstreamId,
    requestedModel: resolved.requestedId,
    usage,
    translated
  };
}
