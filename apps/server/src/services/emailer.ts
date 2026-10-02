/**
 * Emailer — two-way email conversations for the services on this host.
 *
 * The Email tab configures *transport* (shared SMTP out, Cloudflare forwarding
 * in). The Emailer is the *conversation* layer on top of it:
 *
 *   - A **mailbox** is one of our addresses (`support@app.com`) or a domain
 *     catch-all (`*@app.com`), optionally owned by a service. Ownership is what
 *     gives every service its own inbox view.
 *   - **Inbound** mail arrives at `POST /emailer/inbound`, guarded by an ingest
 *     token. The intended relay is a Cloudflare Email Worker we can deploy in
 *     one click (it posts the raw message), but any mail-to-webhook relay that
 *     can POST JSON works.
 *   - **Outbound** mail is sent through the shared SMTP config — either from
 *     the dashboard (compose / reply) or by the service itself through the
 *     per-mailbox API token (`POST /emailer/api/send`), so app-sent mail shows
 *     up in the same conversation as the replies to it.
 *   - Messages are grouped into **threads** by RFC 5322 threading headers
 *     (In-Reply-To / References), falling back to counterparty + normalized
 *     subject so replies from clients that drop the headers still land right.
 *
 * Every inbound/outbound message also fans out to n8n (`email.received` /
 * `email.sent`) and, when the mailbox has one, to the owning service's webhook.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, nowIso } from "../lib/core.js";
import {
  htmlToText,
  normalizeMessageId,
  parseAddressList,
  parseMail,
  snippetOf,
  subjectKey,
  type MailAddress,
  type MailAttachment
} from "../lib/mime.js";
import { getSecretSetting, getSetting, setSecretSetting, setSetting } from "./settings.js";
import { readSmtpConfig, sendSmtpMail, smtpConfigured } from "./smtp.js";
import { emitN8nEvent } from "./n8n.js";
import { writeAuditLog } from "./audit.js";
import { encryptSecret } from "../security.js";

const SETTING_INGEST_TOKEN = "emailer_ingest_token";
const SETTING_PUBLIC_URL = "emailer_public_url";
const SETTING_WORKER_NAME = "emailer_cf_worker";

const MAX_TEXT = 256 * 1024;
const MAX_HTML = 512 * 1024;
/** Fallback threading window when a client strips In-Reply-To/References. */
const SUBJECT_MATCH_DAYS = 30;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

type HttpError = Error & { statusCode?: number };

function httpError(message: string, statusCode: number): HttpError {
  const e = new Error(message) as HttpError;
  e.statusCode = statusCode;
  return e;
}

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha256(a));
  const hb = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(ha, hb);
}

function cap(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

type MailboxRow = {
  id: string;
  address: string;
  display_name: string | null;
  service_id: string | null;
  forward_url: string | null;
  signature: string | null;
  api_token_hash: string | null;
  api_token_prefix: string | null;
  created_at: string;
  updated_at: string;
};

export type Mailbox = Omit<MailboxRow, "api_token_hash"> & {
  wildcard: boolean;
  has_api_token: boolean;
  service_name: string | null;
  unread: number;
  threads: number;
};

function serviceName(ctx: AppContext, serviceId: string | null): string | null {
  if (!serviceId) return null;
  const row = ctx.db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

function toMailbox(ctx: AppContext, row: MailboxRow): Mailbox {
  const counts = ctx.db
    .prepare(
      "SELECT COUNT(*) AS threads, COALESCE(SUM(unread_count), 0) AS unread FROM emailer_threads WHERE mailbox_id = ? AND status != 'spam'"
    )
    .get(row.id) as { threads: number; unread: number };
  const { api_token_hash, ...rest } = row;
  return {
    ...rest,
    wildcard: row.address.startsWith("*@"),
    has_api_token: Boolean(api_token_hash),
    service_name: serviceName(ctx, row.service_id),
    unread: Number(counts.unread ?? 0),
    threads: Number(counts.threads ?? 0)
  };
}

function getMailboxRow(ctx: AppContext, id: string): MailboxRow {
  const row = ctx.db.prepare("SELECT * FROM emailer_mailboxes WHERE id = ?").get(id) as MailboxRow | undefined;
  if (!row) throw httpError("Mailbox not found", 404);
  return row;
}

export function listMailboxes(ctx: AppContext, serviceId?: string | null): Mailbox[] {
  const rows = (
    serviceId
      ? ctx.db.prepare("SELECT * FROM emailer_mailboxes WHERE service_id = ? ORDER BY address").all(serviceId)
      : ctx.db.prepare("SELECT * FROM emailer_mailboxes ORDER BY address").all()
  ) as MailboxRow[];
  return rows.map((r) => toMailbox(ctx, r));
}

function normalizeMailboxAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (trimmed.startsWith("*@")) {
    const domain = trimmed.slice(2);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw httpError("Catch-all must look like *@example.com", 400);
    return trimmed;
  }
  if (!isEmailAddress(trimmed)) throw httpError("Mailbox address must be a valid email address", 400);
  return trimmed;
}

function assertServiceExists(ctx: AppContext, serviceId: string | null | undefined): void {
  if (!serviceId) return;
  const row = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(serviceId);
  if (!row) throw httpError("Service not found", 404);
}

function normalizeForwardUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad scheme");
  } catch {
    throw httpError("Forward URL must be an absolute http(s) URL", 400);
  }
  return trimmed;
}

export type MailboxInput = {
  address: string;
  displayName?: string | null;
  serviceId?: string | null;
  forwardUrl?: string | null;
  signature?: string | null;
};

export function createMailbox(ctx: AppContext, input: MailboxInput, actor = "system"): Mailbox {
  const address = normalizeMailboxAddress(input.address);
  assertServiceExists(ctx, input.serviceId);
  const existing = ctx.db.prepare("SELECT id FROM emailer_mailboxes WHERE address = ?").get(address);
  if (existing) throw httpError(`Mailbox ${address} already exists`, 409);
  const id = nanoid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO emailer_mailboxes (id, address, display_name, service_id, forward_url, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      address,
      input.displayName?.trim() || null,
      input.serviceId || null,
      normalizeForwardUrl(input.forwardUrl),
      input.signature?.trim() || null,
      now,
      now
    );
  // Mail that already arrived for this address while it was unassigned now
  // belongs to the mailbox (and its service).
  adoptUnassignedThreads(ctx, id, address, input.serviceId || null);
  writeAuditLog(ctx, {
    actor,
    action: "emailer.mailbox.create",
    resourceType: "emailer",
    resourceId: id,
    statusCode: 200,
    details: address
  });
  return toMailbox(ctx, getMailboxRow(ctx, id));
}

function adoptUnassignedThreads(ctx: AppContext, mailboxId: string, address: string, serviceId: string | null): void {
  if (address.startsWith("*@")) {
    const domain = address.slice(1); // "@example.com"
    ctx.db
      .prepare(
        "UPDATE emailer_threads SET mailbox_id = ?, service_id = ? WHERE mailbox_id IS NULL AND local_address LIKE ?"
      )
      .run(mailboxId, serviceId, `%${domain}`);
  } else {
    ctx.db
      .prepare("UPDATE emailer_threads SET mailbox_id = ?, service_id = ? WHERE mailbox_id IS NULL AND local_address = ?")
      .run(mailboxId, serviceId, address);
  }
  ctx.db
    .prepare(
      "UPDATE emailer_messages SET mailbox_id = ?, service_id = ? WHERE thread_id IN (SELECT id FROM emailer_threads WHERE mailbox_id = ?)"
    )
    .run(mailboxId, serviceId, mailboxId);
}

export function updateMailbox(
  ctx: AppContext,
  id: string,
  patch: Partial<MailboxInput>,
  actor = "system"
): Mailbox {
  const row = getMailboxRow(ctx, id);
  const address = patch.address !== undefined ? normalizeMailboxAddress(patch.address) : row.address;
  if (address !== row.address) {
    const clash = ctx.db.prepare("SELECT id FROM emailer_mailboxes WHERE address = ? AND id != ?").get(address, id);
    if (clash) throw httpError(`Mailbox ${address} already exists`, 409);
  }
  if (patch.serviceId !== undefined) assertServiceExists(ctx, patch.serviceId);
  const serviceId = patch.serviceId !== undefined ? patch.serviceId || null : row.service_id;
  ctx.db
    .prepare(
      `UPDATE emailer_mailboxes SET address = ?, display_name = ?, service_id = ?, forward_url = ?, signature = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      address,
      patch.displayName !== undefined ? patch.displayName?.trim() || null : row.display_name,
      serviceId,
      patch.forwardUrl !== undefined ? normalizeForwardUrl(patch.forwardUrl) : row.forward_url,
      patch.signature !== undefined ? patch.signature?.trim() || null : row.signature,
      nowIso(),
      id
    );
  if (serviceId !== row.service_id) {
    // Re-home the conversation history with the mailbox.
    ctx.db.prepare("UPDATE emailer_threads SET service_id = ? WHERE mailbox_id = ?").run(serviceId, id);
    ctx.db.prepare("UPDATE emailer_messages SET service_id = ? WHERE mailbox_id = ?").run(serviceId, id);
  }
  writeAuditLog(ctx, {
    actor,
    action: "emailer.mailbox.update",
    resourceType: "emailer",
    resourceId: id,
    statusCode: 200,
    details: address
  });
  return toMailbox(ctx, getMailboxRow(ctx, id));
}

export function deleteMailbox(ctx: AppContext, id: string, actor = "system"): void {
  const row = getMailboxRow(ctx, id);
  // Conversations survive as "unassigned" — deleting an address must never
  // silently delete customer mail.
  ctx.db.prepare("UPDATE emailer_threads SET mailbox_id = NULL, service_id = NULL WHERE mailbox_id = ?").run(id);
  ctx.db.prepare("UPDATE emailer_messages SET mailbox_id = NULL, service_id = NULL WHERE mailbox_id = ?").run(id);
  ctx.db.prepare("DELETE FROM emailer_mailboxes WHERE id = ?").run(id);
  writeAuditLog(ctx, {
    actor,
    action: "emailer.mailbox.delete",
    resourceType: "emailer",
    resourceId: id,
    statusCode: 200,
    details: row.address
  });
}

/** Mint (or rotate) the mailbox API token. The plaintext is returned once. */
export function mintMailboxToken(ctx: AppContext, id: string, actor = "system"): { token: string; mailbox: Mailbox } {
  const row = getMailboxRow(ctx, id);
  if (row.address.startsWith("*@")) {
    throw httpError("A catch-all mailbox cannot send — create a concrete address for the app to send from", 400);
  }
  const token = `emk_${crypto.randomBytes(24).toString("base64url")}`;
  ctx.db
    .prepare("UPDATE emailer_mailboxes SET api_token_hash = ?, api_token_prefix = ?, updated_at = ? WHERE id = ?")
    .run(sha256(token), token.slice(0, 10), nowIso(), id);
  writeAuditLog(ctx, {
    actor,
    action: "emailer.mailbox.token",
    resourceType: "emailer",
    resourceId: id,
    statusCode: 200
  });
  return { token, mailbox: toMailbox(ctx, getMailboxRow(ctx, id)) };
}

export function revokeMailboxToken(ctx: AppContext, id: string): Mailbox {
  getMailboxRow(ctx, id);
  ctx.db
    .prepare("UPDATE emailer_mailboxes SET api_token_hash = NULL, api_token_prefix = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
  return toMailbox(ctx, getMailboxRow(ctx, id));
}

export function mailboxForToken(ctx: AppContext, token: string): MailboxRow | null {
  if (!token || !token.startsWith("emk_")) return null;
  const row = ctx.db.prepare("SELECT * FROM emailer_mailboxes WHERE api_token_hash = ?").get(sha256(token)) as
    | MailboxRow
    | undefined;
  return row ?? null;
}

/** Exact address first, then a `*@domain` catch-all. */
export function matchMailbox(ctx: AppContext, addresses: string[]): MailboxRow | null {
  const lowered = addresses.map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const address of lowered) {
    const row = ctx.db.prepare("SELECT * FROM emailer_mailboxes WHERE address = ?").get(address) as
      | MailboxRow
      | undefined;
    if (row) return row;
  }
  for (const address of lowered) {
    const domain = address.split("@")[1];
    if (!domain) continue;
    const row = ctx.db.prepare("SELECT * FROM emailer_mailboxes WHERE address = ?").get(`*@${domain}`) as
      | MailboxRow
      | undefined;
    if (row) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Threads & messages
// ---------------------------------------------------------------------------

type ThreadRow = {
  id: string;
  mailbox_id: string | null;
  service_id: string | null;
  local_address: string;
  subject: string;
  subject_key: string;
  counterparty: string;
  counterparty_name: string | null;
  status: string;
  starred: number;
  unread_count: number;
  message_count: number;
  last_direction: string | null;
  last_snippet: string | null;
  last_message_at: string;
  created_at: string;
};

export type EmailerThread = Omit<ThreadRow, "starred"> & {
  starred: boolean;
  service_name: string | null;
  mailbox_address: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  mailbox_id: string | null;
  service_id: string | null;
  direction: "in" | "out";
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  from_addr: string;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  snippet: string | null;
  attachments_json: string;
  status: string;
  error: string | null;
  source: string;
  forward_status: string | null;
  created_at: string;
};

export type EmailerMessage = Omit<MessageRow, "references_json" | "to_json" | "cc_json" | "attachments_json"> & {
  references: string[];
  to: MailAddress[];
  cc: MailAddress[];
  attachments: MailAttachment[];
};

function toThread(ctx: AppContext, row: ThreadRow): EmailerThread {
  const mailbox = row.mailbox_id
    ? (ctx.db.prepare("SELECT address FROM emailer_mailboxes WHERE id = ?").get(row.mailbox_id) as
        | { address: string }
        | undefined)
    : undefined;
  return {
    ...row,
    starred: Boolean(row.starred),
    service_name: serviceName(ctx, row.service_id),
    mailbox_address: mailbox?.address ?? null
  };
}

function toMessage(row: MessageRow): EmailerMessage {
  const { references_json, to_json, cc_json, attachments_json, ...rest } = row;
  return {
    ...rest,
    references: parseJsonArray<string>(references_json),
    to: parseJsonArray<MailAddress>(to_json),
    cc: parseJsonArray<MailAddress>(cc_json),
    attachments: parseJsonArray<MailAttachment>(attachments_json)
  };
}

function getThreadRow(ctx: AppContext, id: string): ThreadRow {
  const row = ctx.db.prepare("SELECT * FROM emailer_threads WHERE id = ?").get(id) as ThreadRow | undefined;
  if (!row) throw httpError("Conversation not found", 404);
  return row;
}

export type ThreadFolder = "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "all";

export type ThreadFilter = {
  folder?: ThreadFolder;
  serviceId?: string | null;
  mailboxId?: string | null;
  unassigned?: boolean;
  q?: string | null;
  limit?: number;
  offset?: number;
};

export function listThreads(ctx: AppContext, filter: ThreadFilter = {}): { items: EmailerThread[]; total: number } {
  const where: string[] = [];
  const args: Array<string | number> = [];
  switch (filter.folder ?? "inbox") {
    case "inbox":
      where.push("t.status = 'open'");
      break;
    case "unread":
      where.push("t.unread_count > 0 AND t.status != 'spam'");
      break;
    case "starred":
      where.push("t.starred = 1");
      break;
    case "sent":
      where.push("EXISTS (SELECT 1 FROM emailer_messages m WHERE m.thread_id = t.id AND m.direction = 'out')");
      break;
    case "archived":
      where.push("t.status = 'archived'");
      break;
    case "spam":
      where.push("t.status = 'spam'");
      break;
    case "all":
      where.push("t.status != 'spam'");
      break;
  }
  if (filter.serviceId) {
    where.push("t.service_id = ?");
    args.push(filter.serviceId);
  }
  if (filter.mailboxId) {
    where.push("t.mailbox_id = ?");
    args.push(filter.mailboxId);
  }
  if (filter.unassigned) where.push("t.mailbox_id IS NULL");
  const q = filter.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(t.subject LIKE ? ESCAPE '\\' OR t.counterparty LIKE ? ESCAPE '\\' OR t.counterparty_name LIKE ? ESCAPE '\\' OR
        EXISTS (SELECT 1 FROM emailer_messages m WHERE m.thread_id = t.id AND m.text_body LIKE ? ESCAPE '\\'))`
    );
    args.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    ctx.db.prepare(`SELECT COUNT(*) AS c FROM emailer_threads t ${clause}`).get(...args) as { c: number }
  ).c;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = ctx.db
    .prepare(`SELECT t.* FROM emailer_threads t ${clause} ORDER BY t.last_message_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as ThreadRow[];
  return { items: rows.map((r) => toThread(ctx, r)), total: Number(total) };
}

export function getThread(
  ctx: AppContext,
  id: string,
  opts: { markRead?: boolean } = {}
): { thread: EmailerThread; messages: EmailerMessage[] } {
  let row = getThreadRow(ctx, id);
  if (opts.markRead && row.unread_count > 0) {
    ctx.db.prepare("UPDATE emailer_threads SET unread_count = 0 WHERE id = ?").run(id);
    row = getThreadRow(ctx, id);
    broadcast(ctx, { type: "emailer_update", threadId: id, serviceId: row.service_id });
  }
  const messages = ctx.db
    .prepare("SELECT * FROM emailer_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(id) as MessageRow[];
  return { thread: toThread(ctx, row), messages: messages.map(toMessage) };
}

export function updateThread(
  ctx: AppContext,
  id: string,
  patch: { status?: "open" | "archived" | "spam"; starred?: boolean; read?: boolean }
): EmailerThread {
  getThreadRow(ctx, id);
  if (patch.status) ctx.db.prepare("UPDATE emailer_threads SET status = ? WHERE id = ?").run(patch.status, id);
  if (patch.starred !== undefined) {
    ctx.db.prepare("UPDATE emailer_threads SET starred = ? WHERE id = ?").run(patch.starred ? 1 : 0, id);
  }
  if (patch.read !== undefined) {
    ctx.db.prepare("UPDATE emailer_threads SET unread_count = ? WHERE id = ?").run(patch.read ? 0 : 1, id);
  }
  const row = getThreadRow(ctx, id);
  broadcast(ctx, { type: "emailer_update", threadId: id, serviceId: row.service_id });
  return toThread(ctx, row);
}

export function deleteThread(ctx: AppContext, id: string, actor = "system"): void {
  const row = getThreadRow(ctx, id);
  ctx.db.prepare("DELETE FROM emailer_messages WHERE thread_id = ?").run(id);
  ctx.db.prepare("DELETE FROM emailer_threads WHERE id = ?").run(id);
  writeAuditLog(ctx, {
    actor,
    action: "emailer.thread.delete",
    resourceType: "emailer",
    resourceId: id,
    statusCode: 200,
    details: `${row.counterparty} · ${row.subject}`
  });
  broadcast(ctx, { type: "emailer_update", threadId: id, serviceId: row.service_id });
}

function findThreadForMessage(
  ctx: AppContext,
  opts: {
    refs: string[];
    mailboxId: string | null;
    counterparty: string;
    subjectKey: string;
  }
): ThreadRow | null {
  for (const ref of [...opts.refs].reverse()) {
    const hit = ctx.db
      .prepare("SELECT thread_id FROM emailer_messages WHERE message_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(ref) as { thread_id: string } | undefined;
    if (hit) {
      const row = ctx.db.prepare("SELECT * FROM emailer_threads WHERE id = ?").get(hit.thread_id) as
        | ThreadRow
        | undefined;
      if (row) return row;
    }
  }
  if (!opts.subjectKey) return null;
  const since = new Date(Date.now() - SUBJECT_MATCH_DAYS * 86400_000).toISOString();
  const row = ctx.db
    .prepare(
      `SELECT * FROM emailer_threads
       WHERE counterparty = ? AND subject_key = ? AND last_message_at >= ?
         AND ((mailbox_id IS NULL AND ? IS NULL) OR mailbox_id = ?)
       ORDER BY last_message_at DESC LIMIT 1`
    )
    .get(opts.counterparty, opts.subjectKey, since, opts.mailboxId, opts.mailboxId) as ThreadRow | undefined;
  return row ?? null;
}

function createThread(
  ctx: AppContext,
  input: {
    mailboxId: string | null;
    serviceId: string | null;
    localAddress: string;
    subject: string;
    counterparty: string;
    counterpartyName: string | null;
    at: string;
  }
): ThreadRow {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO emailer_threads (id, mailbox_id, service_id, local_address, subject, subject_key, counterparty,
         counterparty_name, status, starred, unread_count, message_count, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, 0, 0, ?, ?)`
    )
    .run(
      id,
      input.mailboxId,
      input.serviceId,
      input.localAddress,
      input.subject || "(no subject)",
      subjectKey(input.subject),
      input.counterparty,
      input.counterpartyName,
      input.at,
      input.at
    );
  return getThreadRow(ctx, id);
}

function insertMessage(
  ctx: AppContext,
  thread: ThreadRow,
  m: {
    direction: "in" | "out";
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: MailAddress;
    to: MailAddress[];
    cc: MailAddress[];
    subject: string;
    text: string | null;
    html: string | null;
    attachments: MailAttachment[];
    status: string;
    error?: string | null;
    source: string;
    at: string;
  }
): MessageRow {
  const id = nanoid();
  const text = cap(m.text ?? (m.html ? htmlToText(m.html) : null), MAX_TEXT);
  const snippet = snippetOf(text);
  ctx.db
    .prepare(
      `INSERT INTO emailer_messages (id, thread_id, mailbox_id, service_id, direction, message_id, in_reply_to,
         references_json, from_addr, from_name, to_json, cc_json, subject, text_body, html_body, snippet,
         attachments_json, status, error, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      thread.id,
      thread.mailbox_id,
      thread.service_id,
      m.direction,
      m.messageId,
      m.inReplyTo,
      JSON.stringify(m.references.slice(-30)),
      m.from.address,
      m.from.name,
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      m.subject || "(no subject)",
      text,
      cap(m.html, MAX_HTML),
      snippet,
      JSON.stringify(m.attachments.slice(0, 50)),
      m.status,
      m.error ?? null,
      m.source,
      m.at
    );
  ctx.db
    .prepare(
      `UPDATE emailer_threads SET message_count = message_count + 1, last_direction = ?, last_snippet = ?,
         last_message_at = ?, unread_count = unread_count + ? WHERE id = ?`
    )
    .run(m.direction, snippet, m.at, m.direction === "in" ? 1 : 0, thread.id);
  return ctx.db.prepare("SELECT * FROM emailer_messages WHERE id = ?").get(id) as MessageRow;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export type InboundInput = {
  /** Raw RFC 5322 message as text (already charset-decoded by the relay). */
  raw?: string | null;
  /** Raw message as base64 — exact bytes, preferred (the Cloudflare worker sends this). */
  rawBase64?: string | null;
  envelope?: { from?: string | null; to?: string | string[] | null } | null;
  from?: string | { address: string; name?: string | null } | null;
  to?: string | string[] | null;
  cc?: string | string[] | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
};

function addressList(value: string | string[] | null | undefined): MailAddress[] {
  if (!value) return [];
  return parseAddressList(Array.isArray(value) ? value.join(", ") : value);
}

function referenceList(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(" ") : value;
  const ids = joined.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  return joined
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => normalizeMessageId(s) as string);
}

export type IngestResult = {
  duplicate: boolean;
  thread: EmailerThread;
  message: EmailerMessage;
};

export async function ingestInbound(ctx: AppContext, input: InboundInput): Promise<IngestResult> {
  let parsed: ReturnType<typeof parseMail> | null = null;
  if (input.rawBase64) {
    parsed = parseMail(Buffer.from(input.rawBase64, "base64").toString("latin1"), { binary: true });
  } else if (input.raw) {
    parsed = parseMail(input.raw);
  }

  const explicitFrom =
    typeof input.from === "string"
      ? parseAddressList(input.from)[0]
      : input.from && typeof input.from === "object" && input.from.address
        ? { address: input.from.address.toLowerCase(), name: input.from.name ?? null }
        : undefined;
  const from =
    explicitFrom ??
    parsed?.from ??
    (input.envelope?.from ? parseAddressList(input.envelope.from)[0] : undefined);
  if (!from || !from.address) throw httpError("Inbound message has no sender", 400);

  const to = addressList(input.to);
  const headerTo = to.length ? to : parsed?.to ?? [];
  const cc = input.cc ? addressList(input.cc) : parsed?.cc ?? [];
  const envelopeTo = addressList(input.envelope?.to ?? null);
  // The envelope recipient is the address mail was actually delivered to —
  // the only reliable one for Bcc'd or catch-all mail.
  const recipients = [...envelopeTo, ...headerTo, ...cc];
  if (recipients.length === 0) throw httpError("Inbound message has no recipient", 400);

  const subject = (input.subject ?? parsed?.subject ?? "").trim();
  const text = input.text ?? parsed?.text ?? null;
  const html = input.html ?? parsed?.html ?? null;
  const messageId = normalizeMessageId(input.messageId ?? parsed?.messageId ?? null);
  const inReplyTo = normalizeMessageId(input.inReplyTo ?? parsed?.inReplyTo ?? null);
  const references = input.references ? referenceList(input.references) : parsed?.references ?? [];
  const attachments = parsed?.attachments ?? [];

  if (messageId) {
    const dup = ctx.db
      .prepare("SELECT * FROM emailer_messages WHERE message_id = ? AND direction = 'in' LIMIT 1")
      .get(messageId) as MessageRow | undefined;
    if (dup) {
      // Relays retry on timeouts; the second delivery must not double-post.
      return { duplicate: true, thread: toThread(ctx, getThreadRow(ctx, dup.thread_id)), message: toMessage(dup) };
    }
  }

  const mailbox = matchMailbox(
    ctx,
    recipients.map((r) => r.address)
  );
  const localAddress =
    (mailbox && !mailbox.address.startsWith("*@") ? mailbox.address : null) ??
    (mailbox
      ? recipients.find((r) => r.address.endsWith(mailbox.address.slice(1)))?.address
      : undefined) ??
    recipients[0].address;

  const at = nowIso();
  const refs = [...references, ...(inReplyTo ? [inReplyTo] : [])];
  let thread = findThreadForMessage(ctx, {
    refs,
    mailboxId: mailbox?.id ?? null,
    counterparty: from.address,
    subjectKey: subjectKey(subject)
  });
  if (!thread) {
    thread = createThread(ctx, {
      mailboxId: mailbox?.id ?? null,
      serviceId: mailbox?.service_id ?? null,
      localAddress,
      subject,
      counterparty: from.address,
      counterpartyName: from.name,
      at
    });
  } else if (thread.status === "archived") {
    // A reply on an archived conversation brings it back to the inbox.
    ctx.db.prepare("UPDATE emailer_threads SET status = 'open' WHERE id = ?").run(thread.id);
  }
  if (from.name && !thread.counterparty_name && thread.counterparty === from.address) {
    ctx.db.prepare("UPDATE emailer_threads SET counterparty_name = ? WHERE id = ?").run(from.name, thread.id);
  }

  const row = insertMessage(ctx, thread, {
    direction: "in",
    messageId,
    inReplyTo,
    references,
    from,
    to: headerTo.length ? headerTo : envelopeTo,
    cc,
    subject,
    text,
    html,
    attachments,
    status: "received",
    source: "inbound",
    at
  });

  const fresh = getThreadRow(ctx, thread.id);
  const message = toMessage(row);
  broadcast(ctx, {
    type: "emailer_message",
    direction: "in",
    threadId: fresh.id,
    serviceId: fresh.service_id,
    from: from.address,
    subject: message.subject
  });
  void fanOut(ctx, "email.received", fresh, message, mailbox);
  return { duplicate: false, thread: toThread(ctx, fresh), message };
}

function eventPayload(thread: ThreadRow, message: EmailerMessage) {
  return {
    thread_id: thread.id,
    service_id: thread.service_id,
    mailbox: thread.local_address,
    message: {
      id: message.id,
      direction: message.direction,
      message_id: message.message_id,
      from: { address: message.from_addr, name: message.from_name },
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      text: message.text_body,
      snippet: message.snippet,
      attachments: message.attachments,
      created_at: message.created_at
    }
  };
}

async function fanOut(
  ctx: AppContext,
  event: "email.received" | "email.sent",
  thread: ThreadRow,
  message: EmailerMessage,
  mailbox: MailboxRow | null
): Promise<void> {
  const payload = eventPayload(thread, message);
  await emitN8nEvent(ctx, event, payload).catch(() => undefined);
  if (event !== "email.received" || !mailbox?.forward_url) return;
  let status: string;
  try {
    const res = await fetch(mailbox.forward_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-localsurv-event": event,
        "x-emailer-mailbox": mailbox.address
      },
      body: JSON.stringify({ event, at: nowIso(), ...payload }),
      signal: AbortSignal.timeout(8000)
    });
    status = res.ok ? `delivered (${res.status})` : `failed (${res.status})`;
  } catch (err) {
    status = `failed (${(err as Error).message})`;
  }
  try {
    ctx.db.prepare("UPDATE emailer_messages SET forward_status = ? WHERE id = ?").run(status, message.id);
  } catch {
    /* message deleted meanwhile */
  }
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export type SendInput = {
  mailboxId?: string | null;
  /** Explicit From when no mailbox applies (defaults to the shared SMTP From). */
  from?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  threadId?: string | null;
  source?: "dashboard" | "api" | "n8n";
  actor?: string;
};

function validateRecipients(list: string[] | undefined, label: string): string[] {
  const out = (list ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const a of out) if (!isEmailAddress(a)) throw httpError(`${label}: "${a}" is not a valid email address`, 400);
  return out;
}

function withSignature(text: string, signature: string | null): string {
  if (!signature) return text;
  if (text.includes(signature)) return text;
  return `${text.replace(/\s+$/, "")}\n\n-- \n${signature}`;
}

export async function sendEmailerMessage(
  ctx: AppContext,
  input: SendInput
): Promise<{ thread: EmailerThread; message: EmailerMessage }> {
  if (!smtpConfigured(ctx)) throw httpError("Configure SMTP credentials on the Email tab first", 400);
  const to = validateRecipients(input.to, "To");
  const cc = validateRecipients(input.cc, "Cc");
  if (to.length === 0) throw httpError("At least one recipient is required", 400);
  const subject = input.subject.trim();
  if (!input.text.trim() && !input.html) throw httpError("Message body is empty", 400);

  let thread: ThreadRow | null = input.threadId ? getThreadRow(ctx, input.threadId) : null;
  const mailboxId = input.mailboxId ?? thread?.mailbox_id ?? null;
  const mailbox = mailboxId ? getMailboxRow(ctx, mailboxId) : null;
  const smtp = readSmtpConfig(ctx);

  // Who are we sending as? A thread keeps the address the customer wrote to
  // (important for catch-all mailboxes); otherwise the mailbox, otherwise the
  // shared default From.
  const requestedFrom = input.from?.trim().toLowerCase() || null;
  let fromAddress = thread?.local_address || null;
  if (!fromAddress && mailbox) {
    if (mailbox.address.startsWith("*@")) {
      const domain = mailbox.address.slice(1);
      if (!requestedFrom || !requestedFrom.endsWith(domain)) {
        throw httpError(`Pick a concrete From address on ${domain.slice(1)} for this catch-all mailbox`, 400);
      }
      fromAddress = requestedFrom;
    } else {
      fromAddress = mailbox.address;
    }
  }
  if (!fromAddress) fromAddress = requestedFrom || smtp?.from || "";
  if (!isEmailAddress(fromAddress)) throw httpError("No valid From address — set one on the mailbox or Email tab", 400);
  const fromName = mailbox?.display_name || smtp?.fromName || null;

  // Threading headers for a reply.
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (thread) {
    const last = ctx.db
      .prepare(
        "SELECT message_id, references_json FROM emailer_messages WHERE thread_id = ? AND message_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get(thread.id) as { message_id: string; references_json: string } | undefined;
    if (last) {
      inReplyTo = last.message_id;
      references = [...parseJsonArray<string>(last.references_json), last.message_id].slice(-20);
    }
  }

  const finalSubject =
    thread && !subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : subject;
  if (!finalSubject) throw httpError("Subject is required", 400);
  const text = withSignature(input.text, mailbox?.signature ?? null);

  if (!thread) {
    thread = createThread(ctx, {
      mailboxId: mailbox?.id ?? null,
      serviceId: mailbox?.service_id ?? null,
      localAddress: fromAddress,
      subject: finalSubject,
      counterparty: to[0],
      counterpartyName: null,
      at: nowIso()
    });
  }

  let messageId: string | null = null;
  let status = "sent";
  let error: string | null = null;
  try {
    const sent = await sendSmtpMail(ctx, {
      from: fromAddress,
      fromName,
      to,
      cc,
      subject: finalSubject,
      text,
      html: input.html ?? null,
      inReplyTo,
      references
    });
    messageId = sent.messageId;
  } catch (err) {
    status = "failed";
    error = (err as Error).message;
  }

  const row = insertMessage(ctx, thread, {
    direction: "out",
    messageId,
    inReplyTo,
    references,
    from: { address: fromAddress, name: fromName },
    to: to.map((address) => ({ address, name: null })),
    cc: cc.map((address) => ({ address, name: null })),
    subject: finalSubject,
    text,
    html: input.html ?? null,
    attachments: [],
    status,
    error,
    source: input.source ?? "dashboard",
    at: nowIso()
  });
  // Replying is reading: the operator has clearly seen the conversation.
  ctx.db.prepare("UPDATE emailer_threads SET unread_count = 0, status = CASE WHEN status = 'spam' THEN status ELSE 'open' END WHERE id = ?").run(thread.id);
  const fresh = getThreadRow(ctx, thread.id);
  const message = toMessage(row);
  broadcast(ctx, { type: "emailer_message", direction: "out", threadId: fresh.id, serviceId: fresh.service_id });
  writeAuditLog(ctx, {
    actor: input.actor ?? "system",
    action: status === "sent" ? "emailer.send" : "emailer.send.failed",
    resourceType: "emailer",
    resourceId: fresh.id,
    statusCode: status === "sent" ? 200 : 502,
    details: `${fromAddress} -> ${to.join(", ")}`
  });
  if (status === "sent") void fanOut(ctx, "email.sent", fresh, message, mailbox);
  if (status === "failed") {
    const e = httpError(error ?? "Send failed", 502) as HttpError & { threadId?: string };
    e.threadId = fresh.id;
    throw e;
  }
  return { thread: toThread(ctx, fresh), message };
}

/** Re-send a failed outbound message in place. */
export async function retryMessage(ctx: AppContext, messageId: string, actor = "system"): Promise<EmailerMessage> {
  const row = ctx.db.prepare("SELECT * FROM emailer_messages WHERE id = ?").get(messageId) as MessageRow | undefined;
  if (!row) throw httpError("Message not found", 404);
  if (row.direction !== "out" || row.status !== "failed") throw httpError("Only failed outbound messages can be retried", 400);
  const m = toMessage(row);
  try {
    const sent = await sendSmtpMail(ctx, {
      from: m.from_addr,
      fromName: m.from_name,
      to: m.to.map((a) => a.address),
      cc: m.cc.map((a) => a.address),
      subject: m.subject,
      text: m.text_body ?? "",
      html: m.html_body,
      inReplyTo: m.in_reply_to,
      references: m.references
    });
    ctx.db
      .prepare("UPDATE emailer_messages SET status = 'sent', error = NULL, message_id = ? WHERE id = ?")
      .run(sent.messageId, messageId);
  } catch (err) {
    ctx.db.prepare("UPDATE emailer_messages SET error = ? WHERE id = ?").run((err as Error).message, messageId);
    throw err;
  }
  writeAuditLog(ctx, {
    actor,
    action: "emailer.send.retry",
    resourceType: "emailer",
    resourceId: row.thread_id,
    statusCode: 200
  });
  broadcast(ctx, { type: "emailer_update", threadId: row.thread_id, serviceId: row.service_id });
  return toMessage(ctx.db.prepare("SELECT * FROM emailer_messages WHERE id = ?").get(messageId) as MessageRow);
}

// ---------------------------------------------------------------------------
// Overview / per-service summary
// ---------------------------------------------------------------------------

export type ServiceMailSummary = {
  service_id: string;
  unread: number;
  threads: number;
  mailboxes: number;
  last_message_at: string | null;
};

export function emailerSummary(ctx: AppContext): {
  unread: number;
  open: number;
  unassigned: number;
  services: ServiceMailSummary[];
} {
  const totals = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status != 'spam' THEN unread_count ELSE 0 END), 0) AS unread,
              COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
              COALESCE(SUM(CASE WHEN mailbox_id IS NULL AND status != 'spam' THEN 1 ELSE 0 END), 0) AS unassigned
       FROM emailer_threads`
    )
    .get() as { unread: number; open: number; unassigned: number };
  const perService = ctx.db
    .prepare(
      `SELECT service_id,
              COALESCE(SUM(CASE WHEN status != 'spam' THEN unread_count ELSE 0 END), 0) AS unread,
              COUNT(*) AS threads, MAX(last_message_at) AS last_message_at
       FROM emailer_threads WHERE service_id IS NOT NULL GROUP BY service_id`
    )
    .all() as Array<{ service_id: string; unread: number; threads: number; last_message_at: string | null }>;
  const mailboxCounts = ctx.db
    .prepare("SELECT service_id, COUNT(*) AS c FROM emailer_mailboxes WHERE service_id IS NOT NULL GROUP BY service_id")
    .all() as Array<{ service_id: string; c: number }>;
  const byService = new Map<string, ServiceMailSummary>();
  for (const r of perService) {
    byService.set(r.service_id, {
      service_id: r.service_id,
      unread: Number(r.unread),
      threads: Number(r.threads),
      mailboxes: 0,
      last_message_at: r.last_message_at
    });
  }
  for (const m of mailboxCounts) {
    const existing = byService.get(m.service_id) ?? {
      service_id: m.service_id,
      unread: 0,
      threads: 0,
      mailboxes: 0,
      last_message_at: null
    };
    existing.mailboxes = Number(m.c);
    byService.set(m.service_id, existing);
  }
  return {
    unread: Number(totals.unread),
    open: Number(totals.open),
    unassigned: Number(totals.unassigned),
    services: [...byService.values()]
  };
}

export function emailerStats(ctx: AppContext, serviceId?: string | null): {
  received_7d: number;
  sent_7d: number;
  failed_7d: number;
} {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const svc = serviceId ? " AND service_id = ?" : "";
  const args = serviceId ? [since, serviceId] : [since];
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END), 0) AS received,
              COALESCE(SUM(CASE WHEN direction = 'out' AND status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
              COALESCE(SUM(CASE WHEN direction = 'out' AND status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM emailer_messages WHERE created_at >= ?${svc}`
    )
    .get(...args) as { received: number; sent: number; failed: number };
  return { received_7d: Number(row.received), sent_7d: Number(row.sent), failed_7d: Number(row.failed) };
}

// ---------------------------------------------------------------------------
// Ingest endpoint config
// ---------------------------------------------------------------------------

export function getIngestToken(ctx: AppContext): string {
  const existing = getSecretSetting(ctx, SETTING_INGEST_TOKEN);
  if (existing) return existing;
  const token = `emi_${crypto.randomBytes(24).toString("base64url")}`;
  setSecretSetting(ctx, SETTING_INGEST_TOKEN, token);
  return token;
}

export function rotateIngestToken(ctx: AppContext, actor = "system"): string {
  const token = `emi_${crypto.randomBytes(24).toString("base64url")}`;
  setSecretSetting(ctx, SETTING_INGEST_TOKEN, token);
  writeAuditLog(ctx, {
    actor,
    action: "emailer.ingest.rotate",
    resourceType: "emailer",
    resourceId: "ingest",
    statusCode: 200
  });
  return token;
}

export function verifyIngestToken(ctx: AppContext, presented: string | null | undefined): boolean {
  const expected = getSecretSetting(ctx, SETTING_INGEST_TOKEN);
  if (!expected || !presented) return false;
  return safeEqual(expected, presented.trim());
}

export function getEmailerPublicUrl(ctx: AppContext): string | null {
  const raw = (getSetting(ctx, SETTING_PUBLIC_URL) ?? "").trim().replace(/\/+$/, "");
  if (raw) return raw;
  const fromConfig = (ctx.config as { publicUrl?: string }).publicUrl;
  return fromConfig ? fromConfig.replace(/\/+$/, "") : null;
}

export function setEmailerPublicUrl(ctx: AppContext, url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    } catch {
      throw httpError("Public URL must be an absolute http(s) URL", 400);
    }
  }
  setSetting(ctx, SETTING_PUBLIC_URL, trimmed);
  return trimmed || null;
}

export function emailerBaseUrl(ctx: AppContext, requestHost?: string | null): string {
  const pub = getEmailerPublicUrl(ctx);
  if (pub) return pub;
  if (requestHost) return requestHost.startsWith("http") ? requestHost : `http://${requestHost}`;
  return `http://127.0.0.1:${ctx.config.apiPort}`;
}

/**
 * The Cloudflare Email Worker that relays every message it receives to the
 * ingest endpoint. If delivery fails it forwards to FALLBACK_FORWARD (when set)
 * so mail is never lost while the host is down; otherwise it rejects, which
 * makes the sender's server retry later.
 */
export function cloudflareWorkerScript(opts: { ingestUrl?: string; token?: string } = {}): string {
  const urlLiteral = opts.ingestUrl ? JSON.stringify(opts.ingestUrl) : "undefined";
  const tokenLiteral = opts.token ? JSON.stringify(opts.token) : "undefined";
  return `// LocalSURV Emailer relay — Cloudflare Email Worker.
// Route an address (or the catch-all) to this Worker in Email Routing.
const INGEST_URL = ${urlLiteral};
const INGEST_TOKEN = ${tokenLiteral};

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export default {
  async email(message, env) {
    const url = env.INGEST_URL || INGEST_URL;
    const token = env.INGEST_TOKEN || INGEST_TOKEN;
    const raw = await new Response(message.raw).arrayBuffer();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-emailer-token": token },
        body: JSON.stringify({
          envelope: { from: message.from, to: message.to },
          rawBase64: toBase64(raw)
        })
      });
      if (!res.ok) throw new Error("ingest returned " + res.status);
    } catch (err) {
      if (env.FALLBACK_FORWARD) {
        await message.forward(env.FALLBACK_FORWARD);
        return;
      }
      message.setReject("Temporary delivery failure, please retry later");
    }
  }
};
`;
}

// ---------------------------------------------------------------------------
// Cloudflare: deploy the relay Worker + route addresses to it
// ---------------------------------------------------------------------------

const CF_BASE = "https://api.cloudflare.com/client/v4";

function cloudflareCreds(ctx: AppContext): { token: string; accountId: string } {
  const token = getSecretSetting(ctx, "email_routing_token") ?? getSecretSetting(ctx, "cloudflare_api_token");
  const accountId = getSecretSetting(ctx, "cloudflare_account_id");
  if (!token || !accountId) {
    throw httpError(
      "Cloudflare is not connected — add an Email Routing token + account id on the Email tab (Receiving)",
      400
    );
  }
  return { token, accountId };
}

async function cf(ctx: AppContext, apiPath: string, init: RequestInit = {}): Promise<unknown> {
  const { token } = cloudflareCreds(ctx);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (!(init.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(`${CF_BASE}${apiPath}`, {
    ...init,
    headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(20000)
  });
  type CfEnvelope = { success?: boolean; result?: unknown; errors?: Array<{ message?: string; code?: number }> };
  let data: CfEnvelope | null = null;
  try {
    data = (await res.json()) as CfEnvelope;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !data?.success) {
    const msg = data?.errors?.[0]?.message || `Cloudflare API returned ${res.status}`;
    const hint =
      res.status === 403 || /auth/i.test(msg)
        ? " — the token needs Workers Scripts: Edit (account) and Email Routing Rules: Edit (zone)"
        : "";
    throw httpError(`Cloudflare: ${msg}${hint}`, 502);
  }
  return data.result;
}

export function workerName(ctx: AppContext): string {
  return getSetting(ctx, SETTING_WORKER_NAME) || "localsurv-emailer";
}

export async function deployCloudflareWorker(
  ctx: AppContext,
  opts: { requestHost?: string | null; fallbackForward?: string | null; actor?: string }
): Promise<{ script: string; ingestUrl: string }> {
  const { accountId } = cloudflareCreds(ctx);
  const base = emailerBaseUrl(ctx, opts.requestHost);
  if (/^https?:\/\/(127\.|localhost|0\.0\.0\.0)/.test(base)) {
    throw httpError(
      "Set the Emailer public URL first — Cloudflare cannot reach a loopback address",
      400
    );
  }
  const ingestUrl = `${base}/emailer/inbound`;
  const script = workerName(ctx);
  const bindings: Array<Record<string, string>> = [
    { type: "plain_text", name: "INGEST_URL", text: ingestUrl },
    { type: "secret_text", name: "INGEST_TOKEN", text: getIngestToken(ctx) }
  ];
  const fallback = opts.fallbackForward?.trim();
  if (fallback) {
    if (!isEmailAddress(fallback)) throw httpError("Fallback forward must be an email address", 400);
    bindings.push({ type: "plain_text", name: "FALLBACK_FORWARD", text: fallback });
  }
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2024-09-23", bindings })], {
      type: "application/json"
    })
  );
  form.append(
    "worker.js",
    new Blob([cloudflareWorkerScript()], { type: "application/javascript+module" }),
    "worker.js"
  );
  await cf(ctx, `/accounts/${accountId}/workers/scripts/${script}`, { method: "PUT", body: form });
  writeAuditLog(ctx, {
    actor: opts.actor ?? "system",
    action: "emailer.cloudflare.worker.deploy",
    resourceType: "emailer",
    resourceId: script,
    statusCode: 200,
    details: ingestUrl
  });
  return { script, ingestUrl };
}

/** Point Cloudflare Email Routing for a mailbox's address at the relay Worker. */
export async function routeMailboxToWorker(
  ctx: AppContext,
  mailboxId: string,
  actor = "system"
): Promise<{ zone: string; rule: string }> {
  const mailbox = getMailboxRow(ctx, mailboxId);
  const domain = mailbox.address.split("@")[1];
  const zones = (await cf(ctx, `/zones?name=${encodeURIComponent(domain)}`)) as Array<{ id: string; name: string }>;
  let zone = zones[0];
  if (!zone) {
    // Subdomain address — walk up to the registrable zone.
    const parts = domain.split(".");
    for (let i = 1; i < parts.length - 1 && !zone; i++) {
      const parent = parts.slice(i).join(".");
      const found = (await cf(ctx, `/zones?name=${encodeURIComponent(parent)}`)) as Array<{ id: string; name: string }>;
      zone = found[0];
    }
  }
  if (!zone) throw httpError(`No Cloudflare zone found for ${domain}`, 404);
  const script = workerName(ctx);
  await cf(ctx, `/zones/${zone.id}/email/routing/enable`, { method: "POST", body: "{}" }).catch(() => null);
  if (mailbox.address.startsWith("*@")) {
    await cf(ctx, `/zones/${zone.id}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: JSON.stringify({ actions: [{ type: "worker", value: [script] }], matchers: [{ type: "all" }], enabled: true })
    });
  } else {
    await cf(ctx, `/zones/${zone.id}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        actions: [{ type: "worker", value: [script] }],
        matchers: [{ type: "literal", field: "to", value: mailbox.address }],
        enabled: true,
        name: `${mailbox.address} -> LocalSURV Emailer`
      })
    });
  }
  writeAuditLog(ctx, {
    actor,
    action: "emailer.cloudflare.route",
    resourceType: "emailer",
    resourceId: mailboxId,
    statusCode: 200,
    details: `${mailbox.address} @ ${zone.name}`
  });
  return { zone: zone.name, rule: mailbox.address.startsWith("*@") ? "catch_all" : mailbox.address };
}

// ---------------------------------------------------------------------------
// Service integration
// ---------------------------------------------------------------------------

/**
 * Give the mailbox's service everything it needs to send through the Emailer
 * API: a fresh mailbox token plus the endpoint, written as secret env vars.
 * The service must be restarted to see them, exactly like any other env edit.
 */
export function injectMailboxEnv(
  ctx: AppContext,
  mailboxId: string,
  opts: { requestHost?: string | null; actor?: string } = {}
): { service_id: string; keys: string[] } {
  const row = getMailboxRow(ctx, mailboxId);
  if (!row.service_id) throw httpError("Link this mailbox to a service first", 400);
  const { token } = mintMailboxToken(ctx, mailboxId, opts.actor);
  const base = emailerBaseUrl(ctx, opts.requestHost);
  const values: Array<[string, string, boolean]> = [
    ["EMAILER_API_URL", `${base}/emailer/api`, false],
    ["EMAILER_API_TOKEN", token, true],
    ["EMAILER_FROM", row.address, false]
  ];
  for (const [key, value, secret] of values) {
    const stored = secret ? encryptSecret(value, ctx.config.secretKey) : value;
    const existing = ctx.db
      .prepare("SELECT id FROM env_vars WHERE service_id = ? AND key = ?")
      .get(row.service_id, key) as { id: string } | undefined;
    if (existing) {
      ctx.db.prepare("UPDATE env_vars SET value = ?, is_secret = ? WHERE id = ?").run(stored, secret ? 1 : 0, existing.id);
    } else {
      ctx.db
        .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
        .run(nanoid(), row.service_id, key, stored, secret ? 1 : 0);
    }
  }
  writeAuditLog(ctx, {
    actor: opts.actor ?? "system",
    action: "emailer.mailbox.inject-env",
    resourceType: "service",
    resourceId: row.service_id,
    statusCode: 200,
    details: row.address
  });
  return { service_id: row.service_id, keys: values.map((v) => v[0]) };
}
