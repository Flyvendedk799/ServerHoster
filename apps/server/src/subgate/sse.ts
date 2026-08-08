/**
 * Server-sent-events plumbing.
 *
 * Both upstreams stream SSE and both consumer wire formats are SSE, so this
 * module is on the hot path for every streaming request. The parser is
 * line-buffered because a chunk boundary lands mid-event often enough that
 * naive `chunk.split("\n\n")` produces silent truncation under load — that is
 * the bug §8.4 asks for a test against.
 *
 * Framework-free: no imports beyond sibling core modules.
 */

export type SSEMessage = {
  /** The `event:` field, when the producer sets one (Anthropic does). */
  event?: string;
  /** Concatenated `data:` lines, newline-joined per the spec. */
  data: string;
};

export const SSE_DONE = "[DONE]";

/**
 * Parse a byte stream of SSE into messages.
 *
 * Handles: CRLF and LF, multi-line `data:`, comment/heartbeat lines (`:`),
 * unknown fields, and a trailing event with no terminating blank line (which
 * some proxies produce when the upstream closes cleanly mid-flush).
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SSEMessage, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Client disconnect: release the upstream reader so the socket and the
  // upstream request are both torn down instead of draining in the background.
  const onAbort = (): void => {
    void reader.cancel().catch(() => {
      /* already closed */
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Normalise CRLF first so the
      // split below doesn't have to care.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseEventBlock(raw);
        if (message) yield message;
        boundary = buffer.indexOf("\n\n");
      }
    }

    // Flush the decoder and emit a final unterminated event if one is pending.
    buffer += decoder.decode();
    const tail = parseEventBlock(buffer.replace(/\r\n/g, "\n").trim());
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SSEMessage | null {
  if (!block.trim()) return null;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    // `:` alone (or any comment) is a heartbeat — keeps the connection warm,
    // carries no payload.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not data.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    // `id` and `retry` are spec fields neither upstream uses meaningfully.
  }

  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join("\n") };
}

/** Serialise one SSE message. Always ends with the blank-line terminator. */
export function formatSSE(data: string, event?: string): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  // Multi-line payloads must repeat the `data:` prefix or the receiver joins
  // them wrong. JSON.stringify output is single-line, but be correct anyway.
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Serialise a JSON payload as one SSE message. */
export function formatSSEJson(payload: unknown, event?: string): string {
  return formatSSE(JSON.stringify(payload), event);
}

/** The OpenAI terminator. Anthropic streams end with `message_stop` instead. */
export function formatSSEDone(): string {
  return formatSSE(SSE_DONE);
}

/**
 * A heartbeat comment. Sent while waiting on a slow upstream so intermediate
 * proxies (ServerHoster's own reverse proxy included) don't time the
 * connection out before the first token arrives.
 */
export function formatSSEComment(text = "keepalive"): string {
  return `: ${text}\n\n`;
}
