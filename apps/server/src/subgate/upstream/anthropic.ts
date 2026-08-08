/**
 * Anthropic upstream — `POST /v1/messages` with an API key.
 *
 * Authentication is `x-api-key` + `anthropic-version` (see buildHeaders). That
 * is the documented API-key path; it needs no client-identity headers and no
 * beta flags, which is why this file is short.
 *
 * Framework-free: imports only sibling core modules.
 */

import { GatewayError } from "../errors.js";
import { parseSSE } from "../sse.js";
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent,
  ProviderCredentials,
  UpstreamCallOptions
} from "../types.js";
import { buildHeaders, fetchUpstream, normalizeBaseUrl, readJson } from "./http.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

function messagesUrl(credentials: ProviderCredentials): string {
  return `${normalizeBaseUrl(credentials.baseUrl, ANTHROPIC_DEFAULT_BASE_URL)}/v1/messages`;
}

export async function anthropicComplete(
  credentials: ProviderCredentials,
  request: AnthropicRequest,
  options: UpstreamCallOptions = {}
): Promise<AnthropicResponse> {
  const response = await fetchUpstream(
    "anthropic",
    {
      url: messagesUrl(credentials),
      headers: buildHeaders(credentials),
      body: { ...request, stream: false }
    },
    options
  );
  return readJson<AnthropicResponse>("anthropic", response);
}

/**
 * Stream `POST /v1/messages`.
 *
 * Anthropic names its SSE events (`event: content_block_delta`) and the payload
 * repeats the type, so we parse from `data` and fall back to the event name
 * only when the payload omits it.
 */
export async function* anthropicStream(
  credentials: ProviderCredentials,
  request: AnthropicRequest,
  options: UpstreamCallOptions = {}
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  const response = await fetchUpstream(
    "anthropic",
    {
      url: messagesUrl(credentials),
      headers: buildHeaders(credentials, { accept: "text/event-stream" }),
      body: { ...request, stream: true }
    },
    options
  );

  if (!response.body) {
    throw new GatewayError("upstream_error", "anthropic returned an empty stream body.", {
      provider: "anthropic"
    });
  }

  for await (const message of parseSSE(response.body, options.signal)) {
    if (!message.data) continue;
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(message.data) as AnthropicStreamEvent;
    } catch {
      // A malformed frame mid-stream is not worth killing the response over;
      // the client has already received tokens. Skip it.
      continue;
    }
    if (!event.type && message.event) {
      (event as { type: string }).type = message.event;
    }

    // Anthropic reports mid-stream failures as an `error` event with a 200
    // status. Turn it into a real error so the caller's mid-stream handling
    // runs instead of the stream just stopping short.
    if (event.type === "error") {
      throw new GatewayError(
        "upstream_error",
        `anthropic stream error: ${event.error?.message ?? "unknown"}`,
        { provider: "anthropic" }
      );
    }

    yield event;
    if (event.type === "message_stop") return;
  }
}
