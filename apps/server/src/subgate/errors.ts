/**
 * Typed gateway errors.
 *
 * §7: upstream 429/401 are *mapped*, never swallowed and never re-labelled as
 * a 500. A consumer that gets a 500 will retry into the same wall; a consumer
 * that gets a 429 with `Retry-After` backs off, and one that gets a 401 knows
 * to stop and re-key.
 *
 * Every message that reaches a client is passed through `redact()` at
 * construction, so a GatewayError can be serialised straight into a response
 * body without a second thought.
 */

import { redact } from "./redact.js";

export type GatewayErrorCode =
  | "invalid_request"
  | "authentication_error"
  | "permission_error"
  | "not_found"
  | "rate_limited"
  | "context_length_exceeded"
  | "upstream_error"
  | "upstream_unavailable"
  | "no_provider_configured"
  | "timeout"
  | "cancelled";

const STATUS_FOR_CODE: Record<GatewayErrorCode, number> = {
  invalid_request: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found: 404,
  rate_limited: 429,
  context_length_exceeded: 400,
  upstream_error: 502,
  upstream_unavailable: 503,
  no_provider_configured: 503,
  timeout: 504,
  cancelled: 499
};

export type GatewayErrorInit = {
  /** Seconds the client should wait before retrying. Set for 429/503. */
  retryAfterSeconds?: number;
  /** The upstream's own HTTP status, when this wraps an upstream failure. */
  upstreamStatus?: number;
  /** Which upstream produced it — "anthropic" | "openai" | undefined. */
  provider?: string;
  /** True when trying a different provider could plausibly succeed. */
  retryable?: boolean;
  cause?: unknown;
};

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;
  readonly upstreamStatus?: number;
  readonly provider?: string;
  readonly retryable: boolean;

  constructor(code: GatewayErrorCode, message: string, init: GatewayErrorInit = {}) {
    // Redact at construction: this message is destined for a response body.
    super(redact(message));
    this.name = "GatewayError";
    this.code = code;
    this.statusCode = STATUS_FOR_CODE[code];
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.upstreamStatus = init.upstreamStatus;
    this.provider = init.provider;
    this.retryable = init.retryable ?? defaultRetryable(code);
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /** OpenAI-shaped error body — what `/v1/chat/completions` and `/v1/models` return. */
  toOpenAIBody(): { error: { message: string; type: string; code: string; param: null } } {
    return {
      error: {
        message: this.message,
        type: OPENAI_ERROR_TYPE[this.code],
        code: this.code,
        param: null
      }
    };
  }

  /** Anthropic-shaped error body — what `/v1/messages` returns. */
  toAnthropicBody(): { type: "error"; error: { type: string; message: string } } {
    return {
      type: "error",
      error: { type: ANTHROPIC_ERROR_TYPE[this.code], message: this.message }
    };
  }
}

/**
 * Whether failing over to another provider is worth trying. An auth or
 * validation failure will fail identically everywhere; a rate limit or a
 * transient upstream fault will not.
 */
function defaultRetryable(code: GatewayErrorCode): boolean {
  return (
    code === "rate_limited" ||
    code === "upstream_error" ||
    code === "upstream_unavailable" ||
    code === "timeout"
  );
}

const OPENAI_ERROR_TYPE: Record<GatewayErrorCode, string> = {
  invalid_request: "invalid_request_error",
  authentication_error: "invalid_request_error",
  permission_error: "invalid_request_error",
  not_found: "invalid_request_error",
  rate_limited: "rate_limit_error",
  context_length_exceeded: "invalid_request_error",
  upstream_error: "api_error",
  upstream_unavailable: "api_error",
  no_provider_configured: "api_error",
  timeout: "api_error",
  cancelled: "api_error"
};

const ANTHROPIC_ERROR_TYPE: Record<GatewayErrorCode, string> = {
  invalid_request: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found: "not_found_error",
  rate_limited: "rate_limit_error",
  context_length_exceeded: "invalid_request_error",
  upstream_error: "api_error",
  upstream_unavailable: "overloaded_error",
  no_provider_configured: "api_error",
  timeout: "api_error",
  cancelled: "api_error"
};

/**
 * Map an upstream HTTP response into a GatewayError.
 *
 * The upstream body is parsed for a human-readable message but is *not*
 * trusted — it goes through redact() like everything else, because an
 * upstream 400 will happily quote the offending request back at you,
 * headers included.
 */
export function fromUpstreamResponse(
  provider: string,
  status: number,
  bodyText: string,
  headers?: { get(name: string): string | null }
): GatewayError {
  const detail = extractUpstreamMessage(bodyText);
  const retryAfter = parseRetryAfter(headers?.get("retry-after"));

  if (status === 401 || status === 403) {
    return new GatewayError(
      status === 401 ? "authentication_error" : "permission_error",
      `${provider} rejected the gateway's credentials (${status}). ${detail}`.trim(),
      { upstreamStatus: status, provider, retryable: false }
    );
  }
  if (status === 404) {
    return new GatewayError("not_found", `${provider}: ${detail || "model or endpoint not found"}`, {
      upstreamStatus: status,
      provider,
      retryable: false
    });
  }
  if (status === 429) {
    return new GatewayError("rate_limited", `${provider} rate limit reached. ${detail}`.trim(), {
      upstreamStatus: status,
      provider,
      // Default to 20s rather than 0 — an absent Retry-After with a 429 still
      // means "back off", and a client that retries instantly makes it worse.
      retryAfterSeconds: retryAfter ?? 20
    });
  }
  if (status === 400 && /context.*(length|window)|too many tokens|prompt is too long/i.test(detail)) {
    return new GatewayError("context_length_exceeded", `${provider}: ${detail}`, {
      upstreamStatus: status,
      provider,
      retryable: false
    });
  }
  if (status >= 400 && status < 500) {
    return new GatewayError("invalid_request", `${provider}: ${detail || `request rejected (${status})`}`, {
      upstreamStatus: status,
      provider,
      retryable: false
    });
  }
  if (status === 529 || status === 503 || status === 502) {
    return new GatewayError("upstream_unavailable", `${provider} is overloaded. ${detail}`.trim(), {
      upstreamStatus: status,
      provider,
      retryAfterSeconds: retryAfter ?? 5
    });
  }
  return new GatewayError("upstream_error", `${provider} error ${status}. ${detail}`.trim(), {
    upstreamStatus: status,
    provider
  });
}

/** Wrap a transport-level failure (DNS, connection reset, abort). */
export function fromTransportError(provider: string, err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new GatewayError("timeout", `${provider} did not respond in time.`, {
      provider,
      cause: err
    });
  }
  return new GatewayError("upstream_unavailable", `Could not reach ${provider}: ${redact(err)}`, {
    provider,
    cause: err
  });
}

/**
 * Pull a message out of an upstream error body. Handles both the OpenAI
 * (`{error:{message}}`) and Anthropic (`{error:{message}}` under `type:error`)
 * shapes, and falls back to a truncated raw body.
 */
function extractUpstreamMessage(bodyText: string): string {
  if (!bodyText) return "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.length > 0) return truncate(message, 400);
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return truncate(bodyText.replace(/\s+/g, " ").trim(), 400);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Retry-After is either delta-seconds or an HTTP date. Returns seconds, or
 * null when the header is absent or unparseable.
 */
function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
