/**
 * SubGate core — public surface.
 *
 * Everything under `subgate/` is framework-free: no Fastify, no React, no
 * SQLite, no ServerHoster imports. That constraint is what makes §5's
 * standalone repo an extraction rather than a fork — moving this directory to
 * `packages/core` and adding a package.json is the whole job, and both targets
 * then import the same code.
 *
 * If you are about to add an import here that reaches outside this directory
 * or into `node:`-adjacent app state, it belongs in `services/aiGateway.ts`
 * instead.
 */

export {
  GatewayError,
  fromTransportError,
  fromUpstreamResponse,
  type GatewayErrorCode,
  type GatewayErrorInit
} from "./errors.js";

export {
  clearRegisteredSecrets,
  containsRegisteredSecret,
  forgetSecret,
  maskCredential,
  redact,
  redactWith,
  registerSecret,
  REDACTED
} from "./redact.js";

export {
  FALLBACK_MAX_OUTPUT_TOKENS,
  listModels,
  modelsFor,
  modelsPayload,
  registerModels,
  resetModels,
  resolveModel,
  type ModelEntry,
  type ResolvedModel
} from "./models.js";

export {
  SSE_DONE,
  formatSSE,
  formatSSEComment,
  formatSSEDone,
  formatSSEJson,
  parseSSE,
  type SSEMessage
} from "./sse.js";

export {
  availableProviders,
  chatCompletion,
  chatCompletionStream,
  messages,
  messagesStream,
  type CompletionMeta,
  type GatewayDeps
} from "./gateway.js";

export {
  anthropicRequestToOpenAI,
  flattenAnthropicSystem,
  flattenOpenAIContent,
  normalizeAnthropicContent,
  openaiRequestToAnthropic
} from "./translate/request.js";

export {
  anthropicResponseToOpenAI,
  anthropicStopToOpenAI,
  anthropicUsageToOpenAI,
  openaiFinishToAnthropic,
  openaiResponseToAnthropic,
  openaiUsageToAnthropic
} from "./translate/response.js";

export {
  anthropicStreamToOpenAI,
  createUsageSink,
  openaiStreamToAnthropic,
  type UsageSink
} from "./translate/stream.js";

export {
  ANTHROPIC_DEFAULT_BASE_URL,
  anthropicComplete,
  anthropicStream
} from "./upstream/anthropic.js";

export { OPENAI_DEFAULT_BASE_URL, openaiComplete, openaiStream } from "./upstream/openai.js";

export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  buildHeaders,
  normalizeBaseUrl,
  redactHeaders,
  type RetryPolicy
} from "./upstream/http.js";

export type * from "./types.js";
