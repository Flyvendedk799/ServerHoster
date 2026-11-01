import { parse as parseToml } from "smol-toml";

/**
 * Structure-aware, comment-preserving edits to a TOML document (supabase/config.toml).
 *
 * The first version of this was line-oriented: a `key =` line was replaced by
 * itself, a section ran to the next line starting with `[`. Both assumptions break
 * on ordinary config.toml shapes — on 2026-11-01 Awaire's
 *
 *   additional_redirect_urls = [
 *     "http://localhost:8080/reset-password",
 *     ...
 *   ]
 *
 * had only its first line replaced, leaving the old elements and `]` dangling.
 * The Supabase CLI then refused the whole file ("Invalid TOML document"), so the
 * stack would not start and every migration run failed.
 *
 * This module scans the document into statements (table headers, key/value
 * pairs whose value may span lines — multi-line arrays, inline tables, multi-line
 * strings — and trivia: blank lines and comments). An edit replaces a value's
 * whole span, inserts after the last key of a table, or appends a new table, and
 * keeps the file's own line endings (CRLF stays CRLF). Everything it does not
 * touch is reproduced byte for byte.
 *
 * Callers that write the result to disk validate it with `assertValidToml` first,
 * so a document this editor could not handle is reported, never written.
 */

/**
 * Values this module can write. `raw` is an escape hatch for TOML written
 * verbatim; a string array is formatted as a TOML array (multi-line past two
 * elements, so a long allow-list stays readable in a diff).
 */
export type TomlValue = number | string | boolean | string[] | { raw: string };

type Statement =
  | { kind: "trivia"; start: number; end: number }
  | { kind: "header"; start: number; end: number; table: string; arrayTable: boolean }
  | {
      kind: "kv";
      start: number;
      /** Offset just past the statement's line ending (or EOF). */
      end: number;
      /** Table the pair lives in ("" = root). `[[x]]` tables carry a `[]` suffix. */
      table: string;
      /** Normalised dotted key as written (`email.smtp.host`). */
      key: string;
      valueStart: number;
      /** Offset just past the value's last significant character. */
      valueEnd: number;
    };

/** `"a" . b . 'c'` → `a.b.c`. Quoted parts keep their inner text. */
function normaliseKey(raw: string): string {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"' || c === "'") {
      const close = findQuoteEnd(raw, i);
      current += raw.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === ".") {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
    i += 1;
  }
  parts.push(current.trim());
  return parts.join(".");
}

/** Index of the quote that closes the single-line string opening at `open`. */
function findQuoteEnd(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === "\\") {
      i += 1;
      continue;
    }
    if (c === quote || c === "\n") return i;
  }
  return text.length;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl + 1;
}

/**
 * Scan a value starting at `pos`. Returns the offset just past its last
 * significant character and the end of the line it finishes on. Tracks strings
 * (all four kinds), bracket depth and comments, so a value ends at the first
 * newline outside any string/array/inline table.
 */
function scanValue(text: string, pos: number): { valueEnd: number; end: number } {
  let depth = 0;
  let lastSignificant = pos;
  let i = pos;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      if (depth === 0) return { valueEnd: lastSignificant, end: i + 1 };
      i += 1;
      continue;
    }
    if (c === "#") {
      // A comment runs to the end of the line; inside an array the value goes on.
      const nl = text.indexOf("\n", i);
      if (nl === -1) return { valueEnd: lastSignificant, end: text.length };
      i = nl;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      let close: number;
      if (triple) {
        let j = i + 3;
        close = text.length;
        while (j < text.length) {
          if (c === '"' && text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text.startsWith(c.repeat(3), j)) {
            // Up to two extra quotes may sit right before the closing delimiter.
            let k = j + 3;
            while (k < text.length && text[k] === c && k < j + 5) k += 1;
            close = k - 1;
            break;
          }
          j += 1;
        }
      } else {
        close = findQuoteEnd(text, i);
      }
      i = Math.min(close + 1, text.length);
      lastSignificant = i;
      continue;
    }
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (c !== " " && c !== "\t" && c !== "\r") lastSignificant = i + 1;
    i += 1;
  }
  return { valueEnd: lastSignificant, end: text.length };
}

function scan(text: string): Statement[] {
  const out: Statement[] = [];
  let table = "";
  let pos = 0;
  while (pos < text.length) {
    let i = pos;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    const c = text[i];
    if (i >= text.length || c === "\n" || c === "\r" || c === "#") {
      const end = lineEnd(text, i);
      out.push({ kind: "trivia", start: pos, end });
      pos = end;
      continue;
    }
    if (c === "[") {
      const arrayTable = text[i + 1] === "[";
      let j = i + (arrayTable ? 2 : 1);
      let name = "";
      while (j < text.length && text[j] !== "]" && text[j] !== "\n") {
        if (text[j] === '"' || text[j] === "'") {
          const close = findQuoteEnd(text, j);
          name += text.slice(j, close + 1);
          j = close + 1;
          continue;
        }
        name += text[j];
        j += 1;
      }
      const end = lineEnd(text, j);
      table = normaliseKey(name) + (arrayTable ? "[]" : "");
      out.push({ kind: "header", start: pos, end, table, arrayTable });
      pos = end;
      continue;
    }
    // key = value
    let j = i;
    let rawKey = "";
    while (j < text.length && text[j] !== "=" && text[j] !== "\n") {
      if (text[j] === '"' || text[j] === "'") {
        const close = findQuoteEnd(text, j);
        rawKey += text.slice(j, close + 1);
        j = close + 1;
        continue;
      }
      rawKey += text[j];
      j += 1;
    }
    if (text[j] !== "=") {
      // Not a statement we understand; keep it verbatim. Validation will judge it.
      const end = lineEnd(text, j);
      out.push({ kind: "trivia", start: pos, end });
      pos = end;
      continue;
    }
    let valueStart = j + 1;
    while (valueStart < text.length && (text[valueStart] === " " || text[valueStart] === "\t"))
      valueStart += 1;
    const { valueEnd, end } = scanValue(text, valueStart);
    out.push({ kind: "kv", start: pos, end, table, key: normaliseKey(rawKey), valueStart, valueEnd });
    pos = end;
  }
  return out;
}

function fullPath(table: string, key: string): string {
  return table ? `${table}.${key}` : key;
}

/**
 * True when `s` defines part of `section` through a dotted key written in an
 * ANCESTOR table (`[auth]` + `email.smtp.host = …` defines auth.email.smtp).
 * A key under a descendant header (`[auth.email.smtp] host = …`) does not
 * define `[auth.email]` itself.
 */
function isDottedDefinitionOf(s: Statement, section: string): s is Extract<Statement, { kind: "kv" }> {
  if (s.kind !== "kv" || s.table.endsWith("[]")) return false;
  const isAncestor = s.table === "" || section.startsWith(`${s.table}.`);
  return isAncestor && fullPath(s.table, s.key).startsWith(`${section}.`);
}

/** The document's dominant line ending, so inserted lines match the file. */
export function detectEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function formatString(value: string): string {
  return JSON.stringify(value);
}

export function formatTomlValue(value: TomlValue, eol: string = "\n"): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return formatString(value);
  if (Array.isArray(value)) {
    if (value.length <= 2) return `[${value.map(formatString).join(", ")}]`;
    return `[${eol}${value.map((v) => `  ${formatString(v)},${eol}`).join("")}]`;
  }
  return value.raw;
}

function ensureTrailingEol(text: string, eol: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : text + eol;
}

/** Set one `[section] key = value`; returns the text unchanged when already so. */
function setOne(text: string, section: string, key: string, value: TomlValue): string {
  const eol = detectEol(text);
  const formatted = formatTomlValue(value, eol);
  const target = fullPath(section, key);
  const statements = scan(text);

  const existing = statements.find(
    (s): s is Extract<Statement, { kind: "kv" }> =>
      s.kind === "kv" && !s.table.endsWith("[]") && fullPath(s.table, s.key) === target
  );
  if (existing) {
    if (text.slice(existing.valueStart, existing.valueEnd) === formatted) return text;
    return text.slice(0, existing.valueStart) + formatted + text.slice(existing.valueEnd);
  }

  const headerIdx = statements.findIndex((s) => s.kind === "header" && !s.arrayTable && s.table === section);
  if (headerIdx !== -1 || section === "") {
    // Insert after the table's last key/value (so it lands above any trailing
    // blank line or comment that introduces the next table).
    let anchor = headerIdx === -1 ? null : statements[headerIdx]!;
    for (let i = headerIdx + 1; i < statements.length; i++) {
      const s = statements[i]!;
      if (s.kind === "header") break;
      if (s.kind === "kv") anchor = s;
    }
    const at = anchor ? anchor.end : 0;
    const before = ensureTrailingEol(text.slice(0, at), eol);
    return before + `${key} = ${formatted}${eol}` + text.slice(at);
  }

  // No header, but dotted keys elsewhere may already define the table
  // (`[auth]` + `email.smtp.host = …`). A new `[auth.email.smtp]` header would
  // then redefine it, which is invalid — add another dotted key next to them.
  const dotted = statements.filter((s) => isDottedDefinitionOf(s, section));
  const lastDotted = dotted[dotted.length - 1];
  if (lastDotted) {
    const relative = lastDotted.table ? target.slice(lastDotted.table.length + 1) : target;
    const before = ensureTrailingEol(text.slice(0, lastDotted.end), eol);
    return before + `${relative} = ${formatted}${eol}` + text.slice(lastDotted.end);
  }

  // Append a new table, separated by one blank line.
  let base = ensureTrailingEol(text, eol);
  if (base.length > 0 && !/\r?\n\r?\n$/.test(base)) base += eol;
  return `${base}[${section}]${eol}${key} = ${formatted}${eol}`;
}

/**
 * Set `[section] key = value` for every entry, creating the key or the whole
 * table if absent. Replacing a key replaces its whole value, however many lines
 * it spans. Idempotent: applying the same entries twice yields the same text.
 * When anything changed the result ends with a line ending.
 */
export function setTomlValues(
  toml: string,
  entries: ReadonlyArray<{ section: string; key: string; value: TomlValue }>
): string {
  let out = toml;
  for (const e of entries) out = setOne(out, e.section, e.key, e.value);
  return out === toml ? toml : ensureTrailingEol(out, detectEol(out));
}

/** Remove `[section] key = …` (its whole value span), if present. */
export function removeTomlKey(toml: string, section: string, key: string): string {
  const target = fullPath(section, key);
  const hit = scan(toml).find(
    (s): s is Extract<Statement, { kind: "kv" }> =>
      s.kind === "kv" && !s.table.endsWith("[]") && fullPath(s.table, s.key) === target
  );
  if (!hit) return toml;
  return toml.slice(0, hit.start) + toml.slice(hit.end);
}

/** True when `[section]` is declared as a table header. */
export function tomlHasTable(toml: string, section: string): boolean {
  return scan(toml).some((s) => s.kind === "header" && !s.arrayTable && s.table === section);
}

/**
 * True when the document defines `[section]` at all — as a header, or through
 * dotted keys in a parent table (`[auth.email]` + `template.invite.subject = …`).
 */
export function tomlDefinesTable(toml: string, section: string): boolean {
  return scan(toml).some(
    (s) => (s.kind === "header" && !s.arrayTable && s.table === section) || isDottedDefinitionOf(s, section)
  );
}

/** Read a dotted path out of a parsed document. */
export function tomlGet(doc: Record<string, unknown> | null, dottedPath: string): unknown {
  let node: unknown = doc;
  for (const part of dottedPath.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Parse the document, or null when it is not valid TOML. */
export function tryParseToml(toml: string): Record<string, unknown> | null {
  try {
    return parseToml(toml) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The parser's message for an invalid document, or null when it parses. */
export function tomlError(toml: string): string | null {
  try {
    parseToml(toml);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0] ?? message;
  }
}

/**
 * Throw when `toml` is not a valid document. Every writer of config.toml calls
 * this before touching the file: the Supabase CLI refuses an invalid config
 * outright, so writing one would take the stack (and its migrations) down.
 */
export function assertValidToml(toml: string, what = "config.toml"): void {
  const error = tomlError(toml);
  if (error) throw new Error(`${what} would not be valid TOML (${error}) — left unchanged`);
}
