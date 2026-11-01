/**
 * Stripe tools for the OPERATOR MCP endpoint (POST /mcp).
 *
 * That endpoint already requires an operator credential (dashboard session,
 * durable API token or SURVHUB_AUTH_TOKEN) and exposes start/stop/redeploy, so
 * these tools sit behind the same trust boundary. They are deliberately NOT
 * registered on the per-service agent endpoint (/mcp/:tokenId), whose sessions
 * are scoped to one service and must never touch payment credentials.
 *
 * There is no tool that accepts a key: keys (account keys and the organization
 * master key) are entered on the dashboard only, so key material can never pass
 * through an agent's context. No tool returns one either. Writes to live Stripe
 * need `confirmLive: true`. Every setup/verify result says which credential it
 * used (`credential_path`: org-key | account-key); the organization key itself
 * is never given to an app.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../types.js";
import {
  StripeError,
  connectApp,
  disconnectApp,
  ensurePortal,
  ensureProductPrice,
  ensureWebhook,
  getStatus,
  listApps,
  setAppAccount,
  verifyKeys,
  verifyOrgKey,
  type StripeDeps
} from "../services/stripe.js";

const mode = z.enum(["test", "live"]).default("test").describe("Stripe mode. Defaults to test.");
const confirmLive = z.boolean().optional().describe("Must be true for any write that touches LIVE Stripe or injects live keys.");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function resolveServiceId(ctx: AppContext, service: string): string {
  const row = ctx.db.prepare("SELECT id FROM services WHERE id = ? OR name = ? LIMIT 1").get(service, service) as { id: string } | undefined;
  if (!row) throw new StripeError(404, "service_not_found", `No service matches "${service}"`);
  return row.id;
}

export function registerStripeMcpTools(ctx: AppContext, server: McpServer, actor: string, deps: StripeDeps = {}): void {
  const who = `mcp:${actor}`;

  server.registerTool("stripe_status", {
    title: "Stripe status",
    description:
      "Show which Stripe keys are stored for test and live mode (masked preview and fingerprint only, never the key), including the organization master key and whether it was verified, the last verified account state, the API version used for org-key calls, the permissions the org key needs, and what setup has been done. Keys are added on the dashboard Stripe page, not through MCP.",
    inputSchema: {}
  }, async () => json(getStatus(ctx)));

  server.registerTool("stripe_verify", {
    title: "Verify Stripe key",
    description:
      "Call Stripe with the stored secret key for a mode and return the account name, country, currency and whether charges, payouts and details_submitted are enabled. Merchant verification, payout details and tax registration must be completed by the owner in Stripe.",
    inputSchema: { mode }
  }, async ({ mode: m }) => json({ ok: true, credential_path: "account-key", account: await verifyKeys(ctx, who, m, deps) }));

  server.registerTool("stripe_verify_org", {
    title: "Verify the Stripe organization key",
    description:
      "Check the organization master key stored for a mode against ONE member account (Stripe-Context) and return that account's name and whether charges, payouts and details_submitted are enabled. Pass the app's service (its account id must be set) or an explicit accountId (acct_...). A successful check also confirms which Stripe mode the key belongs to, which org-key writes require. A 401 means the key is invalid; a permission error means the key is valid but restricted too tightly (it needs Account read) or the account is not in its organization.",
    inputSchema: {
      mode,
      service: z.string().optional().describe("Service ID or exact name with a Stripe account set"),
      accountId: z.string().optional().describe("Member account id, for example acct_1AbC...")
    }
  }, async ({ mode: m, service, accountId }) =>
    json(await verifyOrgKey(ctx, who, m, { serviceId: service ? resolveServiceId(ctx, service) : undefined, accountId }, deps)));

  server.registerTool("stripe_list_apps", {
    title: "List apps and Stripe connection",
    description:
      "List every service with whether Stripe is connected, in which mode, its Stripe account id, which credential setup will use (credential_path: org-key | account-key), the last org verification, whether a webhook signing secret is injected and where it comes from (app | mode, never the value), and whether it needs a restart to pick up changed keys.",
    inputSchema: {}
  }, async () => json({ apps: listApps(ctx) }));

  server.registerTool("stripe_connect_app", {
    title: "Connect an app to Stripe",
    description:
      "Inject STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY (if stored), STRIPE_WEBHOOK_SECRET (if stored) and STRIPE_MODE into a service as encrypted system env. The service must be restarted afterwards. Fails with env_conflict if the service defines the same variables itself, unless takeover is true. Live mode needs confirmLive: true. Never changes BILLING_ENABLED or any other app flag.",
    inputSchema: {
      service: z.string().describe("Service ID or exact name"),
      mode,
      takeover: z.boolean().optional().describe("Replace variables the service defines itself"),
      confirmLive
    }
  }, async ({ service, mode: m, takeover, confirmLive: live }) =>
    json(connectApp(ctx, who, { serviceId: resolveServiceId(ctx, service), mode: m, takeover, confirmLive: live })));

  server.registerTool("stripe_set_app_account", {
    title: "Set an app's Stripe account",
    description:
      "Choose which member account (acct_...) of the Stripe organization an already-connected app belongs to. With an account id and an organization key stored for the app's mode, the setup tools run through the org key in that account's context; without either they use the account-level key as before. Changing the account drops the app's own webhook secret and verification. An empty accountId clears it. Restart the service afterwards if restart_needed is true. Accounts and API keys themselves can only be created in the Stripe Dashboard.",
    inputSchema: {
      service: z.string().describe("Service ID or exact name"),
      accountId: z.string().nullable().describe("acct_... or null to clear")
    }
  }, async ({ service, accountId }) => json(setAppAccount(ctx, who, resolveServiceId(ctx, service), accountId)));

  server.registerTool("stripe_disconnect_app", {
    title: "Disconnect an app from Stripe",
    description: "Remove the Stripe system env this feature injected into a service (and its account link and per-app webhook secret). Restart the service afterwards.",
    inputSchema: { service: z.string().describe("Service ID or exact name") }
  }, async ({ service }) => json(disconnectApp(ctx, who, resolveServiceId(ctx, service))));

  server.registerTool("stripe_ensure_product_price", {
    title: "Ensure a recurring product and price",
    description:
      "Idempotently create a product and a recurring price identified by lookupKey. If the price exists with different terms the call fails with price_conflict (Stripe prices are immutable). unitAmount is in the smallest currency unit (900 = 9.00). Optionally write the price id into a connected service as an env var (for example STRIPE_PRICE_ID). When that service has a Stripe account id and an organization key exists for the mode, the call runs through the org key in that account's context (the result says credential_path).",
    inputSchema: {
      mode,
      name: z.string().min(1).max(100),
      unitAmount: z.number().int().min(1),
      currency: z.string().length(3),
      interval: z.enum(["day", "week", "month", "year"]),
      taxBehavior: z.enum(["inclusive", "exclusive"]),
      lookupKey: z.string().describe("3-64 characters of a-z 0-9 _ . -"),
      service: z.string().optional().describe("Connected service to receive the price id"),
      priceEnvName: z.string().optional().describe("Env var name for the price id, e.g. STRIPE_PRICE_ID"),
      confirmLive
    }
  }, async ({ service, confirmLive: live, ...rest }) =>
    json(await ensureProductPrice(ctx, who, { ...rest, serviceId: service ? resolveServiceId(ctx, service) : undefined, confirmLive: live }, deps)));

  server.registerTool("stripe_ensure_webhook", {
    title: "Ensure a webhook endpoint",
    description:
      "Idempotently create (or update the event list of) a webhook endpoint at an https URL. On creation Stripe returns the signing secret once; it is stored encrypted and pushed to connected apps, and is never returned. Pass service to act in that app's Stripe account via the organization key: the secret is then stored for that app only and injected as its STRIPE_WEBHOOK_SECRET. Without it the account-level key is used and the secret is shared per mode. If the endpoint already existed and no secret is stored the result says secret_unavailable.",
    inputSchema: {
      mode,
      url: z.string().url().describe("Public https URL of the app's webhook route"),
      events: z.array(z.string()).optional().describe("Stripe event names; defaults to a subscription set"),
      service: z.string().optional().describe("Connected service with a Stripe account id (org-key path)"),
      confirmLive
    }
  }, async ({ service, confirmLive: live, ...rest }) =>
    json(await ensureWebhook(ctx, who, { ...rest, serviceId: service ? resolveServiceId(ctx, service) : undefined, confirmLive: live }, deps)));

  server.registerTool("stripe_ensure_portal", {
    title: "Ensure the customer portal configuration",
    description:
      "Idempotently create or update the ServerHoster-managed Customer Portal configuration: cancel at period end, payment-method update, invoice history. Pass service to act in that app's Stripe account via the organization key.",
    inputSchema: {
      mode,
      returnUrl: z.string().url().optional(),
      service: z.string().optional().describe("Connected service with a Stripe account id (org-key path)"),
      confirmLive
    }
  }, async ({ service, confirmLive: live, ...rest }) =>
    json(await ensurePortal(ctx, who, { ...rest, serviceId: service ? resolveServiceId(ctx, service) : undefined, confirmLive: live }, deps)));
}
