/**
 * SubGate core tests.
 *
 * These exercise `src/subgate/` only — no database, no Fastify, no native
 * modules — which is the same property that makes the core extractable to the
 * standalone repo. They run under the repo's existing `node:test` runner.
 *
 * §8 ordering: the never-leak suite is first, deliberately.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { GatewayError, fromUpstreamResponse } from "./subgate/errors.js";
import {
  clearRegisteredSecrets,
  containsRegisteredSecret,
  maskCredential,
  redact,
  registerSecret
} from "./subgate/redact.js";
import { resetModels, resolveModel, modelsPayload } from "./subgate/models.js";
import { formatSSE, formatSSEJson, parseSSE } from "./subgate/sse.js";
import { buildHeaders, redactHeaders } from "./subgate/upstream/http.js";
import { anthropicStream } from "./subgate/upstream/anthropic.js";
import { openaiStream } from "./subgate/upstream/openai.js";
import {
  anthropicRequestToOpenAI,
  openaiRequestToAnthropic
} from "./subgate/translate/request.js";
import {
  anthropicResponseToOpenAI,
  openaiResponseToAnthropic
} from "./subgate/translate/response.js";
import {
  anthropicStreamToOpenAI,
  createUsageSink,
  openaiStreamToAnthropic
} from "./subgate/translate/stream.js";
import { chatCompletion, chatCompletionStream } from "./subgate/gateway.js";
import type {
  AnthropicRequest,
  AnthropicStreamEvent,
  OpenAIChatChunk,
  OpenAIChatRequest,
  ProviderCredentials,
  ProviderId
} from "./subgate/types.js";

/* ------------------------------------------------------------------------ */
/* Fixtures + helpers                                                         */
/* ------------------------------------------------------------------------ */

const FAKE_ANTHROPIC_KEY = "sk-ant-api03-NOTAREALKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_OPENAI_KEY = "sk-proj-NOTAREALKEY-abcdefghijklmnopqrstuvwxyz0123456789";

function credentialsFor(provider: ProviderId): ProviderCredentials | null {
  if (provider === "anthropic") return { provider, apiKey: FAKE_ANTHROPIC_KEY };
  return { provider, apiKey: FAKE_OPENAI_KEY };
}

const deps = { credentialsFor };

/** Build a ReadableStream of UTF-8 bytes from string pieces, as fetch returns. */
function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= pieces.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(pieces[index++]));
    }
  });
}

const realFetch = globalThis.fetch;

/** Install a fake `fetch`. Returns the recorded calls. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function sseResponse(pieces: string[]): Response {
  return new Response(streamOf(pieces), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

beforeEach(() => {
  clearRegisteredSecrets();
  resetModels();
  registerSecret(FAKE_ANTHROPIC_KEY);
  registerSecret(FAKE_OPENAI_KEY);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------------ */
/* 1. Never-leak (§8.6 — written first)                                       */
/* ------------------------------------------------------------------------ */

describe("never-leak", () => {
  test("redact() masks a registered credential anywhere in the text", () => {
    const text = `calling upstream with key ${FAKE_ANTHROPIC_KEY} now`;
    const safe = redact(text);
    assert.ok(!safe.includes(FAKE_ANTHROPIC_KEY));
    assert.ok(safe.includes("[redacted]"));
    assert.equal(containsRegisteredSecret(safe), false);
  });

  test("redact() masks credential shapes that were never registered", () => {
    clearRegisteredSecrets();
    const unknownKey = "sk-ant-api03-SOMEONEELSESKEY-zyxwvutsrqponmlkjihgfedcba98765";
    const safe = redact(`error: bad key ${unknownKey}`);
    assert.ok(!safe.includes(unknownKey));
  });

  test("redact() masks Authorization headers in serialised dumps", () => {
    const safe = redact({ headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}` } });
    assert.ok(!safe.includes(FAKE_OPENAI_KEY));
  });

  test("redactHeaders() masks every credential-bearing header", () => {
    const anthropic = redactHeaders(buildHeaders({ provider: "anthropic", apiKey: FAKE_ANTHROPIC_KEY }));
    const openai = redactHeaders(buildHeaders({ provider: "openai", apiKey: FAKE_OPENAI_KEY }));
    assert.equal(anthropic["x-api-key"], "[redacted]");
    assert.equal(anthropic["anthropic-version"], "2023-06-01");
    assert.equal(openai.authorization, "[redacted]");
    assert.ok(!JSON.stringify(anthropic).includes(FAKE_ANTHROPIC_KEY));
    assert.ok(!JSON.stringify(openai).includes(FAKE_OPENAI_KEY));
  });

  test("buildHeaders is the only place the key appears, and it does appear there", () => {
    // Guards against the opposite failure: redaction so aggressive that the
    // real request stops authenticating.
    const headers = buildHeaders({ provider: "anthropic", apiKey: FAKE_ANTHROPIC_KEY });
    assert.equal(headers["x-api-key"], FAKE_ANTHROPIC_KEY);
  });

  test("an upstream error echoing the key back does not leak it into the error", () => {
    // Real providers do this: a 400 quotes the offending request, headers included.
    const hostileBody = JSON.stringify({
      error: { message: `Invalid request. Received x-api-key: ${FAKE_ANTHROPIC_KEY}` }
    });
    const error = fromUpstreamResponse("anthropic", 400, hostileBody);
    assert.ok(!error.message.includes(FAKE_ANTHROPIC_KEY));
    assert.ok(!JSON.stringify(error.toOpenAIBody()).includes(FAKE_ANTHROPIC_KEY));
    assert.ok(!JSON.stringify(error.toAnthropicBody()).includes(FAKE_ANTHROPIC_KEY));
  });

  test("a full failing request produces no credential in any surface", async () => {
    stubFetch(() =>
      jsonResponse({ error: { message: `auth failed for ${FAKE_ANTHROPIC_KEY}` } }, 401)
    );
    await assert.rejects(
      () => chatCompletion({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }, deps),
      (err: unknown) => {
        assert.ok(err instanceof GatewayError);
        const surfaces = [
          err.message,
          JSON.stringify(err.toOpenAIBody()),
          JSON.stringify(err.toAnthropicBody()),
          String(err.stack)
        ];
        for (const surface of surfaces) {
          assert.equal(containsRegisteredSecret(surface), false, `leaked in: ${surface}`);
        }
        return true;
      }
    );
  });

  test("maskCredential never returns enough to reconstruct the key", () => {
    const masked = maskCredential(FAKE_ANTHROPIC_KEY);
    assert.ok(masked.length < 16);
    assert.ok(!masked.includes("NOTAREALKEY"));
  });
});

/* ------------------------------------------------------------------------ */
/* 2. Credentials + provider availability (§8.2 equivalent)                   */
/* ------------------------------------------------------------------------ */

describe("provider routing", () => {
  test("a model routed to an unconfigured provider is an explicit error, not a reroute", () => {
    assert.throws(
      () => resolveModel("gpt-4o", ["anthropic"]),
      (err: unknown) => err instanceof GatewayError && err.code === "no_provider_configured"
    );
  });

  test("missing credentials surface as 503, not 500", async () => {
    await assert.rejects(
      () =>
        chatCompletion({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }, {
          credentialsFor: () => null
        }),
      (err: unknown) => {
        assert.ok(err instanceof GatewayError);
        assert.equal(err.code, "no_provider_configured");
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  });

  test("aliases and prefix routing both resolve", () => {
    assert.equal(resolveModel("sonnet").provider, "anthropic");
    assert.equal(resolveModel("sonnet").upstreamId, "claude-sonnet-5");
    // Not in the table — prefix routing keeps a newly released id working.
    const inferred = resolveModel("claude-opus-9-future");
    assert.equal(inferred.provider, "anthropic");
    assert.equal(inferred.inferred, true);
    assert.equal(resolveModel("o3-mini").provider, "openai");
  });

  test("an unroutable model is a 404 rather than a guess", () => {
    assert.throws(
      () => resolveModel("llama-3-70b"),
      (err: unknown) => err instanceof GatewayError && err.code === "not_found"
    );
  });

  test("/v1/models lists only providers that have credentials", () => {
    const payload = modelsPayload(["anthropic"]);
    assert.ok(payload.data.length > 0);
    assert.ok(payload.data.every((model) => model.owned_by === "anthropic"));
  });
});

/* ------------------------------------------------------------------------ */
/* 3. Translation (§8.3)                                                      */
/* ------------------------------------------------------------------------ */

describe("translation: OpenAI -> Anthropic", () => {
  const resolved = { provider: "anthropic" as const, upstreamId: "claude-sonnet-5", requestedId: "sonnet", maxOutputTokens: 64000, inferred: false };

  test("system messages are lifted out of the turn list and concatenated", () => {
    const out = openaiRequestToAnthropic(
      {
        model: "sonnet",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "system", content: "Answer in English." },
          { role: "user", content: "hello" }
        ]
      },
      resolved
    );
    assert.equal(out.system, "You are terse.\n\nAnswer in English.");
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "user");
  });

  test("assistant tool_calls become tool_use blocks and tool replies become tool_result", () => {
    const out = openaiRequestToAnthropic(
      {
        model: "sonnet",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "12C" },
          { role: "user", content: "thanks" }
        ]
      },
      resolved
    );

    const assistant = out.messages[1];
    assert.equal(assistant.role, "assistant");
    const toolUse = (assistant.content as Array<{ type: string; name?: string; input?: unknown }>)[0];
    assert.equal(toolUse.type, "tool_use");
    assert.equal(toolUse.name, "get_weather");
    assert.deepEqual(toolUse.input, { city: "Oslo" });

    // The tool result and the following user turn merge into one user message —
    // Anthropic rejects consecutive same-role turns.
    const merged = out.messages[2];
    assert.equal(merged.role, "user");
    const blocks = merged.content as Array<{ type: string; tool_use_id?: string }>;
    assert.equal(blocks[0].type, "tool_result");
    assert.equal(blocks[0].tool_use_id, "call_1");
    assert.equal(blocks[1].type, "text");
  });

  test("max_tokens is defaulted from the model and clamped when over-large", () => {
    const defaulted = openaiRequestToAnthropic(
      { model: "sonnet", messages: [{ role: "user", content: "hi" }] },
      resolved
    );
    assert.equal(defaulted.max_tokens, 64000);

    const clamped = openaiRequestToAnthropic(
      { model: "sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 999_999 },
      resolved
    );
    assert.equal(clamped.max_tokens, 64000);

    // max_completion_tokens wins over the legacy field.
    const modern = openaiRequestToAnthropic(
      {
        model: "sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 50
      },
      resolved
    );
    assert.equal(modern.max_tokens, 50);
  });

  test("tool_choice and stop sequences map across", () => {
    const out = openaiRequestToAnthropic(
      {
        model: "sonnet",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "required",
        stop: ["END", ""],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }]
      },
      resolved
    );
    assert.deepEqual(out.tool_choice, { type: "any" });
    // Empty stop sequences are rejected by Anthropic — they must be filtered.
    assert.deepEqual(out.stop_sequences, ["END"]);
    assert.equal(out.tools?.[0].name, "f");
  });

  test("a tool with no parameters still gets a valid object schema", () => {
    const out = openaiRequestToAnthropic(
      {
        model: "sonnet",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "ping" } }]
      },
      resolved
    );
    assert.deepEqual(out.tools?.[0].input_schema, { type: "object", properties: {} });
  });

  test("malformed tool arguments are a 400 naming the tool", () => {
    assert.throws(
      () =>
        openaiRequestToAnthropic(
          {
            model: "sonnet",
            messages: [
              {
                role: "assistant",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "broken", arguments: "{not json" } }
                ]
              }
            ]
          },
          resolved
        ),
      (err: unknown) =>
        err instanceof GatewayError && err.code === "invalid_request" && err.message.includes("broken")
    );
  });

  test("the end-user identifier is not forwarded upstream", () => {
    const out = openaiRequestToAnthropic(
      { model: "sonnet", messages: [{ role: "user", content: "hi" }], user: "end-user-42" },
      resolved
    );
    assert.ok(!JSON.stringify(out).includes("end-user-42"));
  });
});

describe("translation: Anthropic -> OpenAI", () => {
  const resolved = { provider: "openai" as const, upstreamId: "gpt-4o", requestedId: "gpt-4o", maxOutputTokens: 16384, inferred: false };

  test("system becomes a leading system message and tool_result becomes a tool message", () => {
    const request: AnthropicRequest = {
      model: "gpt-4o",
      max_tokens: 100,
      system: "Be brief.",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } }]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "12C" },
            { type: "text", text: "thanks" }
          ]
        }
      ]
    };
    const out = anthropicRequestToOpenAI(request, resolved);

    assert.equal(out.messages[0].role, "system");
    assert.equal(out.messages[0].content, "Be brief.");
    assert.equal(out.messages[2].role, "assistant");
    assert.equal(out.messages[2].tool_calls?.[0].function.name, "get_weather");
    // The tool message must precede the user turn it was bundled with.
    assert.equal(out.messages[3].role, "tool");
    assert.equal(out.messages[3].tool_call_id, "toolu_1");
    assert.equal(out.messages[4].role, "user");
    assert.equal(out.messages[4].content, "thanks");
  });

  test("a pure-text turn collapses back to a plain string", () => {
    const out = anthropicRequestToOpenAI(
      {
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      },
      resolved
    );
    assert.equal(out.messages[0].content, "hello");
  });
});

describe("translation: round-trip", () => {
  test("a multi-turn tool-calling conversation survives OpenAI -> Anthropic -> OpenAI", () => {
    const original: OpenAIChatRequest = {
      model: "sonnet",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "weather in Oslo?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "12C" },
        { role: "assistant", content: "It is 12C." },
        { role: "user", content: "and tomorrow?" }
      ]
    };

    const toAnthropic = openaiRequestToAnthropic(original, {
      provider: "anthropic",
      upstreamId: "claude-sonnet-5",
      requestedId: "sonnet",
      maxOutputTokens: 4096,
      inferred: false
    });
    const back = anthropicRequestToOpenAI(toAnthropic, {
      provider: "openai",
      upstreamId: "gpt-4o",
      requestedId: "gpt-4o",
      maxOutputTokens: 4096,
      inferred: false
    });

    assert.equal(back.messages[0].role, "system");
    assert.equal(back.messages[0].content, "Be terse.");

    const call = back.messages.find((message) => message.tool_calls);
    assert.ok(call, "tool call survived the round trip");
    assert.equal(call.tool_calls?.[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(call.tool_calls?.[0].function.arguments ?? "{}"), { city: "Oslo" });

    const toolResult = back.messages.find((message) => message.role === "tool");
    assert.ok(toolResult, "tool result survived the round trip");
    assert.equal(toolResult.tool_call_id, "call_1");

    // The final user turn must still be last, or the model answers the wrong question.
    assert.equal(back.messages[back.messages.length - 1].role, "user");
    assert.equal(back.messages[back.messages.length - 1].content, "and tomorrow?");
  });

  test("responses map finish reasons and usage in both directions", () => {
    const openai = anthropicResponseToOpenAI(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }
      },
      "sonnet"
    );
    assert.equal(openai.model, "sonnet");
    assert.equal(openai.choices[0].finish_reason, "tool_calls");
    // A tool-only turn has null content, not "".
    assert.equal(openai.choices[0].message.content, null);
    // Cache reads are real billed input tokens.
    assert.equal(openai.usage.prompt_tokens, 13);
    assert.equal(openai.usage.total_tokens, 18);

    const anthropic = openaiResponseToAnthropic(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "length" }
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      },
      "gpt-4o"
    );
    assert.equal(anthropic.stop_reason, "max_tokens");
    assert.equal(anthropic.usage.input_tokens, 4);
    assert.deepEqual(anthropic.content, [{ type: "text", text: "hi" }]);
  });
});

/* ------------------------------------------------------------------------ */
/* 4. Streaming (§8.4)                                                        */
/* ------------------------------------------------------------------------ */

describe("SSE parsing", () => {
  test("an event split across chunk boundaries is reassembled", async () => {
    // The regression this guards: naive per-chunk splitting silently truncates.
    const stream = streamOf(['data: {"a"', ':1}\n', "\n", 'data: {"b":2}\n\n']);
    const messages = await collect(parseSSE(stream));
    assert.deepEqual(
      messages.map((message) => message.data),
      ['{"a":1}', '{"b":2}']
    );
  });

  test("CRLF, comments, event names, and multi-line data are handled", async () => {
    const stream = streamOf([
      ": keepalive\r\n\r\n",
      "event: content_block_delta\r\ndata: line1\r\ndata: line2\r\n\r\n"
    ]);
    const messages = await collect(parseSSE(stream));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].event, "content_block_delta");
    assert.equal(messages[0].data, "line1\nline2");
  });

  test("a final event with no terminating blank line is still emitted", async () => {
    const stream = streamOf(['data: {"last":true}']);
    const messages = await collect(parseSSE(stream));
    assert.deepEqual(messages.map((m) => m.data), ['{"last":true}']);
  });

  test("formatted frames always carry the blank-line terminator", () => {
    assert.equal(formatSSE("hello"), "data: hello\n\n");
    assert.equal(formatSSE("x", "ping"), "event: ping\ndata: x\n\n");
    assert.ok(formatSSEJson({ a: 1 }).endsWith("\n\n"));
    // A multi-line payload must repeat the data: prefix or the receiver joins it wrong.
    assert.equal(formatSSE("a\nb"), "data: a\ndata: b\n\n");
  });
});

describe("stream translation", () => {
  test("tool-call indices are remapped from content-block indices", async () => {
    // Anthropic blocks 0=text, 1=tool_use, 2=tool_use must become OpenAI
    // tool_calls 0 and 1 — not 1 and 2.
    const events: AnthropicStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 0 }
        }
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "a", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "b", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 11 } },
      { type: "message_stop" }
    ];

    const sink = createUsageSink();
    const chunks = await collect(
      anthropicStreamToOpenAI(
        (async function* () {
          for (const event of events) yield event;
        })(),
        { requestedModel: "sonnet", sink }
      )
    );

    const toolCalls = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
    assert.deepEqual([...new Set(toolCalls.map((call) => call.index))], [0, 1]);
    assert.equal(toolCalls.find((call) => call.id === "toolu_1")?.index, 0);
    assert.equal(toolCalls.find((call) => call.id === "toolu_2")?.index, 1);

    // Arguments reassemble in order for the right call.
    const firstArgs = toolCalls
      .filter((call) => call.index === 0)
      .map((call) => call.function?.arguments ?? "")
      .join("");
    assert.equal(firstArgs, '{"x":1}');

    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, "tool_calls");
    assert.equal(chunks.every((chunk) => chunk.model === "sonnet"), true);
    assert.deepEqual(sink.usage, { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 });
    assert.equal(sink.completed, true);
  });

  test("an input_json_delta for a block that never started is dropped, not misfiled", async () => {
    const chunks = await collect(
      anthropicStreamToOpenAI(
        (async function* () {
          yield { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "{}" } } as AnthropicStreamEvent;
        })(),
        { requestedModel: "sonnet" }
      )
    );
    assert.equal(chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).length, 0);
  });

  test("OpenAI -> Anthropic keeps content blocks strictly nested", async () => {
    const chunks: OpenAIChatChunk[] = [
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "Think" }, finish_reason: null }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }
    ];

    const events = await collect(
      openaiStreamToAnthropic(
        (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
        { requestedModel: "gpt-4o" }
      )
    );

    const types = events.map((event) => event.type);
    assert.equal(types[0], "message_start");
    assert.equal(types[types.length - 1], "message_stop");
    assert.equal(types[types.length - 2], "message_delta");

    // Every content_block_start must be closed, and the text block must close
    // before the tool block opens.
    const starts = events.filter((e) => e.type === "content_block_start").length;
    const stops = events.filter((e) => e.type === "content_block_stop").length;
    assert.equal(starts, stops);

    const order = events
      .filter((e) => e.type === "content_block_start" || e.type === "content_block_stop")
      .map((e) => `${e.type}:${(e as { index: number }).index}`);
    assert.deepEqual(order, [
      "content_block_start:0",
      "content_block_stop:0",
      "content_block_start:1",
      "content_block_stop:1"
    ]);

    const delta = events.find((e) => e.type === "message_delta");
    assert.equal((delta as { delta: { stop_reason: string } }).delta.stop_reason, "tool_use");
  });

  test("an empty upstream stream still produces a well-formed response", async () => {
    const chunks = await collect(
      anthropicStreamToOpenAI((async function* () {})(), { requestedModel: "sonnet" })
    );
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks[0].choices[0].finish_reason, "stop");
  });
});

describe("streaming upstream behaviour", () => {
  test("an Anthropic mid-stream error event becomes a GatewayError", async () => {
    stubFetch(() =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1}}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream fell over"}}\n\n'
      ])
    );

    const events = anthropicStream({ provider: "anthropic", apiKey: FAKE_ANTHROPIC_KEY }, {
      model: "claude-sonnet-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }]
    });

    await assert.rejects(
      async () => {
        for await (const _event of events) {
          /* drain until it throws */
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof GatewayError);
        assert.match(err.message, /upstream fell over/);
        return true;
      }
    );
  });

  test("an OpenAI mid-stream error object becomes a GatewayError", async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"message":"context length exceeded"}}\n\n'
      ])
    );

    await assert.rejects(
      async () => {
        for await (const _chunk of openaiStream({ provider: "openai", apiKey: FAKE_OPENAI_KEY }, {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }]
        })) {
          /* drain */
        }
      },
      (err: unknown) => err instanceof GatewayError && /context length exceeded/.test(err.message)
    );
  });

  test("[DONE] terminates an OpenAI stream and is not yielded as a chunk", async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
        "data: [DONE]\n\n",
        'data: {"id":"never","choices":[]}\n\n'
      ])
    );
    const chunks = await collect(
      openaiStream({ provider: "openai", apiKey: FAKE_OPENAI_KEY }, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }]
      })
    );
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].id, "chatcmpl-1");
  });

  test("a malformed frame mid-stream is skipped rather than killing the response", async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
        "data: {not json\n\n",
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"b"}}]}\n\n'
      ])
    );
    const chunks = await collect(
      openaiStream({ provider: "openai", apiKey: FAKE_OPENAI_KEY }, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }]
      })
    );
    assert.equal(chunks.length, 2);
  });

  test("client disconnect aborts the stream instead of draining it", async () => {
    const controller = new AbortController();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              const encoder = new TextEncoder();
              streamController.enqueue(
                encoder.encode('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')
              );
              // Never closes — only the abort can end this.
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    );

    const received: OpenAIChatChunk[] = [];
    const iterate = (async () => {
      for await (const chunk of openaiStream(
        { provider: "openai", apiKey: FAKE_OPENAI_KEY },
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        { signal: controller.signal }
      )) {
        received.push(chunk);
        controller.abort();
      }
    })();

    await iterate;
    // The loop terminated on abort rather than hanging on an open stream.
    assert.equal(received.length, 1);
  });

  test("the streaming path reports usage through the sink", async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
        'data: {"type":"message_stop"}\n\n'
      ])
    );

    const { chunks, sink } = chatCompletionStream(
      { model: "sonnet", messages: [{ role: "user", content: "hi" }], stream: true },
      deps
    );
    const collected = await collect(chunks);

    assert.equal(collected.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "ok");
    assert.deepEqual(sink.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
    assert.equal(sink.finishReason, "stop");
  });
});

/* ------------------------------------------------------------------------ */
/* 5. Error mapping (§7 — throttling must never surface as 500)               */
/* ------------------------------------------------------------------------ */

describe("upstream error mapping", () => {
  test("429 maps to rate_limited and honours Retry-After", () => {
    const error = fromUpstreamResponse("anthropic", 429, '{"error":{"message":"slow down"}}', {
      get: (name: string) => (name === "retry-after" ? "30" : null)
    });
    assert.equal(error.code, "rate_limited");
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfterSeconds, 30);
    assert.equal(error.retryable, true);
  });

  test("a 429 without Retry-After still tells the client to back off", () => {
    const error = fromUpstreamResponse("openai", 429, "");
    assert.equal(error.retryAfterSeconds, 20);
  });

  test("401 is non-retryable and does not become a 500", () => {
    const error = fromUpstreamResponse("openai", 401, '{"error":{"message":"bad key"}}');
    assert.equal(error.code, "authentication_error");
    assert.equal(error.statusCode, 401);
    assert.equal(error.retryable, false);
  });

  test("529 overloaded maps to 503 with a retry hint", () => {
    const error = fromUpstreamResponse("anthropic", 529, "");
    assert.equal(error.code, "upstream_unavailable");
    assert.equal(error.statusCode, 503);
    assert.ok((error.retryAfterSeconds ?? 0) > 0);
  });

  test("a context-length 400 is classified rather than lumped in with validation", () => {
    const error = fromUpstreamResponse(
      "openai",
      400,
      '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}'
    );
    assert.equal(error.code, "context_length_exceeded");
  });

  test("a non-JSON upstream body still yields a usable message", () => {
    const error = fromUpstreamResponse("openai", 502, "<html>Bad Gateway</html>");
    assert.equal(error.code, "upstream_unavailable");
    assert.match(error.message, /Bad Gateway/);
  });
});

/* ------------------------------------------------------------------------ */
/* 6. End-to-end through the core                                             */
/* ------------------------------------------------------------------------ */

describe("gateway end-to-end", () => {
  test("an OpenAI-shaped request is served by Anthropic and answered in OpenAI shape", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hello there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 }
      })
    );

    const { response, meta } = await chatCompletion(
      { model: "sonnet", messages: [{ role: "system", content: "Be nice." }, { role: "user", content: "hi" }] },
      deps
    );

    // Routed to the Anthropic endpoint with the translated body.
    assert.match(calls[0].url, /api\.anthropic\.com\/v1\/messages$/);
    const sent = JSON.parse(String(calls[0].init.body)) as AnthropicRequest;
    assert.equal(sent.model, "claude-sonnet-5");
    assert.equal(sent.system, "Be nice.");

    // Answered in OpenAI shape, echoing the consumer's own model id.
    assert.equal(response.object, "chat.completion");
    assert.equal(response.model, "sonnet");
    assert.equal(response.choices[0].message.content, "hello there");
    assert.equal(response.choices[0].finish_reason, "stop");
    assert.equal(meta.provider, "anthropic");
    assert.equal(meta.translated, true);
    assert.equal(meta.usage.total_tokens, 8);
  });

  test("an OpenAI request to an OpenAI model passes through untranslated", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );

    const { response, meta } = await chatCompletion(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      deps
    );

    assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions$/);
    assert.equal(meta.translated, false);
    assert.equal(response.choices[0].message.content, "yo");
  });

  test("a 429 is retried with backoff and then surfaced as 429, never 500", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return jsonResponse({ error: { message: "rate limited" } }, 429, { "retry-after": "0" });
    });

    await assert.rejects(
      () => chatCompletion({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }, deps),
      (err: unknown) => {
        assert.ok(err instanceof GatewayError);
        assert.equal(err.statusCode, 429);
        return true;
      }
    );
    assert.equal(attempts, 3, "exhausted the retry budget before giving up");
  });

  test("a 401 is not retried — the same key fails identically every time", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return jsonResponse({ error: { message: "bad key" } }, 401);
    });

    await assert.rejects(() =>
      chatCompletion({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }, deps)
    );
    assert.equal(attempts, 1);
  });
});
