/**
 * Model-id mapping and the `/v1/models` payload.
 *
 * §9: "do not pass consumer model strings through unchanged." Two layers:
 *
 *   1. An explicit table. Canonical ids and the aliases the consumer apps
 *      actually send get resolved to a provider + upstream id, with the
 *      per-model output cap translation needs (Anthropic requires max_tokens;
 *      OpenAI does not, so an OpenAI→Anthropic translation has to invent one).
 *
 *   2. Prefix routing for anything not in the table. A model id released after
 *      this file was written should reach the right provider rather than 404,
 *      so `claude-*` goes to Anthropic and `gpt-*`/`o[0-9]*` to OpenAI. The
 *      upstream is then the authority on whether the id is real.
 *
 * The table is a starting point, not gospel — §9 says to verify ids against
 * the vendor API. `registerModels()` lets an operator correct or extend it
 * from config without a code change.
 *
 * Framework-free: imports only sibling core modules.
 */

import { GatewayError } from "./errors.js";
import type { ProviderId } from "./types.js";

export type ModelEntry = {
  /** The id SubGate advertises and consumers request. */
  id: string;
  provider: ProviderId;
  /** The id sent upstream. Differs when we expose a stable alias. */
  upstreamId: string;
  /** Alternate ids that resolve here (short names, dated snapshots, legacy). */
  aliases?: string[];
  /** Default + hard cap for output tokens. Used when a request omits max_tokens. */
  maxOutputTokens: number;
  /** Advertised on /v1/models for clients that size their own prompts. */
  contextWindow: number;
  /** Shown in the dashboard's provider cards. */
  displayName: string;
};

/**
 * Default table.
 *
 * Model ids move; treat this as the shipped default and verify against the
 * vendor APIs before relying on any single entry (`GET /v1/models` on both
 * upstreams is the check). Nothing else in the core hardcodes a model id.
 */
const DEFAULT_MODELS: ModelEntry[] = [
  // ---- Anthropic ---------------------------------------------------------
  {
    id: "claude-opus-5",
    provider: "anthropic",
    upstreamId: "claude-opus-5",
    aliases: ["opus", "claude-opus", "claude-3-opus-20240229", "claude-opus-4-1"],
    maxOutputTokens: 32000,
    contextWindow: 200000,
    displayName: "Claude Opus 5"
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    upstreamId: "claude-sonnet-5",
    aliases: ["sonnet", "claude-sonnet", "claude-3-5-sonnet-20241022", "claude-sonnet-4-5"],
    maxOutputTokens: 64000,
    contextWindow: 200000,
    displayName: "Claude Sonnet 5"
  },
  {
    id: "claude-fable-5",
    provider: "anthropic",
    upstreamId: "claude-fable-5",
    aliases: ["fable"],
    maxOutputTokens: 64000,
    contextWindow: 200000,
    displayName: "Claude Fable 5"
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    upstreamId: "claude-haiku-4-5-20251001",
    aliases: ["haiku", "claude-haiku", "claude-haiku-4-5", "claude-3-haiku-20240307"],
    maxOutputTokens: 32000,
    contextWindow: 200000,
    displayName: "Claude Haiku 4.5"
  },
  // ---- OpenAI ------------------------------------------------------------
  {
    id: "gpt-4o",
    provider: "openai",
    upstreamId: "gpt-4o",
    aliases: ["gpt-4-turbo", "gpt-4"],
    maxOutputTokens: 16384,
    contextWindow: 128000,
    displayName: "GPT-4o"
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    upstreamId: "gpt-4o-mini",
    aliases: ["gpt-3.5-turbo", "gpt-4o-mini-2024-07-18"],
    maxOutputTokens: 16384,
    contextWindow: 128000,
    displayName: "GPT-4o mini"
  },
  {
    id: "gpt-4.1",
    provider: "openai",
    upstreamId: "gpt-4.1",
    aliases: ["gpt-4.1-2025-04-14"],
    maxOutputTokens: 32768,
    contextWindow: 1047576,
    displayName: "GPT-4.1"
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    upstreamId: "gpt-4.1-mini",
    maxOutputTokens: 32768,
    contextWindow: 1047576,
    displayName: "GPT-4.1 mini"
  }
];

/** Fallback output cap for a prefix-routed model we have no entry for. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 8192;

let registry: ModelEntry[] = [...DEFAULT_MODELS];
let index = buildIndex(registry);

function buildIndex(entries: ModelEntry[]): Map<string, ModelEntry> {
  const map = new Map<string, ModelEntry>();
  for (const entry of entries) {
    map.set(normalize(entry.id), entry);
    for (const alias of entry.aliases ?? []) {
      // Explicit ids win over aliases when both are claimed.
      if (!map.has(normalize(alias))) map.set(normalize(alias), entry);
    }
  }
  return map;
}

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Replace or extend the table. `mode: "replace"` swaps it wholesale (operator
 * knows exactly what they want exposed); `mode: "merge"` overrides matching
 * ids and appends the rest.
 */
export function registerModels(entries: ModelEntry[], mode: "merge" | "replace" = "merge"): void {
  if (mode === "replace") {
    registry = [...entries];
  } else {
    const byId = new Map(registry.map((entry) => [normalize(entry.id), entry]));
    for (const entry of entries) byId.set(normalize(entry.id), entry);
    registry = [...byId.values()];
  }
  index = buildIndex(registry);
}

/** Restore the shipped defaults. Test seam. */
export function resetModels(): void {
  registry = [...DEFAULT_MODELS];
  index = buildIndex(registry);
}

export function listModels(): ModelEntry[] {
  return [...registry];
}

export type ResolvedModel = {
  provider: ProviderId;
  /** The id to send upstream. */
  upstreamId: string;
  /** The id to echo back to the consumer — always what they asked for. */
  requestedId: string;
  maxOutputTokens: number;
  /** True when this came from prefix routing rather than the table. */
  inferred: boolean;
};

/**
 * Resolve a consumer's model string.
 *
 * `availableProviders` is the set that currently has working credentials. A
 * model resolving to a provider we can't reach is an explicit error rather
 * than a silent reroute — silently answering a `claude-opus-5` request from
 * GPT-4o would be a correctness bug the consumer can't see.
 */
export function resolveModel(requested: string, availableProviders?: ProviderId[]): ResolvedModel {
  const raw = (requested ?? "").trim();
  if (!raw) {
    throw new GatewayError("invalid_request", "`model` is required.");
  }

  const entry = index.get(normalize(raw));
  const resolved: ResolvedModel = entry
    ? {
        provider: entry.provider,
        upstreamId: entry.upstreamId,
        requestedId: raw,
        maxOutputTokens: entry.maxOutputTokens,
        inferred: false
      }
    : {
        provider: inferProvider(raw),
        upstreamId: raw,
        requestedId: raw,
        maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
        inferred: true
      };

  if (availableProviders && !availableProviders.includes(resolved.provider)) {
    throw new GatewayError(
      "no_provider_configured",
      `Model "${raw}" routes to ${resolved.provider}, which has no credentials configured on this gateway. ` +
        `Configure a ${resolved.provider} API key, or request one of: ${modelsFor(availableProviders)
          .map((m) => m.id)
          .join(", ")}.`
    );
  }

  return resolved;
}

/**
 * Prefix routing for unknown ids. Anything unrecognisable is an error rather
 * than a guess — sending a typo'd model to a provider produces a confusing
 * upstream 404 several layers away from the mistake.
 */
function inferProvider(id: string): ProviderId {
  const lowered = normalize(id);
  if (lowered.startsWith("claude") || lowered.startsWith("anthropic")) return "anthropic";
  if (/^(gpt|o[0-9]|chatgpt|text-|davinci|codex)/.test(lowered)) return "openai";
  throw new GatewayError(
    "not_found",
    `Unknown model "${id}". Known models: ${registry.map((m) => m.id).join(", ")}. ` +
      "Ids starting with claude- or gpt-/o- are routed automatically."
  );
}

export function modelsFor(providers: ProviderId[]): ModelEntry[] {
  return registry.filter((entry) => providers.includes(entry.provider));
}

/** OpenAI-compatible `GET /v1/models` body, restricted to usable providers. */
export function modelsPayload(availableProviders: ProviderId[]): {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    context_window: number;
    max_output_tokens: number;
    display_name: string;
  }>;
} {
  // A fixed `created` keeps the payload byte-stable across polls so clients
  // that cache on response hash don't churn.
  const created = 1700000000;
  return {
    object: "list",
    data: modelsFor(availableProviders).map((entry) => ({
      id: entry.id,
      object: "model" as const,
      created,
      owned_by: entry.provider,
      context_window: entry.contextWindow,
      max_output_tokens: entry.maxOutputTokens,
      display_name: entry.displayName
    }))
  };
}
