/**
 * Wire types for the two formats SubGate speaks.
 *
 * Deliberately a *subset*: the fields the five consumer apps actually send,
 * plus everything needed to round-trip tool calls and streaming. Unknown
 * fields survive translation via the passthrough maps rather than being
 * modelled exhaustively — the OpenAI request surface moves faster than this
 * file will.
 *
 * Framework-free: no imports. Part of the portable core.
 */

/* ------------------------------------------------------------------------ */
/* OpenAI chat-completions                                                    */
/* ------------------------------------------------------------------------ */

export type OpenAIRole = "system" | "developer" | "user" | "assistant" | "tool";

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage = {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  /** Legacy name. `max_completion_tokens` wins when both are present. */
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown };
  /** Opaque consumer-side identifier. Never forwarded upstream. */
  user?: string;
  [key: string]: unknown;
};

export type OpenAIFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenAIChatResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: OpenAIFinishReason;
  }>;
  usage: OpenAIUsage;
};

export type OpenAIChunkToolCall = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

export type OpenAIChatChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: OpenAIChunkToolCall[];
    };
    finish_reason: OpenAIFinishReason;
  }>;
  usage?: OpenAIUsage | null;
};

/* ------------------------------------------------------------------------ */
/* Anthropic messages                                                         */
/* ------------------------------------------------------------------------ */

export type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: "text"; text: string }>;
      is_error?: boolean;
    };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

export type AnthropicSystem = string | Array<{ type: "text"; text: string }>;

export type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  /** Required by the Anthropic API. Translation supplies a per-model default. */
  max_tokens: number;
  system?: AnthropicSystem;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
  [key: string]: unknown;
};

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal"
  | null;

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

/** The subset of Anthropic SSE event types SubGate emits and understands. */
export type AnthropicStreamEvent =
  | { type: "message_start"; message: Omit<AnthropicResponse, "content"> & { content: [] } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, never> };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

/* ------------------------------------------------------------------------ */
/* Gateway-internal                                                           */
/* ------------------------------------------------------------------------ */

export type ProviderId = "anthropic" | "openai";

/** The wire format a consumer used to call us. Determines the response shape. */
export type WireFormat = "openai" | "anthropic";

export type ProviderCredentials = {
  provider: ProviderId;
  apiKey: string;
  /** Override for self-hosted/proxy deployments. Defaults per provider. */
  baseUrl?: string;
  /** Anthropic only — sent as `anthropic-version`. */
  apiVersion?: string;
  /** Extra headers (e.g. `OpenAI-Organization`). Never logged. */
  headers?: Record<string, string>;
};

export type UpstreamCallOptions = {
  signal?: AbortSignal;
  /** Wall-clock budget for the whole call, including streaming. */
  timeoutMs?: number;
};

/** Non-streaming result, normalised across providers. */
export type CompletionResult = {
  provider: ProviderId;
  /** Response in the format the *upstream* speaks; translation happens above. */
  openai?: OpenAIChatResponse;
  anthropic?: AnthropicResponse;
  usage: OpenAIUsage;
};
