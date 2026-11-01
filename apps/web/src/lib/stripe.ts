import { api, type ApiOptions } from "./api";

/**
 * Stripe client. Note what is absent: no call ever returns a key. `saveKeys` is
 * the only call that sends one, and the server answers with masked previews.
 */

export type StripeMode = "test" | "live";
export type KeyPart = "secret_key" | "publishable_key" | "webhook_secret";

export type KeyInfo = { configured: boolean; preview: string | null; fingerprint: string | null };

export type AccountSummary = {
  id: string;
  name: string | null;
  country: string | null;
  default_currency: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  livemode: boolean;
  currently_due: string[];
  verified_at: string;
};

export type SetupRecord = {
  prices?: Record<string, { product: string; price: string; unit_amount: number; currency: string; interval: string; tax_behavior: string; at: string }>;
  webhook?: { id: string; url: string; events: string[]; at: string };
  portal?: { id: string; at: string };
};

export type ModeStatus = {
  secret_key: KeyInfo;
  publishable_key: KeyInfo;
  webhook_secret: KeyInfo;
  account: AccountSummary | null;
  setup: SetupRecord;
};

export type StripeStatus = {
  modes: Record<StripeMode, ModeStatus>;
  default_mode: "test";
  default_webhook_events: string[];
};

export type StripeApp = {
  service_id: string;
  name: string;
  type: string;
  status: string;
  connected: boolean;
  mode: StripeMode | null;
  connected_at: string | null;
  synced_at: string | null;
  restart_needed: boolean;
};

export type PriceResult = {
  ok: boolean;
  mode: StripeMode;
  created: boolean;
  product: { id: string; name: string };
  price: { id: string; lookup_key: string; unit_amount: number; currency: string; interval: string; tax_behavior: string };
  injected: { service_id: string; env: string } | null;
  restart_needed: boolean;
};

export type WebhookResult = {
  ok: boolean;
  mode: StripeMode;
  created: boolean;
  updated: boolean;
  endpoint: { id: string; url: string; events: string[]; status: string | null };
  secret_stored: boolean;
  secret_unavailable: boolean;
  note?: string;
  apps_updated: string[];
  restart_needed: boolean;
};

export type PortalResult = {
  ok: boolean;
  mode: StripeMode;
  created: boolean;
  portal: { id: string; cancel: string; payment_method_update: boolean; return_url: string | null };
};

export const getStatus = (opts?: ApiOptions) => api<StripeStatus>("/api/stripe/status", opts);

export const saveKeys = (mode: StripeMode, keys: { secretKey?: string; publishableKey?: string; webhookSecret?: string }) =>
  api<{ ok: boolean; apps_updated: string[]; restart_needed: boolean }>(`/api/stripe/keys/${mode}`, { method: "PUT", body: JSON.stringify(keys) });

export const removeKeys = (mode: StripeMode, part: KeyPart | "all") =>
  api<{ ok: boolean; apps_disconnected: string[]; apps_updated: string[]; restart_needed: boolean }>(
    `/api/stripe/keys/${mode}?part=${part}`,
    { method: "DELETE" }
  );

export const verifyKeys = (mode: StripeMode) =>
  api<{ ok: boolean; account: AccountSummary }>(`/api/stripe/verify/${mode}`, { method: "POST" });

export const getApps = (opts?: ApiOptions) => api<{ apps: StripeApp[] }>("/api/stripe/apps", opts);

export const connectApp = (serviceId: string, body: { mode: StripeMode; confirmLive?: boolean; takeover?: boolean }, opts?: ApiOptions) =>
  api<{ ok: boolean; env: string[]; replaced: string[]; restart_needed: boolean }>(`/api/stripe/apps/${encodeURIComponent(serviceId)}/connect`, {
    method: "POST",
    body: JSON.stringify(body),
    ...opts
  });

export const disconnectApp = (serviceId: string) =>
  api<{ ok: boolean }>(`/api/stripe/apps/${encodeURIComponent(serviceId)}`, { method: "DELETE" });

export const ensurePrice = (body: {
  mode: StripeMode;
  name: string;
  unitAmount: number;
  currency: string;
  interval: string;
  taxBehavior: string;
  lookupKey: string;
  serviceId?: string;
  priceEnvName?: string;
  confirmLive?: boolean;
}) => api<PriceResult>("/api/stripe/setup/product-price", { method: "POST", body: JSON.stringify(body) });

export const ensureWebhook = (body: { mode: StripeMode; url: string; events?: string[]; confirmLive?: boolean }) =>
  api<WebhookResult>("/api/stripe/setup/webhook", { method: "POST", body: JSON.stringify(body) });

export const ensurePortal = (body: { mode: StripeMode; returnUrl?: string; confirmLive?: boolean }) =>
  api<PortalResult>("/api/stripe/setup/portal", { method: "POST", body: JSON.stringify(body) });

/** Currencies Stripe counts in whole units (no cents). Everything else is x100. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

/** "9" / "9.00" / "9,5" in a currency -> smallest unit, or null if it is not a valid amount. */
export function toMinorUnits(amount: string, currency: string): number | null {
  const n = Number(amount.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const minor = Math.round(n * (ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
