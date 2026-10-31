// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { ComponentType } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const store = new Map<string, string>([["survhub_token", "test"]]);
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
} as Storage;

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const SUMMARY = {
  range: "7d",
  from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  bucket: "day",
  totals: {
    requests: 40,
    errors: 2,
    input_tokens: 44_000,
    output_tokens: 5_400,
    cache_read_tokens: 11_000,
    cache_write_tokens: 0,
    cost_micro_usd: 152_000,
    unpriced_requests: 3,
    avg_cost_micro_usd: 3_800,
    error_rate: 0.05,
    cache_hit_rate: 0.2,
    p50_ms: 2600,
    p95_ms: 3900
  },
  by_service: [
    { service_id: "svc-coach", app_name: "Coach", requests: 30, errors: 2, input_tokens: 33_000, output_tokens: 4_000, cache_read_tokens: 0, cost_micro_usd: 140_000, unpriced_requests: 0, avg_duration_ms: 2700, last_at: now },
    { service_id: "svc-web", app_name: "Web", requests: 10, errors: 0, input_tokens: 11_000, output_tokens: 1_400, cache_read_tokens: 11_000, cost_micro_usd: 12_000, unpriced_requests: 3, avg_duration_ms: 900, last_at: now }
  ],
  by_model: [
    { provider: "anthropic", model: "claude-sonnet-5-5", requests: 30, errors: 2, input_tokens: 33_000, output_tokens: 4_000, cost_micro_usd: 140_000, unpriced_requests: 0 },
    { provider: "openai", model: "gpt-5-mini", requests: 10, errors: 0, input_tokens: 11_000, output_tokens: 1_400, cost_micro_usd: 0, unpriced_requests: 10 }
  ],
  series: [
    { bucket: today, service_id: "svc-coach", app_name: "Coach", requests: 30, cost_micro_usd: 140_000 },
    { bucket: today, service_id: "svc-web", app_name: "Web", requests: 10, cost_micro_usd: 12_000 }
  ],
  error_codes: [{ error_code: "provider_unavailable", n: 2 }],
  gateway: { requests: 5, errors: 0, prompt_tokens: 900, completion_tokens: 300 },
  spend: { today_micro_usd: 152_000, month_micro_usd: 152_000, per_service_today: { "svc-coach": 140_000 }, per_service_month: { "svc-coach": 140_000 } },
  budgets: { global_daily_usd: 1, per_service: { "svc-coach": { daily_usd: 0.2, monthly_usd: null } } }
};

const ROUTES: Record<string, unknown> = {
  "/api/ai-usage/summary": SUMMARY,
  "/api/ai-usage/events": {
    events: [
      { id: "e1", service_id: "svc-coach", app_name: "Coach", provider: "anthropic", model: "claude-sonnet-5-5", feature: null, input_tokens: 1100, output_tokens: 140, cache_read_tokens: 0, cache_write_tokens: 0, cost_micro_usd: 3600, cost_source: "computed", status: "ok", error_code: null, duration_ms: 2600, created_at: now },
      { id: "e2", service_id: "svc-web", app_name: "Web", provider: "openai", model: "gpt-5-mini", feature: null, input_tokens: 800, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_micro_usd: null, cost_source: "unpriced", status: "error", error_code: "rate_limited", duration_ms: 0, created_at: now }
    ]
  },
  "/api/ai-usage/apps": {
    apps: [
      { service_id: "svc-coach", name: "Coach", type: "docker", connected: true, token_prefix: "sau_abcd", connected_at: now, last_used_at: now, total_events: 30 },
      { service_id: "svc-web", name: "Web", type: "process", connected: false, token_prefix: null, connected_at: null, last_used_at: null, total_events: 10 }
    ]
  },
  "/api/ai-usage/prices": {
    models: [
      { model: "claude-sonnet-5-5", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, custom: false, priced: true },
      { model: "gpt-5-mini", price: null, custom: false, priced: false }
    ]
  }
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://localhost");
  const body = ROUTES[url.pathname] ?? {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}) as typeof fetch;

let AiUsagePage: ComponentType;

describe("AI Usage page", () => {
  beforeAll(async () => {
    AiUsagePage = (await import("./pages/AiUsage")).AiUsagePage;
  });
  afterEach(() => cleanup());

  it("shows spend, per-app and per-model tables, the unpriced warning and connection state", async () => {
    render(
      <MemoryRouter initialEntries={["/ai-usage"]}>
        <Routes>
          <Route path="/ai-usage" element={<AiUsagePage />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByText("Coach").length).toBeGreaterThan(1));
    // Spend KPI: 152000 micro-USD
    expect(screen.getAllByText("$0.152").length).toBeGreaterThan(0);
    // Unpriced models are called out, not silently counted as free.
    expect(screen.getByText(/3 requests have no price/)).toBeTruthy();
    expect(screen.getAllByText("no price").length).toBeGreaterThan(0);
    // Error breakdown and gateway traffic.
    expect(screen.getByText(/provider_unavailable ×2/)).toBeTruthy();
    expect(screen.getByText(/5 requests through the gateway/)).toBeTruthy();
    // Connection state: one connected app can be disconnected, the other connected.
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect$/ })).toBeTruthy();
    // The chart has a text alternative.
    expect(screen.getByRole("img", { name: /Spend per day/ })).toBeTruthy();
  });
});
