import crypto from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { deployFromGit, applyPostDeployServiceState, stopServiceIfRunning } from "../services/deploy.js";

const githubPushPayloadSchema = z
  .object({
    ref: z.string(),
    repository: z
      .object({
        clone_url: z.string().optional(),
        html_url: z.string().optional(),
        url: z.string().optional()
      })
      .passthrough()
  })
  .passthrough();

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
          return reply.code(401).send({ error: "Invalid webhook signature" });
        }
      }

      const parseResult = githubPushPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({ error: "Invalid GitHub payload" });
      }

      const { ref, repository } = parseResult.data;

      // ref is typically "refs/heads/main" or "refs/heads/branch-name"
      const branchParts = ref.split("/");
      const pushedBranch = branchParts[branchParts.length - 1];

      // GitHub provides multiple url formats. We'll try to match any of them.
      const urlsToMatch = [repository.clone_url, repository.html_url, repository.url].filter(
        Boolean
      ) as string[];

      if (urlsToMatch.length === 0 || !pushedBranch) {
        return reply.code(400).send({ error: "Missing repository URLs or branch in payload" });
      }

      // Find services that match this repo and branch.
      // SQLite doesn't have an easy array IN parameter binding for variable length without mapping.
      // So we just select all services that have a github_repo_url and github_branch,
      // and filter them in memory, since the list won't typically be massive.
      const allGithubServices = ctx.db
        .prepare("SELECT id, github_repo_url, github_branch FROM services WHERE github_repo_url IS NOT NULL")
        .all() as Array<{
        id: string;
        github_repo_url: string;
        github_branch: string | null;
      }>;

      const matchedServices = allGithubServices.filter((s) => {
        // Normalize URLs: remove trailing .git
        const serviceUrlNorm = s.github_repo_url.replace(/\.git$/, "").toLowerCase();
        const matchUrl = urlsToMatch.some(
          (url) => url.replace(/\.git$/, "").toLowerCase() === serviceUrlNorm
        );
        const matchBranch = (s.github_branch || "main") === pushedBranch;
        return matchUrl && matchBranch;
      });

      if (matchedServices.length === 0) {
        return { ok: true, message: "No matching services found to deploy", matched: 0 };
      }

      // Trigger deployments asynchronously so we can return 200 OK immediately to GitHub
      Promise.allSettled(
        matchedServices.map(async (service) => {
          try {
            await stopServiceIfRunning(ctx, service.id);
            const deployment = await deployFromGit(
              ctx,
              service.id,
              service.github_repo_url,
              service.github_branch || "main",
              "webhook"
            );
            // startAfterDeploy: true to be "similar to railway" - always restarts on new pulls
            await applyPostDeployServiceState(ctx, service.id, deployment, { startAfterDeploy: true });
          } catch (error) {
            ctx.app.log.error(error, `Failed to deploy service ${service.id} via github webhook`);
          }
        })
      );

      return { ok: true, message: "Deployments triggered", matched: matchedServices.length };
    }
  );
}
