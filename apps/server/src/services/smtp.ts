import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { getSecretSetting, getSetting } from "./settings.js";

const execFileP = promisify(execFile);

/**
 * Outbound mail through the shared SMTP credentials on the Email tab.
 *
 * Sending uses curl's SMTP client (already on every host we support) through a
 * mode-600 config file, so the SMTP token never lands in the process argv. Port
 * 465 speaks implicit TLS (smtps://); any other port is plain SMTP upgraded with
 * STARTTLS, and `ssl-reqd` refuses to fall back to cleartext either way.
 */

export type SmtpConfig = {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
  fromName: string;
};

export type OutgoingMail = {
  from: string;
  fromName?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  replyTo?: string | null;
};

export function smtpConfigured(ctx: AppContext): boolean {
  return Boolean(getSetting(ctx, "smtp_host") && getSecretSetting(ctx, "smtp_password"));
}

export function readSmtpConfig(ctx: AppContext): SmtpConfig | null {
  if (!smtpConfigured(ctx)) return null;
  return {
    host: getSetting(ctx, "smtp_host") ?? "",
    port: getSetting(ctx, "smtp_port") ?? "465",
    user: getSetting(ctx, "smtp_user") ?? "api_token",
    password: getSecretSetting(ctx, "smtp_password") ?? "",
    from: getSetting(ctx, "smtp_from") ?? "",
    fromName: getSetting(ctx, "smtp_from_name") ?? ""
  };
}

function needsEncoding(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

/** RFC 2047 B-encoding for header values that aren't plain printable ASCII. */
export function encodeHeaderValue(value: string): string {
  if (!needsEncoding(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(address: string, name?: string | null): string {
  if (!name) return address;
  const safe = needsEncoding(name) ? encodeHeaderValue(name) : `"${name.replace(/["\\]/g, "")}"`;
  return `${safe} <${address}>`;
}

function base64Lines(value: string): string {
  return (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Strip CR/LF so caller-supplied values can never inject extra headers. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1]?.trim() || "localsurv.local";
  return `<${Date.now().toString(36)}.${crypto.randomBytes(9).toString("base64url")}@${domain}>`;
}

/** Render an RFC 5322 message. Exported for tests. */
export function buildMimeMessage(mail: OutgoingMail, messageId: string): string {
  const headers: string[] = [
    `From: ${formatAddress(headerSafe(mail.from), mail.fromName ? headerSafe(mail.fromName) : null)}`,
    `To: ${mail.to.map(headerSafe).join(", ")}`
  ];
  if (mail.cc && mail.cc.length) headers.push(`Cc: ${mail.cc.map(headerSafe).join(", ")}`);
  if (mail.replyTo) headers.push(`Reply-To: ${headerSafe(mail.replyTo)}`);
  headers.push(`Subject: ${encodeHeaderValue(headerSafe(mail.subject))}`);
  headers.push(`Date: ${new Date().toUTCString().replace("GMT", "+0000")}`);
  headers.push(`Message-ID: ${headerSafe(messageId)}`);
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${headerSafe(mail.inReplyTo)}`);
  if (mail.references && mail.references.length) {
    headers.push(`References: ${mail.references.map(headerSafe).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push("X-Mailer: LocalSURV Emailer");

  let body: string;
  if (mail.html) {
    const boundary = `lsv_${crypto.randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(mail.text),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(mail.html),
      `--${boundary}--`,
      ""
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
    body = base64Lines(mail.text) + "\r\n";
  }
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Send one message. Resolves with the Message-ID; rejects with curl's stderr. */
export async function sendSmtpMail(ctx: AppContext, mail: OutgoingMail): Promise<{ messageId: string }> {
  const cfg = readSmtpConfig(ctx);
  if (!cfg) {
    const e = new Error("Configure SMTP credentials on the Email tab first") as Error & { statusCode?: number };
    e.statusCode = 400;
    throw e;
  }
  const recipients = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].map(headerSafe).filter(Boolean);
  if (recipients.length === 0) {
    const e = new Error("At least one recipient is required") as Error & { statusCode?: number };
    e.statusCode = 400;
    throw e;
  }
  const messageId = mail.messageId ?? newMessageId(mail.from);
  const message = buildMimeMessage(mail, messageId);
  const suffix = nanoid();
  const msgPath = path.join(os.tmpdir(), `sh-mail-${suffix}.eml`);
  const cfgPath = path.join(os.tmpdir(), `sh-mailcfg-${suffix}`);
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const scheme = cfg.port === "465" ? "smtps" : "smtp";
  const lines = [
    `url = "${scheme}://${q(cfg.host)}:${q(cfg.port)}"`,
    `user = "${q(cfg.user)}:${q(cfg.password)}"`,
    `mail-from = "${q(headerSafe(mail.from))}"`,
    ...recipients.map((r) => `mail-rcpt = "${q(r)}"`),
    `upload-file = "${q(msgPath)}"`,
    "ssl-reqd",
    "silent",
    "show-error"
  ];
  try {
    fs.writeFileSync(msgPath, message, "utf8");
    fs.writeFileSync(cfgPath, lines.join("\n"), { mode: 0o600 });
    await execFileP("curl", ["--config", cfgPath], { timeout: 30000 });
    return { messageId };
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr || (err as Error).message || "unknown error";
    const e = new Error(`Send failed: ${String(detail).trim()}`) as Error & { statusCode?: number };
    e.statusCode = 502;
    throw e;
  } finally {
    try {
      fs.unlinkSync(msgPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(cfgPath);
    } catch {
      /* ignore */
    }
  }
}
