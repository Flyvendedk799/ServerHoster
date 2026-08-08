/**
 * OpenAI upstream — `POST /v1/chat/completions` with an API key.
 *
 * `baseUrl` is honoured so this same client can address any OpenAI-compatible
 * endpoint (Azure OpenAI, a local vLLM, another SubGate) without a code change.
 *
 * Framework-free: imports only sibling core modules.
 */

import { GatewayError } from "../errors.js";
import { SSE_DONE, parseSSE } from "../sse.js";
import type {
  OpenAIChatChunk,
  OpenAIChatRequest,
  OpenAIChatResponse,
  ProviderCredentials,
  UpstreamCallOptions
} from "../types.js";
import { buildHeaders, fetchUpstream, normalizeBaseUrl, readJson } from "./http.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

function completionsUrl(credentials: ProviderCredentials): string {
  return `${normalizeBaseUrl(credentials.baseUrl, OPENAI_DEFAULT_BASE_URL)}/v1/chat/completions`;
}

export async function openaiComplete(
  credentials: ProviderCredentials,
  request: OpenAIChatRequest,
  options: UpstreamCallOptions = {}
): Promise<OpenAIChatResponse> {
  const response = await fetchUpstream(
    "openai",
    {
      url: completionsUrl(credentials),
      headers: buildHeaders(credentials),
      body: { ...request, stream: false }
    },
    options
  );
  return readJson<OpenAIChatResponse>("openai", response);
}

export async function* openaiStream(
  credentials: ProviderCredentials,
  request: OpenAIChatRequest,
  options: UpstreamCallOptions = {}
): AsyncGenerator<OpenAIChatChunk, void, undefined> {
  const response = await fetchUpstream(
    "openai",
    {
      url: completionsUrl(credentials),
      headers: buildHeaders(credentials, { accept: "text/event-stream" }),
      body: {
        ...request,
        stream: true,
        // Without this the final chunk carries no usage and the gateway has to
        // guess at metering. Harmless on endpoints that ignore it.
        stream_options: { include_usage: true }
      }
    },
    options
  );

  if (!response.body) {
    throw new GatewayError("upstream_error", "openai returned an empty stream body.", {
      provider: "openai"
    });
  }

  for await (const message of parseSSE(response.body, options.signal)) {
    if (!message.data) continue;
    if (message.data === SSE_DONE) return;

    let chunk: OpenAIChatChunk & { error?: { message?: string } };
    try {
      chunk = JSON.parse(message.data) as OpenAIChatChunk & { error?: { message?: string } };
    } catch {
      // Malformed frame mid-stream — skip rather than abort a response the
      // client has already started rendering.
      continue;
    }

    // A 200 that turns into an error object partway through.
    if (chunk.error) {
      throw new GatewayError(
        "upstream_error",
        `openai stream error: ${chunk.error.message ?? "unknown"}`,
        { provider: "openai" }
      );
    }

    yield chunk;
  }
}
