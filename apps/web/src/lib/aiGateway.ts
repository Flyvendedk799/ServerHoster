import { api, type ApiOptions } from "./api";

/**
 * AI Gateway (SubGate) client.
 *
 * Note what is absent: there is no endpoint that returns a provider API key or
 * a consumer token after creation. `mintToken` is the only call that ever sees
 * a live token, and it returns it exactly once.
 */

export type ProviderId = "anthropic" | "openai";

export type ProviderStatus = {
  id: ProviderId;
  configured: boolean;
  /** Masked. Never the real key. */
  keyPreview: string | null;
  /** Stable non-reversible id — lets you confirm which key is installed. */
  fingerprint: string | null;
  baseUrl: string | null;
};

export type GatewayStatus = {
  enabled: boolean;
  running: boolean;
  /** True when the tab manages a standalone SubGate container, not in-process. */
  external?: boolean;
  external_url?: string;
  bound: { host: string; port: number };
  public_url: string;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  rate_limit_per_minute: number;
  max_concurrent: number;
  in_flight: number;
  debug_bodies_until: string | null;
  providers: ProviderStatus[];
  available_providers: ProviderId[];
  token_count: number;
};

export type ExternalConfig = { configured: boolean; url: string | null };

export type ConsumerToken = {
  id: string;
  name: string;
  preview: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  request_count: number;
  active: boolean;
};

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
};

export type ProvidersResponse = {
  providers: ProviderStatus[];
  available: ProviderId[];
  models: ModelInfo[];
};

export type UsageSummary = {
  totals: { requests: number; errors: number; prompt_tokens: number; completion_tokens: number };
  by_consumer: Array<{
    token_id: string | null;
    token_name: string | null;
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    last_used_at: string | null;
  }>;
  by_model: Array<{ model: string; provider: string; requests: number; total_tokens: number }>;
  recent: Array<{
    id: string;
    token_name: string | null;
    provider: string;
    model: string;
    wire: string;
    streamed: boolean;
    status_code: number;
    error_code: string | null;
    duration_ms: number;
    total_tokens: number;
    created_at: string;
  }>;
};

export type TestResult =
  | {
      ok: true;
      duration_ms: number;
      provider: ProviderId;
      model: string;
      translated: boolean;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      content: string;
      raw: unknown;
    }
  | { ok: false; duration_ms: number; model: string; error: string; code: string; status: number };

export type RefreshResult = {
  ok: boolean;
  provider: ProviderId;
  latency_ms: number;
  checked_at: string;
  error?: string;
  code?: string;
};

export function getGatewayStatus(opts?: ApiOptions): Promise<GatewayStatus> {
  return api<GatewayStatus>("/api/ai-gateway/status", opts);
}

export function enableGateway(): Promise<GatewayStatus> {
  return api<GatewayStatus>("/api/ai-gateway/enable", { method: "POST" });
}

export function disableGateway(): Promise<GatewayStatus> {
  return api<GatewayStatus>("/api/ai-gateway/disable", { method: "POST" });
}

export function updateGatewayConfig(body: {
  port?: number;
  publicUrl?: string;
  rateLimitPerMinute?: number;
  maxConcurrent?: number;
  debugBodiesMinutes?: number;
}): Promise<GatewayStatus> {
  return api<GatewayStatus>("/api/ai-gateway/config", {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export function getExternalConfig(opts?: ApiOptions): Promise<ExternalConfig> {
  return api<ExternalConfig>("/api/ai-gateway/external", opts);
}

export function connectExternal(url: string, adminToken: string): Promise<GatewayStatus & { ok: boolean }> {
  return api<GatewayStatus & { ok: boolean }>("/api/ai-gateway/external", {
    method: "PUT",
    body: JSON.stringify({ url, adminToken })
  });
}

export function disconnectExternal(): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>("/api/ai-gateway/external", { method: "DELETE" });
}

export function listProviders(opts?: ApiOptions): Promise<ProvidersResponse> {
  return api<ProvidersResponse>("/api/ai-gateway/providers", opts);
}

export function setProviderKey(
  id: ProviderId,
  body: { apiKey: string; baseUrl?: string }
): Promise<{ ok: boolean; providers: ProviderStatus[] }> {
  return api<{ ok: boolean; providers: ProviderStatus[] }>(`/api/ai-gateway/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

export function clearProviderKey(id: ProviderId): Promise<{ ok: boolean; providers: ProviderStatus[] }> {
  return api<{ ok: boolean; providers: ProviderStatus[] }>(`/api/ai-gateway/providers/${id}`, {
    method: "DELETE"
  });
}

export function refreshProvider(id: ProviderId): Promise<RefreshResult> {
  return api<RefreshResult>(`/api/ai-gateway/providers/${id}/refresh`, { method: "POST" });
}

export function listTokens(opts?: ApiOptions): Promise<{ tokens: ConsumerToken[] }> {
  return api<{ tokens: ConsumerToken[] }>("/api/ai-gateway/tokens", opts);
}

export function mintToken(
  name: string
): Promise<{ ok: boolean; token: string; record: ConsumerToken; warning: string }> {
  return api<{ ok: boolean; token: string; record: ConsumerToken; warning: string }>(
    "/api/ai-gateway/tokens",
    { method: "POST", body: JSON.stringify({ name }) }
  );
}

export function revokeToken(id: string): Promise<{ ok: boolean; record: ConsumerToken }> {
  return api<{ ok: boolean; record: ConsumerToken }>(`/api/ai-gateway/tokens/${id}`, {
    method: "DELETE"
  });
}

export function getUsage(hours = 24, opts?: ApiOptions): Promise<UsageSummary> {
  return api<UsageSummary>(`/api/ai-gateway/usage?hours=${hours}`, opts);
}

export function testGateway(body: { model?: string; prompt?: string } = {}): Promise<TestResult> {
  return api<TestResult>("/api/ai-gateway/test", {
    method: "POST",
    body: JSON.stringify(body)
  });
}
