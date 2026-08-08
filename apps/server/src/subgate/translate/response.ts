/**
 * Non-streaming response translation, both directions.
 *
 * The model id echoed back is always the id the *consumer* asked for, not the
 * upstream id we resolved it to. A client that requested "sonnet" and got back
 * "claude-sonnet-5" would see its own cache keys and assertions break.
 *
 * Framework-free: imports only sibling core modules.
 */

import type {
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicStopReason,
  OpenAIChatResponse,
  OpenAIFinishReason,
  OpenAIToolCall,
  OpenAIUsage
} from "../types.js";

/* ------------------------------------------------------------------------ */
/* Stop-reason mapping                                                        */
/* ------------------------------------------------------------------------ */

export function anthropicStopToOpenAI(reason: AnthropicStopReason): OpenAIFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return null;
  }
}

export function openaiFinishToAnthropic(reason: OpenAIFinishReason): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Usage                                                                      */
/* ------------------------------------------------------------------------ */

export function anthropicUsageToOpenAI(usage: AnthropicResponse["usage"] | undefined): OpenAIUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  // Cache reads/creations are real input tokens the consumer was billed for;
  // fold them in so the gateway's own metering matches the vendor invoice.
  const cached = (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  return {
    prompt_tokens: input + cached,
    completion_tokens: output,
    total_tokens: input + cached + output
  };
}

export function openaiUsageToAnthropic(usage: OpenAIUsage | undefined): AnthropicResponse["usage"] {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0
  };
}

/* ------------------------------------------------------------------------ */
/* Anthropic → OpenAI                                                         */
/* ------------------------------------------------------------------------ */

export function anthropicResponseToOpenAI(
  response: AnthropicResponse,
  requestedModel: string
): OpenAIChatResponse {
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of response.content ?? []) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }

  const message: OpenAIChatResponse["choices"][number]["message"] = {
    role: "assistant",
    // OpenAI uses `null`, not `""`, when the turn was purely tool calls. SDKs
    // branch on that to decide whether to render a message.
    content: textParts.length > 0 ? textParts.join("") : null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: openaiIdFrom(response.id),
    object: "chat.completion",
    created: nowSeconds(),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicStopToOpenAI(response.stop_reason)
      }
    ],
    usage: anthropicUsageToOpenAI(response.usage)
  };
}

/* ------------------------------------------------------------------------ */
/* OpenAI → Anthropic                                                         */
/* ------------------------------------------------------------------------ */

export function openaiResponseToAnthropic(
  response: OpenAIChatResponse,
  requestedModel: string
): AnthropicResponse {
  const choice = response.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: safeParseJson(call.function.arguments)
    });
  }
  // Anthropic responses always carry at least one block.
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: anthropicIdFrom(response.id),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: openaiFinishToAnthropic(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: openaiUsageToAnthropic(response.usage)
  };
}

/* ------------------------------------------------------------------------ */
/* Id helpers                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * OpenAI SDKs don't validate the prefix, but tooling and logs assume
 * `chatcmpl-`; keep the upstream id inside it so a support request can still
 * be traced back to the Anthropic message.
 */
export function openaiIdFrom(upstreamId: string | undefined): string {
  if (!upstreamId) return `chatcmpl-${randomSuffix()}`;
  return upstreamId.startsWith("chatcmpl-") ? upstreamId : `chatcmpl-${upstreamId}`;
}

export function anthropicIdFrom(upstreamId: string | undefined): string {
  if (!upstreamId) return `msg_${randomSuffix()}`;
  return upstreamId.startsWith("msg_") ? upstreamId : `msg_${upstreamId.replace(/^chatcmpl-/, "")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Tool arguments from a model are occasionally malformed; never throw here. */
function safeParseJson(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Preserve the raw text so the caller can see what the model emitted
    // rather than receiving a silently empty object.
    return { __unparsed_arguments: raw };
  }
}
