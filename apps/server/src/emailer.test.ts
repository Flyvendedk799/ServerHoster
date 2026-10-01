/**
 * Emailer — MIME parsing, threading, mailbox routing, tokens, and the outbound
 * message builder. No network: sending is only exercised up to the SMTP guard.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import type { AppContext } from "./types.js";
import { parseMail, snippetOf, subjectKey } from "./lib/mime.js";
import { buildMimeMessage } from "./services/smtp.js";
import {
  createMailbox,
  emailerSummary,
  getIngestToken,
  getThread,
  ingestInbound,
  listThreads,
  mailboxForToken,
  matchMailbox,
  mintMailboxToken,
  rotateIngestToken,
  sendEmailerMessage,
  updateMailbox,
  updateThread,
  verifyIngestToken,
  deleteMailbox
} from "./services/emailer.js";
import { isApiPath } from "./routes/auth.js";

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE services (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL);
CREATE TABLE env_vars (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  resource_type TEXT NOT NULL, resource_id TEXT, status_code INTEGER NOT NULL,
  details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE emailer_mailboxes (
  id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, display_name TEXT, service_id TEXT,
  forward_url TEXT, signature TEXT, api_token_hash TEXT, api_token_prefix TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE emailer_threads (
  id TEXT PRIMARY KEY, mailbox_id TEXT, service_id TEXT, local_address TEXT NOT NULL,
  subject TEXT NOT NULL, subject_key TEXT NOT NULL, counterparty TEXT NOT NULL,
  counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', starred INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
  last_direction TEXT, last_snippet TEXT, last_message_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE emailer_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, mailbox_id TEXT, service_id TEXT,
  direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, references_json TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT NOT NULL, from_name TEXT, to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL, text_body TEXT, html_body TEXT,
  snippet TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, error TEXT,
  source TEXT NOT NULL, forward_status TEXT, created_at TEXT NOT NULL
);
`;

let ctx: AppContext;

function makeContext(): AppContext {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO services (id, project_id, name) VALUES (?, ?, ?)").run("svc-shop", "p1", "shop");
  db.prepare("INSERT INTO services (id, project_id, name) VALUES (?, ?, ?)").run("svc-blog", "p1", "blog");
  return {
    db,
    config: { secretKey: "test-secret-key-32-bytes-not-for-prod", apiPort: 8787, publicUrl: "" },
    wsSubscribers: new Set(),
    app: { log: { info() {}, warn() {}, error() {}, child: () => ({}) } }
  } as unknown as AppContext;
}

beforeEach(() => {
  ctx = makeContext();
});

const MULTIPART = [
  "From: =?UTF-8?B?SsO4cmdlbiBIYW5zZW4=?= <Jorgen@Example.com>",
  "To: Support <support@shop.dk>",
  "Subject: =?UTF-8?Q?Sp=C3=B8rgsm=C3=A5l_om_ordre?=",
  "Message-ID: <abc123@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hej, hvor er min ordre? Den er =C3=B8 forsinket.",
  "",
  "> old quoted line",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("<p>Hej, hvor er min <b>ordre</b>?</p>").toString("base64"),
  "--inner--",
  "--outer",
  'Content-Type: application/pdf; name="faktura.pdf"',
  "Content-Disposition: attachment; filename=\"faktura.pdf\"",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 fake").toString("base64"),
  "--outer--",
  ""
].join("\r\n");

describe("mime", () => {
  test("parses nested multipart with encoded headers and attachments", () => {
    const m = parseMail(MULTIPART);
    assert.equal(m.from?.address, "jorgen@example.com");
    assert.equal(m.from?.name, "Jørgen Hansen");
    assert.equal(m.subject, "Spørgsmål om ordre");
    assert.equal(m.to[0].address, "support@shop.dk");
    assert.equal(m.messageId, "<abc123@example.com>");
    assert.match(m.text ?? "", /Den er ø forsinket/);
    assert.match(m.html ?? "", /<b>ordre<\/b>/);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].filename, "faktura.pdf");
  });

  test("binary mode decodes 8bit bodies with their declared charset", () => {
    const raw =
      "From: a@b.co\r\nTo: x@y.co\r\nSubject: hi\r\nContent-Type: text/plain; charset=iso-8859-1\r\n" +
      "Content-Transfer-Encoding: 8bit\r\n\r\nblåbær";
    // latin1 bytes for "blåbær" are exactly these code units.
    assert.equal(parseMail(raw, { binary: true }).text, "blåbær");
    const utf8 = Buffer.from(
      "From: a@b.co\r\nTo: x@y.co\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nblåbær",
      "utf8"
    ).toString("latin1");
    assert.equal(parseMail(utf8, { binary: true }).text, "blåbær");
  });

  test("subject keys and snippets ignore reply prefixes and quotes", () => {
    assert.equal(subjectKey("Re: SV: Fwd:  Order   #12"), "order #12");
    assert.equal(subjectKey("AW: Hallo"), "hallo");
    assert.equal(snippetOf("Thanks!\n\nOn Mon, Jane wrote:\n> earlier"), "Thanks!");
  });
});

describe("outbound message builder", () => {
  test("encodes non-ascii subjects and strips header injection", () => {
    const msg = buildMimeMessage(
      {
        from: "support@shop.dk",
        fromName: "Shop Support",
        to: ["jane@example.com"],
        subject: "Ordre bekræftet\r\nBcc: evil@x.com",
        text: "Hej",
        inReplyTo: "<abc@x>",
        references: ["<root@x>", "<abc@x>"]
      },
      "<id@shop.dk>"
    );
    assert.ok(!/\r\nBcc:/i.test(msg), "CRLF in a header value must not start a new header");
    assert.match(msg, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(msg, /^In-Reply-To: <abc@x>/m);
    assert.match(msg, /^References: <root@x> <abc@x>/m);
    assert.match(msg, /^From: "Shop Support" <support@shop.dk>/m);
  });
});

describe("emailer threading", () => {
  test("inbound mail lands in the owning service's mailbox and replies thread", async () => {
    const mb = createMailbox(ctx, { address: "Support@Shop.dk", serviceId: "svc-shop" });
    assert.equal(mb.address, "support@shop.dk");

    const first = await ingestInbound(ctx, { raw: MULTIPART });
    assert.equal(first.duplicate, false);
    assert.equal(first.thread.service_id, "svc-shop");
    assert.equal(first.thread.mailbox_id, mb.id);
    assert.equal(first.thread.unread_count, 1);
    assert.equal(first.message.attachments.length, 1);

    // Same Message-ID again (relay retry) must not double-post.
    const retry = await ingestInbound(ctx, { raw: MULTIPART });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.message.id, first.message.id);

    // Header-threaded follow-up.
    const reply = await ingestInbound(ctx, {
      from: "jorgen@example.com",
      to: "support@shop.dk",
      subject: "Totally different subject",
      text: "Any news?",
      messageId: "<def456@example.com>",
      inReplyTo: "<abc123@example.com>"
    });
    assert.equal(reply.thread.id, first.thread.id);

    // Header-less follow-up threads on counterparty + subject.
    const fallback = await ingestInbound(ctx, {
      from: "Jørgen <jorgen@example.com>",
      envelope: { to: "support@shop.dk" },
      subject: "Re: Spørgsmål om ordre",
      text: "Hello?"
    });
    assert.equal(fallback.thread.id, first.thread.id);

    const { thread, messages } = getThread(ctx, first.thread.id, { markRead: true });
    assert.equal(messages.length, 3);
    assert.equal(thread.unread_count, 0);
    assert.equal(thread.message_count, 3);
  });

  test("catch-all mailboxes match by domain; envelope recipient wins", async () => {
    createMailbox(ctx, { address: "*@blog.io", serviceId: "svc-blog" });
    assert.ok(matchMailbox(ctx, ["hello@blog.io"]));
    const res = await ingestInbound(ctx, {
      from: "x@y.com",
      to: "undisclosed-recipients:;",
      envelope: { to: "press@blog.io" },
      subject: "Interview",
      text: "Hi"
    });
    assert.equal(res.thread.service_id, "svc-blog");
    assert.equal(res.thread.local_address, "press@blog.io");
  });

  test("unassigned mail is adopted when its mailbox is created, and kept on delete", async () => {
    const res = await ingestInbound(ctx, { from: "a@b.com", to: "sales@shop.dk", subject: "Quote", text: "?" });
    assert.equal(res.thread.mailbox_id, null);
    assert.equal(listThreads(ctx, { unassigned: true }).total, 1);

    const mb = createMailbox(ctx, { address: "sales@shop.dk", serviceId: "svc-shop" });
    assert.equal(getThread(ctx, res.thread.id).thread.service_id, "svc-shop");
    assert.equal(getThread(ctx, res.thread.id).messages[0].service_id, "svc-shop");

    updateMailbox(ctx, mb.id, { serviceId: "svc-blog" });
    assert.equal(getThread(ctx, res.thread.id).thread.service_id, "svc-blog");

    deleteMailbox(ctx, mb.id);
    const after = getThread(ctx, res.thread.id).thread;
    assert.equal(after.mailbox_id, null);
    assert.equal(after.service_id, null);
  });

  test("folders, search and per-service summary", async () => {
    createMailbox(ctx, { address: "support@shop.dk", serviceId: "svc-shop" });
    const a = await ingestInbound(ctx, { from: "a@x.com", to: "support@shop.dk", subject: "Refund", text: "please refund" });
    await ingestInbound(ctx, { from: "b@x.com", to: "support@shop.dk", subject: "Hello", text: "hi" });

    assert.equal(listThreads(ctx, { folder: "inbox" }).total, 2);
    assert.equal(listThreads(ctx, { q: "refund" }).total, 1);
    assert.equal(listThreads(ctx, { serviceId: "svc-blog" }).total, 0);

    updateThread(ctx, a.thread.id, { status: "archived", starred: true });
    assert.equal(listThreads(ctx, { folder: "inbox" }).total, 1);
    assert.equal(listThreads(ctx, { folder: "archived" }).total, 1);
    assert.equal(listThreads(ctx, { folder: "starred" }).total, 1);

    // New mail on an archived conversation reopens it.
    await ingestInbound(ctx, {
      from: "a@x.com",
      to: "support@shop.dk",
      subject: "Re: Refund",
      text: "any update?"
    });
    assert.equal(getThread(ctx, a.thread.id).thread.status, "open");

    const summary = emailerSummary(ctx);
    assert.equal(summary.unread, 3);
    const shop = summary.services.find((s) => s.service_id === "svc-shop");
    assert.equal(shop?.unread, 3);
    assert.equal(shop?.threads, 2);
    assert.equal(shop?.mailboxes, 1);
  });

  test("sending without SMTP configured is refused before anything is stored", async () => {
    await assert.rejects(
      sendEmailerMessage(ctx, { to: ["a@b.com"], subject: "x", text: "y" }),
      (err: Error & { statusCode?: number }) => err.statusCode === 400
    );
    assert.equal(listThreads(ctx, { folder: "all" }).total, 0);
  });
});

describe("emailer credentials", () => {
  test("ingest token verifies and rotates", () => {
    assert.equal(verifyIngestToken(ctx, "anything"), false);
    const token = getIngestToken(ctx);
    assert.equal(verifyIngestToken(ctx, token), true);
    assert.equal(verifyIngestToken(ctx, `${token}x`), false);
    const next = rotateIngestToken(ctx);
    assert.equal(verifyIngestToken(ctx, token), false);
    assert.equal(verifyIngestToken(ctx, next), true);
    const stored = (ctx.db.prepare("SELECT value FROM settings WHERE key = 'emailer_ingest_token'").get() as {
      value: string;
    }).value;
    assert.ok(!stored.includes(next), "ingest token must be encrypted at rest");
  });

  test("mailbox API tokens are hashed and catch-alls cannot mint one", () => {
    const mb = createMailbox(ctx, { address: "noreply@shop.dk", serviceId: "svc-shop" });
    const { token } = mintMailboxToken(ctx, mb.id);
    assert.match(token, /^emk_/);
    assert.equal(mailboxForToken(ctx, token)?.id, mb.id);
    assert.equal(mailboxForToken(ctx, "emk_nope"), null);
    const row = ctx.db.prepare("SELECT api_token_hash FROM emailer_mailboxes WHERE id = ?").get(mb.id) as {
      api_token_hash: string;
    };
    assert.notEqual(row.api_token_hash, token);

    const wild = createMailbox(ctx, { address: "*@shop.dk" });
    assert.throws(() => mintMailboxToken(ctx, wild.id), /catch-all/);
  });

  test("the /emailer namespace is auth-gated", () => {
    assert.equal(isApiPath("/emailer/threads"), true);
    assert.equal(isApiPath("/emailer/inbound"), true);
  });

  test("mailbox validation", () => {
    assert.throws(() => createMailbox(ctx, { address: "not-an-email" }), /valid email/);
    assert.throws(() => createMailbox(ctx, { address: "a@b.co", serviceId: "missing" }), /Service not found/);
    assert.throws(
      () => createMailbox(ctx, { address: "a@b.co", forwardUrl: "ftp://x" }),
      /Forward URL/
    );
    createMailbox(ctx, { address: "a@b.co" });
    assert.throws(() => createMailbox(ctx, { address: "A@B.co" }), /already exists/);
  });
});
