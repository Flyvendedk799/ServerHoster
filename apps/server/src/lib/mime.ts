/**
 * Minimal RFC 5322 / MIME reader for the Emailer inbound path.
 *
 * Cloudflare Email Workers (and most mail-to-webhook relays) hand us the raw
 * message. Pulling a dependency in for this would be the obvious move, but all
 * the Emailer needs is the conversation-relevant subset: addresses, threading
 * headers, a text body, an HTML body, and the names of any attachments. This
 * handles nested multiparts, base64 / quoted-printable transfer encodings,
 * RFC 2047 encoded-word headers and the common charsets — anything stranger
 * degrades to "best-effort text", never to an exception.
 */

export type MailAddress = { address: string; name: string | null };

export type MailAttachment = { filename: string; contentType: string; size: number };

export type ParsedMail = {
  headers: Map<string, string[]>;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
};

type Part = {
  headers: Map<string, string[]>;
  body: string;
};

function splitHeadersBody(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  }
  if (lf !== -1) return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
  return { head: raw, body: "" };
}

export function parseHeaderBlock(head: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const lines = head.split(/\r?\n/);
  let current: string | null = null;
  const flush = () => {
    if (!current) return;
    const idx = current.indexOf(":");
    if (idx > 0) {
      const key = current.slice(0, idx).trim().toLowerCase();
      const value = current.slice(idx + 1).trim();
      const list = headers.get(key) ?? [];
      list.push(value);
      headers.set(key, list);
    }
    current = null;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== null) {
      // Folded continuation line.
      current += " " + line.trim();
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return headers;
}

function header(headers: Map<string, string[]>, key: string): string | null {
  return headers.get(key)?.[0] ?? null;
}

function bytesToString(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? "utf-8").toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label === "us-ascii" ? "utf-8" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The raw message arrives as a JS string; treat each char code as a byte. */
function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeQuotedPrintable(input: string): Uint8Array {
  const cleaned = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Non-ASCII here means the relay already decoded the bytes as UTF-8.
      const code = ch.charCodeAt(0);
      if (code > 0x7f) bytes.push(...new TextEncoder().encode(ch));
      else bytes.push(code);
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 2047 `=?charset?B|Q?text?=` words inside a header value. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === "B") {
          return bytesToString(Uint8Array.from(Buffer.from(text, "base64")), charset);
        }
        return bytesToString(decodeQuotedPrintable(text.replace(/_/g, " ")), charset);
      } catch {
        return text;
      }
    });
}

function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim().toLowerCase().replace(/\*$/, "");
    let v = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
    // RFC 2231 `filename*=utf-8''na%C3%AFve.pdf`
    const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
    if (ext && p.slice(0, eq).trim().endsWith("*")) {
      try {
        v = decodeURIComponent(ext[2]);
      } catch {
        v = ext[2];
      }
    }
    params[key] = decodeEncodedWords(v);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

export function parseAddressList(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const decoded = decodeEncodedWords(value);
  const items: string[] = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  for (const ch of decoded) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if ((ch === "," || ch === ";") && !quoted && angle === 0) {
      items.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  items.push(buf);
  const out: MailAddress[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const angleMatch = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
    if (angleMatch) {
      const name = angleMatch[1].trim().replace(/^"|"$/g, "").trim();
      out.push({ address: angleMatch[2].trim().toLowerCase(), name: name || null });
    } else if (trimmed.includes("@")) {
      const parenName = /\(([^)]*)\)/.exec(trimmed)?.[1] ?? null;
      out.push({ address: trimmed.replace(/\([^)]*\)/g, "").trim().toLowerCase(), name: parenName });
    }
  }
  return out;
}

function parseMessageIds(value: string | null): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  return value
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("<") ? s : `<${s}>`));
}

function decodePartBody(part: Part, binary: boolean): string {
  const encoding = (header(part.headers, "content-transfer-encoding") ?? "7bit").toLowerCase().trim();
  const ct = parseParams(header(part.headers, "content-type") ?? "text/plain");
  const charset = ct.params.charset ?? "utf-8";
  if (encoding === "base64") {
    try {
      return bytesToString(Uint8Array.from(Buffer.from(part.body.replace(/\s+/g, ""), "base64")), charset);
    } catch {
      return part.body;
    }
  }
  if (encoding === "quoted-printable") return bytesToString(decodeQuotedPrintable(part.body), charset);
  // 7bit / 8bit / binary. When the relay sent the exact bytes (base64 of the
  // raw message) each char is one byte and must be decoded with the declared
  // charset; a text relay has already decoded it for us.
  if (binary) return bytesToString(binaryStringToBytes(part.body), charset);
  return part.body;
}

function encodedSize(part: Part): number {
  const encoding = (header(part.headers, "content-transfer-encoding") ?? "").toLowerCase().trim();
  if (encoding === "base64") return Math.floor((part.body.replace(/\s+/g, "").length * 3) / 4);
  return part.body.length;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(delimiter)) {
      if (current) out.push(current.join("\r\n"));
      if (line.startsWith(`${delimiter}--`)) {
        current = null;
        break;
      }
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.length) out.push(current.join("\r\n"));
  return out;
}

type Collected = { text: string | null; html: string | null; attachments: MailAttachment[] };

function walk(part: Part, acc: Collected, depth: number, binary: boolean): void {
  if (depth > 12) return;
  const ct = parseParams(header(part.headers, "content-type") ?? "text/plain; charset=utf-8");
  const disposition = parseParams(header(part.headers, "content-disposition") ?? "");
  const filename = disposition.params.filename ?? ct.params.name ?? null;

  if (ct.value.startsWith("multipart/") && ct.params.boundary) {
    for (const chunk of splitMultipart(part.body, ct.params.boundary)) {
      const { head, body } = splitHeadersBody(chunk);
      walk({ headers: parseHeaderBlock(head), body }, acc, depth + 1, binary);
    }
    return;
  }
  if (ct.value === "message/rfc822" && disposition.value !== "attachment") {
    const { head, body } = splitHeadersBody(part.body);
    walk({ headers: parseHeaderBlock(head), body }, acc, depth + 1, binary);
    return;
  }
  const isAttachment = disposition.value === "attachment" || (filename !== null && !ct.value.startsWith("text/"));
  if (isAttachment) {
    acc.attachments.push({
      filename: filename ?? "attachment",
      contentType: ct.value,
      size: encodedSize(part)
    });
    return;
  }
  if (ct.value === "text/plain" && acc.text === null) acc.text = decodePartBody(part, binary);
  else if (ct.value === "text/html" && acc.html === null) acc.html = decodePartBody(part, binary);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `binary: true` means every char of `raw` is one byte (a base64-decoded
 * message read as latin1) — bodies and raw 8-bit headers are then decoded with
 * their declared charset instead of being taken as already-decoded text.
 */
export function parseMail(raw: string, opts: { binary?: boolean } = {}): ParsedMail {
  const binary = Boolean(opts.binary);
  const split = splitHeadersBody(raw);
  const body = split.body;
  // SMTPUTF8 headers carry raw UTF-8 bytes; recover them before parsing.
  const head = binary && /[\x80-\xff]/.test(split.head)
    ? bytesToString(binaryStringToBytes(split.head), "utf-8")
    : split.head;
  const headers = parseHeaderBlock(head);
  const acc: Collected = { text: null, html: null, attachments: [] };
  walk({ headers, body }, acc, 0, binary);
  const from = parseAddressList(header(headers, "from"))[0] ?? null;
  const replyTo = parseAddressList(header(headers, "reply-to"))[0] ?? null;
  const messageId = parseMessageIds(header(headers, "message-id"))[0] ?? null;
  const inReplyTo = parseMessageIds(header(headers, "in-reply-to"))[0] ?? null;
  return {
    headers,
    subject: decodeEncodedWords(header(headers, "subject") ?? "").trim(),
    from,
    to: parseAddressList((headers.get("to") ?? []).join(", ")),
    cc: parseAddressList((headers.get("cc") ?? []).join(", ")),
    replyTo,
    messageId,
    inReplyTo,
    references: parseMessageIds(header(headers, "references")),
    date: header(headers, "date"),
    text: acc.text ?? (acc.html ? htmlToText(acc.html) : null),
    html: acc.html,
    attachments: acc.attachments
  };
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/** "Re: Fwd: RE: Hello" → "hello" — the key two messages share in one thread. */
export function subjectKey(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|sv|aw|vs|antw)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Collapse a body into a one-line preview, skipping quoted reply history. */
export function snippetOf(text: string | null | undefined, max = 180): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    kept.push(line);
  }
  const flat = kept.join(" ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
