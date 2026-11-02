import { api, type ApiOptions } from "./api";

/** AI API usage reported by hosted apps (see services/aiUsage.ts on the server). */

export type RangeKey = "24h" | "7d" | "30d" | "month";

export type UsageTotals = {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro_usd: number;
  unpriced_requests: number;
  avg_cost_micro_usd: number;
  error_rate: number;
  cache_hit_rate: number;
  p50_ms: number | null;
  p95_ms: number | null;
};

export type ByService = {
  service_id: string;
  app_name: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_micro_usd: number;
  unpriced_requests: number;
  avg_duration_ms: number;
  last_at: string | null;
};

export type ByModel = {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  unpriced_requests: number;
};

export type SeriesPoint = {
  bucket: string;
  service_id: string;
  app_name: string;
  requests: number;
  cost_micro_usd: number;
};

export type Budgets = {
  global_daily_usd: number | null;
  per_service: Record<string, { daily_usd: number | null; monthly_usd: number | null }>;
};

export type UsageSummary = {
  range: RangeKey;
  from: string;
  bucket: "hour" | "day";
  totals: UsageTotals;
  by_service: ByService[];
  by_model: ByModel[];
  series: SeriesPoint[];
  error_codes: Array<{ error_code: string; n: number }>;
  gateway: { requests: number; errors: number; prompt_tokens: number; completion_tokens: number } | null;
  spend: {
    today_micro_usd: number;
    month_micro_usd: number;
    per_service_today: Record<string, number>;
    per_service_month: Record<string, number>;
  };
  budgets: Budgets;
};

export type UsageEvent = {
  id: string;
  service_id: string;
  app_name: string;
  provider: string;
  model: string;
  feature: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro_usd: number | null;
  cost_source: "reported" | "computed" | "unpriced";
  status: "ok" | "error";
  error_code: string | null;
  duration_ms: number;
  created_at: string;
};

export type UsageApp = {
  service_id: string;
  name: string;
  type: string;
  connected: boolean;
  token_prefix: string | null;
  connected_at: string | null;
  last_used_at: string | null;
  total_events: number;
};

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ModelPrice = { model: string; price: Price | null; custom: boolean; priced: boolean };

export const getSummary = (range: RangeKey, service?: string, opts?: ApiOptions) =>
  api<UsageSummary>(
    `/api/ai-usage/summary?range=${range}${service ? `&service=${encodeURIComponent(service)}` : ""}`,
    opts
  );

export const getEvents = (limit = 30, service?: string, opts?: ApiOptions) =>
  api<{ events: UsageEvent[] }>(
    `/api/ai-usage/events?limit=${limit}${service ? `&service=${encodeURIComponent(service)}` : ""}`,
    opts
  );

export const getApps = (opts?: ApiOptions) => api<{ apps: UsageApp[] }>("/api/ai-usage/apps", opts);

export const getPrices = (opts?: ApiOptions) => api<{ models: ModelPrice[] }>("/api/ai-usage/prices", opts);

export const connectApp = (serviceId: string) =>
  api<{ ok: boolean; token_prefix: string; restart_required: boolean }>(
    `/api/ai-usage/connect/${encodeURIComponent(serviceId)}`,
    {
      method: "POST"
    }
  );

export const disconnectApp = (serviceId: string) =>
  api<{ ok: boolean }>(`/api/ai-usage/connect/${encodeURIComponent(serviceId)}`, { method: "DELETE" });

export const saveBudgets = (budgets: Budgets) =>
  api<Budgets>("/api/ai-usage/budgets", { method: "PUT", body: JSON.stringify(budgets) });

export const savePrices = (overrides: Record<string, Price>) =>
  api<{ models: ModelPrice[] }>("/api/ai-usage/prices", {
    method: "PUT",
    body: JSON.stringify({ overrides })
  });

/** micro-USD -> "$0.0036" / "$12.40". Small amounts keep precision so a cheap app is not shown as free. */
export function formatUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
