/**
 * Request translation, both directions.
 *
 * The hard parts are tool calls and role mapping. OpenAI models a tool result
 * as its own `role: "tool"` message; Anthropic models it as a `tool_result`
 * content block inside a *user* turn. Getting that wrong doesn't error — it
 * produces a model that has forgotten it called a tool, which is why §8.3
 * asks for a round-trip test over tool calls specifically.
 *
 * Framework-free: imports only sibling core modules.
 */

import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../models.js";
import type {
  AnthropicContentBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice
} from "../types.js";

/* ------------------------------------------------------------------------ */
/* OpenAI → Anthropic                                                         */
/* ------------------------------------------------------------------------ */

export function openaiRequestToAnthropic(
  req: OpenAIChatRequest,
  resolved: ResolvedModel
): AnthropicRequest {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new GatewayError("invalid_request", "`messages` must be a non-empty array.");
  }

  const systemChunks: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of req.messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        // Anthropic has no system *turn* — system is a top-level field. Several
        // system messages concatenate in order.
        const text = flattenOpenAIContent(message.content);
        if (text) systemChunks.push(text);
        break;
      }
      case "user": {
        pushMerged(messages, { role: "user", content: openaiContentToBlocks(message.content) });
        break;
      }
      case "assistant": {
        const blocks: AnthropicContentBlock[] = [];
        const text = flattenOpenAIContent(message.content);
        if (text) blocks.push({ type: "text", text });
        for (const call of message.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments, call.function.name)
          });
        }
        // An assistant turn with neither text nor tool calls is meaningless to
        // Anthropic and errors upstream; drop it rather than send an empty turn.
        if (blocks.length > 0) pushMerged(messages, { role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        if (!message.tool_call_id) {
          throw new GatewayError(
            "invalid_request",
            "A `role: \"tool\"` message requires `tool_call_id`."
          );
        }
        // Tool results ride in a user turn on the Anthropic wire.
        pushMerged(messages, {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: flattenOpenAIContent(message.content) || ""
            }
          ]
        });
        break;
      }
      default:
        throw new GatewayError("invalid_request", `Unsupported message role "${String(message.role)}".`);
    }
  }

  if (messages.length === 0) {
    throw new GatewayError(
      "invalid_request",
      "`messages` contained only system messages — at least one user turn is required."
    );
  }

  // OpenAI's `response_format: json_object` has no Anthropic equivalent. The
  // honest translation is an instruction, not silent omission.
  if (req.response_format?.type === "json_object") {
    systemChunks.push("Respond with a single valid JSON object and no other text.");
  }

  const requestedMax = req.max_completion_tokens ?? req.max_tokens;
  const out: AnthropicRequest = {
    model: resolved.upstreamId,
    messages,
    // Anthropic requires max_tokens; OpenAI treats it as optional. Fall back to
    // the model's cap, and clamp an over-large request rather than 400ing.
    max_tokens: clampMaxTokens(requestedMax, resolved.maxOutputTokens)
  };

  if (systemChunks.length > 0) out.system = systemChunks.join("\n\n");
  if (req.stream) out.stream = true;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;

  const stops = normalizeStop(req.stop);
  if (stops.length > 0) out.stop_sequences = stops;

  if (req.tools && req.tools.length > 0) out.tools = req.tools.map(openaiToolToAnthropic);
  const toolChoice = openaiToolChoiceToAnthropic(req.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  // `user` is deliberately NOT forwarded. It is a consumer-side identifier and
  // sending it upstream would export an end-user id we were only given for
  // rate-accounting. See §7 "prompt content is user data".

  return out;
}

function openaiToolToAnthropic(tool: OpenAITool): AnthropicTool {
  if (tool.type !== "function" || !tool.function?.name) {
    throw new GatewayError("invalid_request", "Only `type: \"function\"` tools are supported.");
  }
  return {
    name: tool.function.name,
    description: tool.function.description,
    // Anthropic requires an object schema; an omitted `parameters` means
    // "no arguments", which is an empty object schema, not undefined.
    input_schema: (tool.function.parameters as Record<string, unknown> | undefined) ?? {
      type: "object",
      properties: {}
    }
  };
}

function openaiToolChoiceToAnthropic(choice: OpenAIToolChoice | undefined): AnthropicToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function openaiContentToBlocks(
  content: OpenAIMessage["content"]
): AnthropicContentBlock[] {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      blocks.push({ type: "image", source: imageUrlToAnthropicSource(part.image_url.url) });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * `data:` URLs carry the bytes inline and become a base64 source; anything
 * else is handed over as a URL source for the upstream to fetch.
 */
function imageUrlToAnthropicSource(url: string): AnthropicImageSource {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return { type: "base64", media_type: dataUrl[1], data: dataUrl[2] };
  }
  return { type: "url", url };
}

/* ------------------------------------------------------------------------ */
/* Anthropic → OpenAI                                                         */
/* ------------------------------------------------------------------------ */

export function anthropicRequestToOpenAI(
  req: AnthropicRequest,
  resolved: ResolvedModel
): OpenAIChatRequest {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new GatewayError("invalid_request", "`messages` must be a non-empty array.");
  }

  const messages: OpenAIMessage[] = [];

  const system = flattenAnthropicSystem(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of req.messages) {
    const blocks = normalizeAnthropicContent(message.content);

    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          });
        }
      }
      const assistant: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    // A user turn can hold both tool results and ordinary content. Tool results
    // become their own `role: "tool"` messages and must precede the user turn
    // they were bundled with, or OpenAI rejects the ordering.
    const userParts: OpenAIContentPart[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenToolResultContent(block.content)
        });
      } else if (block.type === "text") {
        userParts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        userParts.push({ type: "image_url", image_url: { url: anthropicSourceToUrl(block.source) } });
      }
    }
    if (userParts.length > 0) {
      // Collapse a pure-text turn back to a plain string — that is what the
      // OpenAI SDKs emit, and some upstream proxies are stricter than the spec.
      const onlyText = userParts.every((part) => part.type === "text");
      messages.push({
        role: "user",
        content: onlyText
          ? userParts.map((part) => (part as { text: string }).text).join("")
          : userParts
      });
    }
  }

  const out: OpenAIChatRequest = {
    model: resolved.upstreamId,
    messages,
    max_tokens: clampMaxTokens(req.max_tokens, resolved.maxOutputTokens)
  };

  if (req.stream) out.stream = true;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));
  }

  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (req.tool_choice.type === "any") out.tool_choice = "required";
    else if (req.tool_choice.type === "none") out.tool_choice = "none";
    else if (req.tool_choice.type === "tool") {
      out.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
    }
  }

  return out;
}

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Anthropic rejects consecutive turns of the same role. OpenAI conversations
 * routinely contain them (two system-adjacent user messages, a tool result
 * followed by a user follow-up), so merge rather than reject.
 */
function pushMerged(messages: AnthropicMessage[], next: AnthropicMessage): void {
  const previous = messages[messages.length - 1];
  if (previous && previous.role === next.role) {
    previous.content = [
      ...normalizeAnthropicContent(previous.content),
      ...normalizeAnthropicContent(next.content)
    ];
    return;
  }
  messages.push(next);
}

export function normalizeAnthropicContent(
  content: AnthropicMessage["content"]
): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export function flattenOpenAIContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function flattenAnthropicSystem(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function flattenToolResultContent(
  content: string | Array<{ type: "text"; text: string }>
): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.text).join("");
}

function anthropicSourceToUrl(source: AnthropicImageSource): string {
  if (source.type === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

/**
 * Tool arguments arrive as a JSON *string* on the OpenAI wire and as a parsed
 * object on the Anthropic wire. A model occasionally emits invalid JSON here;
 * surfacing that as a 400 naming the tool beats forwarding a broken object and
 * getting an opaque upstream error.
 */
function parseToolArguments(raw: string, toolName: string): unknown {
  if (!raw || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError(
      "invalid_request",
      `Tool call arguments for "${toolName}" are not valid JSON.`
    );
  }
}

function clampMaxTokens(requested: number | undefined, cap: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return cap;
  return Math.min(Math.floor(requested), cap);
}

function normalizeStop(stop: OpenAIChatRequest["stop"]): string[] {
  if (!stop) return [];
  const list = Array.isArray(stop) ? stop : [stop];
  // Anthropic rejects empty stop sequences outright.
  return list.filter((value) => typeof value === "string" && value.length > 0);
}
