import crypto from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { deployFromGit, applyPostDeployServiceState } from "../services/deploy.js";
import type { FastifyReply } from "fastify";
import { handleBranchPush, handleIncomingCommit, handlePullRequest } from "../services/ci.js";
import { branchFromRef, isForkPullRequest } from "../services/ciTriggers.js";
import { isCommitSha } from "../services/ciConfig.js";
import { parseRepoFullName } from "../services/github.js";
import { writeAuditLog } from "../services/audit.js";

const repositorySchema = z
  .object({
    clone_url: z.string().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    full_name: z.string().optional()
  })
  .passthrough();

const githubPushPayloadSchema = z
  .object({
    ref: z.string(),
    deleted: z.boolean().optional(),
    after: z.string().optional(),
    repository: repositorySchema
  })
  .passthrough();

const githubPullRequestPayloadSchema = z
  .object({
    action: z.string(),
    number: z.number().int().positive(),
    pull_request: z
      .object({
        head: z
          .object({
            sha: z.string(),
            ref: z.string(),
            repo: z.object({ full_name: z.string().optional() }).passthrough().nullable().optional()
          })
          .passthrough(),
        base: z
          .object({
            ref: z.string(),
            repo: z.object({ full_name: z.string().optional() }).passthrough().nullable().optional()
          })
          .passthrough()
      })
      .passthrough(),
    repository: repositorySchema
  })
  .passthrough();

const UNSIGNED_REFUSAL =
  "SURVHUB_WEBHOOK_INSECURE=1 accepts unsigned webhooks, so pull request and branch CI are refused. Set SURVHUB_WEBHOOK_SECRET and turn insecure mode off.";

type RepoService = {
  id: string;
  github_repo_url: string;
  github_branch: string | null;
  github_auto_pull: number | null;
};

/** Services whose repo matches the payload's repository, or null when it names none. */
function findRepoServices(
  ctx: AppContext,
  repository: z.infer<typeof repositorySchema>
): RepoService[] | null {
  // GitHub provides multiple url formats. We'll try to match any of them.
  const urlsToMatch = [repository.clone_url, repository.html_url, repository.url].filter(Boolean) as string[];
  const repoFullName = repository.full_name?.toLowerCase() ?? null;
  if (urlsToMatch.length === 0 && !repoFullName) return null;
  const all = ctx.db
    .prepare(
      "SELECT id, github_repo_url, github_branch, github_auto_pull FROM services WHERE github_repo_url IS NOT NULL"
    )
    .all() as RepoService[];
  return all.filter((s) => {
    const serviceUrlNorm = s.github_repo_url.replace(/\.git$/, "").toLowerCase();
    const serviceFullName = parseRepoFullName(s.github_repo_url)?.toLowerCase() ?? null;
    const matchUrl = urlsToMatch.some((url) => url.replace(/\.git$/, "").toLowerCase() === serviceUrlNorm);
    return matchUrl || Boolean(repoFullName && serviceFullName === repoFullName);
  });
}

function handlePullRequestDelivery(ctx: AppContext, payload: unknown, reply: FastifyReply) {
  const parsed = githubPullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid GitHub pull_request payload" });
  const { action, number, pull_request: pr, repository } = parsed.data;
  const services = findRepoServices(ctx, repository);
  if (!services) return reply.code(400).send({ error: "Missing repository in payload" });
  if (ctx.config.webhookInsecure) {
    if (services.length) ctx.app.log.warn(`CI: refusing pull request #${number}: ${UNSIGNED_REFUSAL}`);
    return { ok: true, message: UNSIGNED_REFUSAL, matched: 0, ci: [] };
  }
  const isFork = isForkPullRequest(pr.head.repo?.full_name, pr.base.repo?.full_name ?? repository.full_name);
  const ci: Array<{ serviceId: string; queued: boolean; reason?: string }> = [];
  for (const service of services) {
    try {
      const outcome = handlePullRequest(ctx, {
        serviceId: service.id,
        action,
        number,
        headSha: pr.head.sha,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        isFork
      });
      if (outcome.queued) ci.push({ serviceId: service.id, queued: true });
      else {
        ci.push({ serviceId: service.id, queued: false, reason: outcome.reason });
        if (isFork) ctx.app.log.info(`CI: pull request #${number} skipped: ${outcome.reason}`);
      }
    } catch (error) {
      ctx.app.log.error(error, `CI: failed to queue pull request #${number} for service ${service.id}`);
    }
  }
  return {
    ok: true,
    message: ci.some((entry) => entry.queued) ? "CI runs queued" : "No CI runs queued",
    matched: 0,
    ci
  };
}

/**
 * Replay protection: keep a bounded LRU of `(deliveryId, timestamp)` pairs
 * and reject anything we've seen before. The map is intentionally
 * process-local — webhooks should be processed by the leader instance and
 * GitHub already deduplicates on the sender side.
 */
const seenDeliveries = new Map<string, number>();
const REPLAY_CACHE_LIMIT = 1024;

function rememberDelivery(id: string): boolean {
  if (seenDeliveries.has(id)) return false;
  seenDeliveries.set(id, Date.now());
  if (seenDeliveries.size > REPLAY_CACHE_LIMIT) {
    // Drop the oldest entry; Map preserves insertion order.
    const oldest = seenDeliveries.keys().next().value;
    if (oldest !== undefined) seenDeliveries.delete(oldest);
  }
  return true;
}

function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reject webhooks whose signed timestamp is outside the configured skew
 * window. GitHub does not currently sign timestamps directly, so we accept
 * either an explicit `X-Hub-Timestamp` header (set by some proxies) or fall
 * back to the `X-GitHub-Delivery` header's millisecond prefix when present.
 * Returning `null` means "no usable timestamp, do not enforce skew here";
 * the HMAC alone still has to verify.
 */
function timestampSkewSeconds(headers: Record<string, string | string[] | undefined>): number | null {
  const headerVal = (k: string): string | undefined => {
    const raw = headers[k];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const explicit = headerVal("x-hub-timestamp") ?? headerVal("x-survhub-timestamp");
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Accept seconds or milliseconds.
      const ms = parsed > 10_000_000_000 ? parsed : parsed * 1000;
      return Math.abs((Date.now() - ms) / 1000);
    }
  }
  return null;
}

export function registerWebhookRoutes(ctx: AppContext): void {
  ctx.app.post(
    "/webhooks/github",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (req, reply) => {
      // Verify HMAC against the raw request body. GitHub sends X-Hub-Signature-256.
      if (!ctx.config.webhookInsecure) {
        if (!ctx.config.webhookSecret) {
          return reply.code(503).send({
            error: "Webhook secret not configured",
            hint: "Set SURVHUB_WEBHOOK_SECRET to the value configured in your GitHub webhook, or set SURVHUB_WEBHOOK_INSECURE=1 to disable verification (not recommended)."
          });
        }
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
        const signature = req.headers["x-hub-signature-256"];
        const sigHeader = Array.isArray(signature) ? signature[0] : signature;
        if (!rawBody || !verifyGithubSignature(rawBody, sigHeader, ctx.config.webhookSecret)) {
          writeAuditLog(ctx, {
            actor: "webhook:github",
            action: "POST /webhooks/github",
            resourceType: "webhook",
            statusCode: 401,
            details: "signature_mismatch",
            sourceIp: req.ip ?? null,
            userAgent: (req.headers["user-agent"] as string | undefined) ?? null
          });
          return reply.code(401).send({ error: "Invalid webhook signature" });
        }

        // Replay protection: reject duplicate X-GitHub-Delivery IDs.
        const deliveryRaw = req.headers["x-github-delivery"];
        const deliveryId = Array.isArray(deliveryRaw) ? deliveryRaw[0] : deliveryRaw;
        if (deliveryId) {
          if (!rememberDelivery(deliveryId)) {
            writeAuditLog(ctx, {
              actor: "webhook:github",
              action: "POST /webhooks/github",
              resourceType: "webhook",
              statusCode: 409,
              details: `replay:${deliveryId}`,
              sourceIp: req.ip ?? null,
              userAgent: (req.headers["user-agent"] as string | undefined) ?? null
            });
            return reply.code(409).send({ error: "Replayed webhook delivery" });
          }
        }

        // Optional skew window enforcement when a timestamp is present.
        const skew = timestampSkewSeconds(req.headers as Record<string, string | string[] | undefined>);
        if (skew !== null && skew > ctx.config.webhookMaxSkewSeconds) {
          writeAuditLog(ctx, {
            actor: "webhook:github",
            action: "POST /webhooks/github",
            resourceType: "webhook",
            statusCode: 401,
            details: `stale_timestamp:${skew.toFixed(1)}s`,
            sourceIp: req.ip ?? null,
            userAgent: (req.headers["user-agent"] as string | undefined) ?? null
          });
          return reply.code(401).send({ error: "Webhook timestamp outside skew window" });
        }
      }

      const eventRaw = req.headers["x-github-event"];
      // Older setups and tests send no event header; those are pushes.
      const event = (Array.isArray(eventRaw) ? eventRaw[0] : eventRaw) || "push";
      if (event === "ping") return { ok: true, message: "pong" };
      if (event === "pull_request") return handlePullRequestDelivery(ctx, req.body, reply);
      if (event !== "push") return { ok: true, message: `Event ${event} ignored`, matched: 0 };

      const parseResult = githubPushPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({ error: "Invalid GitHub payload" });
      }

      const { ref, repository, deleted, after } = parseResult.data;
      if (deleted) {
        return { ok: true, message: "Branch deletion ignored", matched: 0, skippedDeleted: true };
      }

      // Compare the full ref: "refs/heads/feature/x" is branch "feature/x", and
      // tags (refs/tags/...) are never branches.
      const pushedBranch = branchFromRef(ref);
      if (!pushedBranch) {
        return { ok: true, message: "Not a branch push; ignored", matched: 0 };
      }

      const repoServices = findRepoServices(ctx, repository);
      if (!repoServices) {
        return reply.code(400).send({ error: "Missing repository URLs or branch in payload" });
      }

      let skippedAutoPull = 0;
      const matchedServices = repoServices.filter((s) => {
        const matches = (s.github_branch || "main") === pushedBranch;
        if (matches && s.github_auto_pull === 0) {
          skippedAutoPull += 1;
          return false;
        }
        return matches;
      });

      // Pushes to other branches: CI only (never deploy), and only when the
      // delivery is signed — otherwise anyone could make this host run jobs.
      const commit = isCommitSha(after) && !/^0+$/.test(after) ? after : "";
      const ciOnly = repoServices.filter((s) => (s.github_branch || "main") !== pushedBranch);
      const ci: Array<{ serviceId: string; queued: boolean; reason?: string }> = [];
      for (const service of ciOnly) {
        if (!commit) continue;
        if (ctx.config.webhookInsecure) {
          ctx.app.log.warn(
            `CI: refusing branch run for ${pushedBranch} on service ${service.id}: ${UNSIGNED_REFUSAL}`
          );
          ci.push({ serviceId: service.id, queued: false, reason: UNSIGNED_REFUSAL });
          continue;
        }
        try {
          const outcome = handleBranchPush(ctx, { serviceId: service.id, branch: pushedBranch, commit });
          ci.push(
            outcome.queued
              ? { serviceId: service.id, queued: true }
              : { serviceId: service.id, queued: false, reason: outcome.reason }
          );
        } catch (error) {
          ctx.app.log.error(error, `CI: failed to queue branch run for service ${service.id}`);
        }
      }
      const ciQueued = ci.filter((entry) => entry.queued).length;

      if (matchedServices.length === 0) {
        return {
          ok: true,
          message: ciQueued ? "CI runs queued" : "No matching services found to deploy",
          matched: 0,
          skippedAutoPull,
          ci
        };
      }

      // Trigger deployments asynchronously so we can return 200 OK immediately to GitHub
      Promise.allSettled(
        matchedServices.map(async (service) => {
          try {
            const branch = service.github_branch || "main";
            const plan = handleIncomingCommit(ctx, {
              serviceId: service.id,
              repoUrl: service.github_repo_url,
              branch,
              commit,
              trigger: "webhook"
            });
            if (plan === "ci-then-deploy") return;
            const deployment = await deployFromGit(
              ctx,
              service.id,
              service.github_repo_url,
              branch,
              "webhook"
            );
            // startAfterDeploy: true to be "similar to railway" - always restarts on new pulls
            await applyPostDeployServiceState(ctx, service.id, deployment, { startAfterDeploy: true });
          } catch (error) {
            ctx.app.log.error(error, `Failed to deploy service ${service.id} via github webhook`);
          }
        })
      );

      return {
        ok: true,
        message: "Deployments triggered",
        matched: matchedServices.length,
        skippedAutoPull,
        ci
      };
    }
  );
}
