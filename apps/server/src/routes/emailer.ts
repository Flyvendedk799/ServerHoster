import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../types.js";
import {
  cloudflareWorkerScript,
  createMailbox,
  deleteMailbox,
  deleteThread,
  deployCloudflareWorker,
  emailerBaseUrl,
  emailerStats,
  emailerSummary,
  getEmailerPublicUrl,
  getIngestToken,
  getThread,
  ingestInbound,
  injectMailboxEnv,
  listMailboxes,
  listThreads,
  mailboxForToken,
  mintMailboxToken,
  retryMessage,
  revokeMailboxToken,
  rotateIngestToken,
  routeMailboxToWorker,
  sendEmailerMessage,
  setEmailerPublicUrl,
  updateMailbox,
  updateThread,
  verifyIngestToken,
  workerName
} from "../services/emailer.js";
import { readSmtpConfig, smtpConfigured } from "../services/smtp.js";
import { getSecretSetting } from "../services/settings.js";

/** Raw messages with attachments are large; text is all we keep. */
const INBOUND_BODY_LIMIT = 25 * 1024 * 1024;

const addressList = z.union([z.string(), z.array(z.string())]).optional().nullable();

const inboundSchema = z
  .object({
    raw: z.string().optional().nullable(),
    rawBase64: z.string().optional().nullable(),
    envelope: z
      .object({ from: z.string().optional().nullable(), to: addressList })
      .optional()
      .nullable(),
    from: z
      .union([z.string(), z.object({ address: z.string(), name: z.string().optional().nullable() })])
      .optional()
      .nullable(),
    to: addressList,
    cc: addressList,
    subject: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    html: z.string().optional().nullable(),
    messageId: z.string().optional().nullable(),
    inReplyTo: z.string().optional().nullable(),
    references: addressList
  })
  .passthrough();

const mailboxSchema = z.object({
  address: z.string().min(3).max(320),
  displayName: z.string().max(200).optional().nullable(),
  serviceId: z.string().optional().nullable(),
  forwardUrl: z.string().max(2000).optional().nullable(),
  signature: z.string().max(4000).optional().nullable()
});

const recipients = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(/[,;]/)).map((s) => s.trim()).filter(Boolean));

const sendSchema = z.object({
  mailboxId: z.string().optional().nullable(),
  from: z.string().optional().nullable(),
  to: recipients,
  cc: recipients.optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(512 * 1024).default(""),
  html: z.string().max(1024 * 1024).optional().nullable()
});

const replySchema = z.object({
  text: z.string().min(1).max(512 * 1024),
  html: z.string().max(1024 * 1024).optional().nullable(),
  cc: recipients.optional()
});

const threadQuerySchema = z.object({
  folder: z.enum(["inbox", "unread", "starred", "sent", "archived", "spam", "all"]).default("inbox"),
  serviceId: z.string().optional(),
  mailboxId: z.string().optional(),
  unassigned: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

function actorOf(req: unknown): string {
  return (req as { actor?: string }).actor ?? "unknown";
}

function requestOrigin(req: FastifyRequest): string | null {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (!host) return null;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol ?? "http";
  return `${proto}://${Array.isArray(host) ? host[0] : host}`;
}

function bearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return null;
}

export function registerEmailerRoutes(ctx: AppContext): void {
  // Relays may post the bare RFC 822 message instead of JSON.
  try {
    ctx.app.addContentTypeParser(
      "message/rfc822",
      { parseAs: "string", bodyLimit: INBOUND_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    );
  } catch {
    /* already registered */
  }

  // ---- Public: inbound relay -------------------------------------------------
  // Auth-gate bypass is in routes/auth.ts; the ingest token is checked here.
  ctx.app.post(
    "/emailer/inbound",
    {
      bodyLimit: INBOUND_BODY_LIMIT,
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
    },
    async (req, reply) => {
      const query = (req.query ?? {}) as { token?: string };
      const presented =
        (req.headers["x-emailer-token"] as string | undefined) ?? bearer(req) ?? query.token ?? null;
      if (!verifyIngestToken(ctx, presented)) {
        reply.code(401);
        return { error: "Invalid ingest token" };
      }
      const body = req.body;
      const input = typeof body === "string" ? { raw: body } : inboundSchema.parse(body ?? {});
      const result = await ingestInbound(ctx, input);
      reply.code(result.duplicate ? 200 : 201);
      return { ok: true, duplicate: result.duplicate, thread_id: result.thread.id, message_id: result.message.id };
    }
  );

  // ---- Public: app send API (mailbox token) ---------------------------------
  ctx.app.post(
    "/emailer/api/send",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const mailbox = mailboxForToken(ctx, bearer(req) ?? "");
      if (!mailbox) {
        reply.code(401);
        return { error: "Invalid mailbox token" };
      }
      const body = sendSchema.omit({ mailboxId: true, from: true }).extend({ threadId: z.string().optional() }).parse(req.body ?? {});
      if (body.threadId) {
        const { thread } = getThread(ctx, body.threadId);
        if (thread.mailbox_id !== mailbox.id) {
          reply.code(403);
          return { error: "That conversation belongs to another mailbox" };
        }
      }
      const res = await sendEmailerMessage(ctx, {
        mailboxId: mailbox.id,
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        text: body.text,
        html: body.html,
        threadId: body.threadId ?? null,
        source: "api",
        actor: `mailbox:${mailbox.address}`
      });
      return { ok: true, thread_id: res.thread.id, message_id: res.message.message_id };
    }
  );

  // ---- Dashboard ---------------------------------------------------------------
  ctx.app.get("/emailer/overview", async (req) => {
    const smtp = readSmtpConfig(ctx);
    const base = emailerBaseUrl(ctx, requestOrigin(req));
    return {
      smtp: { configured: smtpConfigured(ctx), from: smtp?.from ?? null, fromName: smtp?.fromName ?? null },
      publicUrl: getEmailerPublicUrl(ctx),
      ingestUrl: `${base}/emailer/inbound`,
      apiUrl: `${base}/emailer/api`,
      cloudflare: {
        connected: Boolean(
          (getSecretSetting(ctx, "email_routing_token") || getSecretSetting(ctx, "cloudflare_api_token")) &&
            getSecretSetting(ctx, "cloudflare_account_id")
        ),
        worker: workerName(ctx)
      },
      summary: emailerSummary(ctx),
      stats: emailerStats(ctx)
    };
  });

  ctx.app.get("/emailer/summary", async () => emailerSummary(ctx));

  ctx.app.get("/emailer/services/:serviceId/stats", async (req) => {
    const { serviceId } = req.params as { serviceId: string };
    return emailerStats(ctx, serviceId);
  });

  ctx.app.put("/emailer/settings", async (req) => {
    const { publicUrl } = z.object({ publicUrl: z.string().max(500) }).parse(req.body ?? {});
    return { publicUrl: setEmailerPublicUrl(ctx, publicUrl) };
  });

  ctx.app.get("/emailer/ingest", async (req) => {
    const base = emailerBaseUrl(ctx, requestOrigin(req));
    const ingestUrl = `${base}/emailer/inbound`;
    const token = getIngestToken(ctx);
    return {
      url: ingestUrl,
      token,
      workerScript: cloudflareWorkerScript({ ingestUrl, token }),
      curlExample:
        `curl -X POST ${ingestUrl} \\\n` +
        `  -H 'content-type: application/json' -H 'x-emailer-token: ${token}' \\\n` +
        `  -d '{"from":"Jane <jane@example.com>","to":"support@yourdomain.com","subject":"Hello","text":"Hi there"}'`
    };
  });

  // Dashboard-only (session auth — only the exact /emailer/inbound path is
  // public): inject a message as if a relay delivered it, to check mailbox →
  // service routing and n8n/forward fan-out before DNS is pointed anywhere.
  ctx.app.post("/emailer/inbound/simulate", async (req) => {
    const body = z
      .object({
        to: z.string().min(3),
        from: z.string().min(3).default("Test Sender <test.sender@example.com>"),
        subject: z.string().default("Test message from LocalSURV"),
        text: z.string().default("Hello! This message was simulated from the Emailer setup page.")
      })
      .parse(req.body ?? {});
    const res = await ingestInbound(ctx, {
      from: body.from,
      to: body.to,
      envelope: { to: body.to },
      subject: body.subject,
      text: body.text
    });
    return { ok: true, thread_id: res.thread.id, service_id: res.thread.service_id, mailbox: res.thread.mailbox_address };
  });

  ctx.app.post("/emailer/ingest/rotate", async (req) => {
    rotateIngestToken(ctx, actorOf(req));
    return { ok: true };
  });

  ctx.app.post("/emailer/cloudflare/worker", async (req) => {
    const { fallbackForward } = z
      .object({ fallbackForward: z.string().optional().nullable() })
      .parse(req.body ?? {});
    return deployCloudflareWorker(ctx, {
      requestHost: requestOrigin(req),
      fallbackForward,
      actor: actorOf(req)
    });
  });

  ctx.app.get("/emailer/mailboxes", async (req) => {
    const { serviceId } = (req.query ?? {}) as { serviceId?: string };
    return listMailboxes(ctx, serviceId ?? null);
  });

  ctx.app.post("/emailer/mailboxes", async (req) => {
    const body = mailboxSchema.parse(req.body ?? {});
    return createMailbox(ctx, body, actorOf(req));
  });

  ctx.app.patch("/emailer/mailboxes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = mailboxSchema.partial().parse(req.body ?? {});
    return updateMailbox(ctx, id, body, actorOf(req));
  });

  ctx.app.delete("/emailer/mailboxes/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteMailbox(ctx, id, actorOf(req));
    return { ok: true };
  });

  ctx.app.post("/emailer/mailboxes/:id/token", async (req) => {
    const { id } = req.params as { id: string };
    return mintMailboxToken(ctx, id, actorOf(req));
  });

  ctx.app.delete("/emailer/mailboxes/:id/token", async (req) => {
    const { id } = req.params as { id: string };
    return revokeMailboxToken(ctx, id);
  });

  ctx.app.post("/emailer/mailboxes/:id/inject-env", async (req) => {
    const { id } = req.params as { id: string };
    const res = injectMailboxEnv(ctx, id, { requestHost: requestOrigin(req), actor: actorOf(req) });
    return {
      ok: true,
      ...res,
      message: "EMAILER_API_URL, EMAILER_API_TOKEN and EMAILER_FROM written to the service — restart it to apply."
    };
  });

  ctx.app.post("/emailer/mailboxes/:id/cloudflare-route", async (req) => {
    const { id } = req.params as { id: string };
    return routeMailboxToWorker(ctx, id, actorOf(req));
  });

  ctx.app.get("/emailer/threads", async (req) => {
    const q = threadQuerySchema.parse(req.query ?? {});
    return listThreads(ctx, q);
  });

  ctx.app.get("/emailer/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { peek } = (req.query ?? {}) as { peek?: string };
    return getThread(ctx, id, { markRead: peek !== "1" });
  });

  ctx.app.patch("/emailer/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        status: z.enum(["open", "archived", "spam"]).optional(),
        starred: z.boolean().optional(),
        read: z.boolean().optional()
      })
      .parse(req.body ?? {});
    return updateThread(ctx, id, body);
  });

  ctx.app.delete("/emailer/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteThread(ctx, id, actorOf(req));
    return { ok: true };
  });

  ctx.app.post("/emailer/threads/:id/reply", async (req) => {
    const { id } = req.params as { id: string };
    const body = replySchema.parse(req.body ?? {});
    const { thread } = getThread(ctx, id);
    return sendEmailerMessage(ctx, {
      threadId: id,
      to: [thread.counterparty],
      cc: body.cc,
      subject: "",
      text: body.text,
      html: body.html,
      source: "dashboard",
      actor: actorOf(req)
    });
  });

  ctx.app.post("/emailer/send", async (req) => {
    const body = sendSchema.parse(req.body ?? {});
    return sendEmailerMessage(ctx, { ...body, source: "dashboard", actor: actorOf(req) });
  });

  ctx.app.post("/emailer/messages/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    return retryMessage(ctx, id, actorOf(req));
  });
}
