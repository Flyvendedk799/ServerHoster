/**
 * Streaming translation, both directions.
 *
 * The subtle part is tool-call indices. Anthropic indexes *content blocks* —
 * text and tool_use share one counter. OpenAI indexes *tool calls* only. A
 * response of [text, tool_use, tool_use] is Anthropic blocks 0,1,2 but OpenAI
 * tool_calls 0,1. Passing the block index straight through produces tool calls
 * numbered 1 and 2, and every OpenAI SDK assembles arguments into the wrong
 * slot — silently, because a sparse array still looks plausible.
 *
 * Both translators accumulate usage into a caller-supplied sink so the caller
 * can meter a stream without buffering it.
 *
 * Framework-free: imports only sibling core modules.
 */

import type {
  AnthropicStreamEvent,
  AnthropicUsage,
  OpenAIChatChunk,
  OpenAIChunkToolCall,
  OpenAIUsage
} from "../types.js";
import {
  anthropicIdFrom,
  anthropicStopToOpenAI,
  anthropicUsageToOpenAI,
  nowSeconds,
  openaiFinishToAnthropic,
  openaiIdFrom
} from "./response.js";

/** Mutable accumulator so a caller can meter a stream it never buffers. */
export type UsageSink = {
  usage: OpenAIUsage;
  /** Set once the terminal event is seen. Distinguishes clean end from abort. */
  completed: boolean;
  finishReason: OpenAIChatChunk["choices"][number]["finish_reason"];
};

export function createUsageSink(): UsageSink {
  return {
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    completed: false,
    finishReason: null
  };
}

/* ------------------------------------------------------------------------ */
/* Anthropic SSE → OpenAI chunks                                              */
/* ------------------------------------------------------------------------ */

export async function* anthropicStreamToOpenAI(
  events: AsyncIterable<AnthropicStreamEvent>,
  options: { requestedModel: string; sink?: UsageSink }
): AsyncGenerator<OpenAIChatChunk, void, undefined> {
  const { requestedModel } = options;
  const sink = options.sink;
  const created = nowSeconds();
  let id = openaiIdFrom(undefined);

  // Anthropic content-block index → OpenAI tool_call index.
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;
  let sentRole = false;
  let inputTokens = 0;

  const base = (): Omit<OpenAIChatChunk, "choices"> => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel
  });

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        id = openaiIdFrom(event.message?.id);
        inputTokens = event.message?.usage?.input_tokens ?? 0;
        if (sink) {
          sink.usage = anthropicUsageToOpenAI(event.message?.usage as AnthropicUsage | undefined);
        }
        // OpenAI's first chunk carries the role and no content.
        sentRole = true;
        yield {
          ...base(),
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        };
        break;
      }

      case "content_block_start": {
        if (event.content_block.type === "tool_use") {
          const toolIndex = nextToolIndex++;
          toolIndexByBlock.set(event.index, toolIndex);
          // Name and id arrive here; arguments stream as input_json_delta.
          yield {
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: event.content_block.id,
                      type: "function",
                      function: { name: event.content_block.name, arguments: "" }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          };
        } else if (event.content_block.type === "text" && event.content_block.text) {
          // Anthropic may seed a text block with content; don't drop it.
          yield {
            ...base(),
            choices: [
              { index: 0, delta: { content: event.content_block.text }, finish_reason: null }
            ]
          };
        }
        break;
      }

      case "content_block_delta": {
        if (event.delta.type === "text_delta") {
          if (!event.delta.text) break;
          yield {
            ...base(),
            choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }]
          };
        } else if (event.delta.type === "input_json_delta") {
          const toolIndex = toolIndexByBlock.get(event.index);
          // A delta for a block we never saw start would corrupt the assembly;
          // drop it rather than guess an index.
          if (toolIndex === undefined) break;
          yield {
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: toolIndex, function: { arguments: event.delta.partial_json } }
                  ]
                },
                finish_reason: null
              }
            ]
          };
        }
        break;
      }

      case "message_delta": {
        const finish = anthropicStopToOpenAI(event.delta?.stop_reason ?? null);
        const outputTokens = event.usage?.output_tokens ?? 0;
        if (sink) {
          sink.usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
          };
          sink.finishReason = finish;
        }
        // OpenAI signals completion with an empty delta carrying finish_reason.
        yield { ...base(), choices: [{ index: 0, delta: {}, finish_reason: finish }] };
        break;
      }

      case "message_stop": {
        if (sink) sink.completed = true;
        break;
      }

      case "error": {
        // Surfacing the upstream's mid-stream failure as an OpenAI-shaped
        // terminal chunk is the only option once headers are sent — the status
        // code is long gone. The caller also writes an `error` SSE event.
        if (sink) sink.finishReason = "stop";
        yield { ...base(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        break;
      }

      default:
        // `ping`, `content_block_stop`, and anything added upstream later:
        // nothing to emit, and unknown events must not abort the stream.
        break;
    }
  }

  // An upstream that closed without ever emitting message_start still needs a
  // syntactically valid stream, or the client SDK throws on an empty body.
  if (!sentRole) {
    yield { ...base(), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] };
  }
}

/* ------------------------------------------------------------------------ */
/* OpenAI chunks → Anthropic SSE                                              */
/* ------------------------------------------------------------------------ */

export async function* openaiStreamToAnthropic(
  chunks: AsyncIterable<OpenAIChatChunk>,
  options: { requestedModel: string; sink?: UsageSink }
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  const { requestedModel } = options;
  const sink = options.sink;

  let started = false;
  let messageId = anthropicIdFrom(undefined);
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  // OpenAI tool_call index → Anthropic content-block index.
  const blockByToolIndex = new Map<number, number>();
  let finishReason: OpenAIChatChunk["choices"][number]["finish_reason"] = null;
  let usage: OpenAIUsage | undefined;

  const openMessage = function* (chunkId: string): Generator<AnthropicStreamEvent> {
    messageId = anthropicIdFrom(chunkId);
    started = true;
    yield {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
  };

  for await (const chunk of chunks) {
    if (!started) yield* openMessage(chunk.id);
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const content = choice.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      if (textBlockIndex === null) {
        textBlockIndex = nextBlockIndex++;
        yield {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" }
        };
      }
      yield {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: content }
      };
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      yield* emitToolCall(call);
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  function* emitToolCall(call: OpenAIChunkToolCall): Generator<AnthropicStreamEvent> {
    let blockIndex = blockByToolIndex.get(call.index);
    if (blockIndex === undefined) {
      // A text block that is still open must be closed first — Anthropic
      // requires blocks to be strictly nested, not interleaved.
      if (textBlockIndex !== null) {
        yield { type: "content_block_stop", index: textBlockIndex };
        textBlockIndex = null;
      }
      blockIndex = nextBlockIndex++;
      blockByToolIndex.set(call.index, blockIndex);
      yield {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: call.id ?? `toolu_${call.index}`,
          name: call.function?.name ?? "",
          input: {}
        }
      };
    }
    const args = call.function?.arguments;
    if (args) {
      yield {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: args }
      };
    }
  }

  // Nothing arrived at all — still emit a well-formed empty message.
  if (!started) yield* openMessage(messageId);

  if (textBlockIndex !== null) yield { type: "content_block_stop", index: textBlockIndex };
  for (const blockIndex of blockByToolIndex.values()) {
    yield { type: "content_block_stop", index: blockIndex };
  }

  if (sink) {
    sink.usage = usage ?? sink.usage;
    sink.finishReason = finishReason;
    sink.completed = true;
  }

  yield {
    type: "message_delta",
    delta: { stop_reason: openaiFinishToAnthropic(finishReason), stop_sequence: null },
    usage: { output_tokens: usage?.completion_tokens ?? 0 }
  };
  yield { type: "message_stop" };
}
