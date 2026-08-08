/**
 * Shared upstream transport: fetch with timeout, retry/backoff, and error
 * mapping.
 *
 * One rule governs this file: the credential exists in exactly one expression
 * (`buildHeaders`) and is never interpolated into a message, a log line, or a
 * thrown error. Everything that leaves here has been through `redact()`.
 *
 * Framework-free: imports only sibling core modules.
 */

import { GatewayError, fromTransportError, fromUpstreamResponse } from "../errors.js";
import type { ProviderCredentials, UpstreamCallOptions } from "../types.js";

/** Default wall-clock budget. Long, because a large streamed completion is slow. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Retry policy for transient upstream faults. */
export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = {
  // 3 attempts total. More than that and a rate-limited consumer is just
  // holding a connection open while the gateway hammers a closed door.
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000
};

export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * Execute an upstream call with retry. Returns the raw Response so the caller
 * decides between `.json()` and streaming the body.
 *
 * Retries only on 429/5xx/transport faults, and only when the request is
 * idempotent in the sense that matters here: we have not yet handed any bytes
 * to the client. The streaming caller must not retry after first byte, which
 * it enforces by calling this once and never re-entering.
 */
export async function fetchUpstream(
  provider: string,
  request: UpstreamRequest,
  options: UpstreamCallOptions = {},
  retry: RetryPolicy = DEFAULT_RETRY
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: GatewayError | null = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    // A fresh controller per attempt: reusing one means a timeout on attempt 1
    // instantly aborts attempt 2.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      if (response.ok) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // Read the error body before deciding — it carries the upstream's own
      // explanation, which is the most useful thing we can give the consumer.
      const bodyText = await response.text().catch(() => "");
      const error = fromUpstreamResponse(provider, response.status, bodyText, response.headers);
      lastError = error;

      if (!error.retryable || attempt === retry.maxAttempts) throw error;

      await sleep(backoffMs(attempt, retry, error.retryAfterSeconds), options.signal);
    } catch (err) {
      if (err instanceof GatewayError) {
        if (!err.retryable || attempt === retry.maxAttempts) throw err;
        lastError = err;
        await sleep(backoffMs(attempt, retry, err.retryAfterSeconds), options.signal);
        continue;
      }

      // The caller aborting (client disconnect) is not a fault to retry.
      if (options.signal?.aborted) {
        throw new GatewayError("cancelled", "Client disconnected before the response completed.", {
          provider,
          retryable: false
        });
      }

      const mapped = fromTransportError(provider, err);
      lastError = mapped;
      if (attempt === retry.maxAttempts) throw mapped;
      await sleep(backoffMs(attempt, retry, undefined), options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  throw (
    lastError ??
    new GatewayError("upstream_error", `${provider} failed after ${retry.maxAttempts} attempts.`, {
      provider
    })
  );
}

/**
 * Exponential backoff with full jitter, floored by the upstream's own
 * Retry-After when it gave one. Jitter matters here: five consumer apps
 * behind one gateway retry in lockstep otherwise.
 */
function backoffMs(attempt: number, policy: RetryPolicy, retryAfterSeconds?: number): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jittered = Math.random() * exponential;
  const floor = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : 0;
  return Math.max(floor, jittered);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new GatewayError("cancelled", "Client disconnected while backing off.", { retryable: false }));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build request headers for a provider.
 *
 * This is the only place a credential is written into an outbound header.
 * Callers pass the returned object straight to fetch and never inspect it —
 * `redactHeaders()` exists for anything that wants to log the shape.
 */
export function buildHeaders(
  credentials: ProviderCredentials,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
    ...(credentials.headers ?? {})
  };

  if (credentials.provider === "anthropic") {
    headers["x-api-key"] = credentials.apiKey;
    headers["anthropic-version"] = credentials.apiVersion ?? "2023-06-01";
  } else {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }

  return headers;
}

/** A loggable copy of headers with every credential-bearing field masked. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const SENSITIVE = new Set(["authorization", "x-api-key", "api-key", "proxy-authorization"]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

/** Parse a JSON response body, mapping malformed payloads to a typed error. */
export async function readJson<T>(provider: string, response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError(
      "upstream_error",
      `${provider} returned a non-JSON response (${response.status}).`,
      { provider, upstreamStatus: response.status }
    );
  }
}

/** Normalise a base URL: strip a trailing slash and any trailing `/v1`. */
export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "").trim() || fallback;
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}
