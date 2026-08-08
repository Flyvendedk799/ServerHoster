import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Zap
} from "lucide-react";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
import { Skeleton } from "../components/ui/Skeleton";
import {
  clearProviderKey,
  connectExternal,
  disableGateway,
  disconnectExternal,
  enableGateway,
  getGatewayStatus,
  getUsage,
  listProviders,
  listTokens,
  mintToken,
  refreshProvider,
  revokeToken,
  setProviderKey,
  testGateway,
  updateGatewayConfig,
  type ConsumerToken,
  type GatewayStatus,
  type ModelInfo,
  type ProviderId,
  type ProviderStatus,
  type TestResult,
  type UsageSummary
} from "../lib/aiGateway";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI"
};

const PROVIDER_KEY_HINTS: Record<ProviderId, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…"
};

/** Poll cadence while the gateway is running. Slow enough not to be noisy. */
const POLL_MS = 5000;

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "unknown";
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function AiGatewayPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tokens, setTokens] = useState<ConsumerToken[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [publicUrlDraft, setPublicUrlDraft] = useState("");
  const [externalUrlDraft, setExternalUrlDraft] = useState("");
  const [externalTokenDraft, setExternalTokenDraft] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [mintedToken, setMintedToken] = useState<{ token: string; name: string } | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Avoid clobbering a field the operator is mid-edit when a poll lands.
  const publicUrlTouched = useRef(false);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      const [nextStatus, providers, tokenList, usageSummary] = await Promise.all([
        getGatewayStatus({ silent }),
        listProviders({ silent }),
        listTokens({ silent }),
        getUsage(24, { silent })
      ]);
      setStatus(nextStatus);
      setModels(providers.models);
      setTokens(tokenList.tokens);
      setUsage(usageSummary);
      if (!publicUrlTouched.current) setPublicUrlDraft(nextStatus.public_url ?? "");
    } catch {
      /* toasted by the api client unless silent */
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [status?.running, load]);

  const configuredProviders = useMemo(
    () => (status?.providers ?? []).filter((provider) => provider.configured),
    [status]
  );

  // In external mode the tab manages a standalone SubGate container: the
  // container owns the provider key (in its own env) and the runtime config, so
  // this tab only mints tokens, reads usage, and tests.
  const isExternal = status?.external ?? false;

  async function connectExternalGateway(event: FormEvent): Promise<void> {
    event.preventDefault();
    const url = externalUrlDraft.trim();
    const token = externalTokenDraft.trim();
    if (!url || !token) return;
    setBusyKey("external-connect");
    try {
      const next = await connectExternal(url, token);
      setStatus(next);
      setExternalTokenDraft("");
      toast.success("Connected to the SubGate container");
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function disconnectExternalGateway(): Promise<void> {
    const ok = await confirmDialog({
      title: "Disconnect the external gateway?",
      message:
        "The tab stops managing the container. The container keeps running and consumers keep working — only this dashboard view changes.",
      confirmLabel: "Disconnect"
    });
    if (!ok) return;
    setBusyKey("external-disconnect");
    try {
      await disconnectExternal();
      toast.warning("Disconnected from the container");
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
    } catch {
      toast.error("Clipboard unavailable — select and copy manually.");
    }
  }

  async function toggleGateway(): Promise<void> {
    if (!status) return;
    setBusyKey("toggle");
    try {
      const next = status.enabled ? await disableGateway() : await enableGateway();
      setStatus(next);
      toast.success(next.enabled ? "AI Gateway enabled" : "AI Gateway disabled");
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function saveProviderKey(provider: ProviderId): Promise<void> {
    const apiKey = (keyDrafts[provider] ?? "").trim();
    if (!apiKey) return;
    setBusyKey(`key:${provider}`);
    try {
      await setProviderKey(provider, { apiKey });
      // Drop the plaintext from component state the moment it is stored.
      setKeyDrafts((drafts) => ({ ...drafts, [provider]: "" }));
      toast.success(`${PROVIDER_LABELS[provider]} key saved and encrypted at rest`);
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function removeProviderKey(provider: ProviderId): Promise<void> {
    const ok = await confirmDialog({
      title: `Remove the ${PROVIDER_LABELS[provider]} key?`,
      message:
        "Requests routed to this provider will start failing with 503 until a new key is added. Consumer tokens are unaffected.",
      danger: true,
      confirmLabel: "Remove key"
    });
    if (!ok) return;
    setBusyKey(`clear:${provider}`);
    try {
      await clearProviderKey(provider);
      toast.warning(`${PROVIDER_LABELS[provider]} key removed`);
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function checkProvider(provider: ProviderId): Promise<void> {
    setBusyKey(`check:${provider}`);
    try {
      const result = await refreshProvider(provider);
      if (result.ok) toast.success(`${PROVIDER_LABELS[provider]} key is valid (${result.latency_ms}ms)`);
      else toast.error(`${PROVIDER_LABELS[provider]}: ${result.error ?? "check failed"}`);
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function savePublicUrl(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusyKey("publicUrl");
    try {
      const next = await updateGatewayConfig({ publicUrl: publicUrlDraft.trim() });
      setStatus(next);
      publicUrlTouched.current = false;
      toast.success("Public URL saved");
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function createToken(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = tokenName.trim();
    if (!name) return;
    setBusyKey("mint");
    try {
      const result = await mintToken(name);
      setMintedToken({ token: result.token, name });
      setTokenName("");
      toast.warning(result.warning);
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function removeToken(token: ConsumerToken): Promise<void> {
    const ok = await confirmDialog({
      title: `Revoke "${token.name}"?`,
      message:
        "Any app still using this token starts getting 401 immediately. The provider keys and every other token are unaffected.",
      danger: true,
      confirmLabel: "Revoke"
    });
    if (!ok) return;
    setBusyKey(`revoke:${token.id}`);
    try {
      await revokeToken(token.id);
      toast.warning(`${token.name} revoked`);
      await load(true);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function runTest(): Promise<void> {
    setBusyKey("test");
    setTestResult(null);
    try {
      const result = await testGateway();
      setTestResult(result);
      if (result.ok) toast.success(`Round-trip OK via ${result.provider} in ${result.duration_ms}ms`);
      else toast.error(result.error);
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  if (loading && !status) {
    return (
      <div className="ai-gateway-page">
        <header className="page-header">
          <div>
            <div className="page-title">AI Gateway</div>
            <p className="muted">One OpenAI-compatible endpoint in front of every model provider.</p>
          </div>
        </header>
        <Skeleton style={{ height: "120px" }} />
        <Skeleton style={{ height: "220px" }} />
      </div>
    );
  }

  const baseUrl = status?.openai_base_url ?? "";
  const envSnippet = `OPENAI_BASE_URL=${baseUrl || "https://<host>/v1"}\nOPENAI_API_KEY=${
    mintedToken?.token ?? "<consumer-token>"
  }`;

  return (
    <div className="ai-gateway-page">
      <header className="page-header">
        <div>
          <div className="page-title">AI Gateway</div>
          <p className="muted">
            One OpenAI-compatible endpoint in front of every model provider. Point an app at it with
            two environment variables.
          </p>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          {!isExternal && (
            <button
              className={status?.enabled ? "danger" : "primary"}
              onClick={() => void toggleGateway()}
              disabled={busyKey === "toggle"}
            >
              {busyKey === "toggle" ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
              {status?.enabled ? "Disable" : "Enable"}
            </button>
          )}
        </div>
      </header>

      {/* ---- Live status ------------------------------------------------ */}
      <section className="card ai-gw-status">
        <div className="ai-gw-status-row">
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">Listener</span>
            <span className={`chip ${status?.running ? "tag-green" : "warn-chip"}`}>
              <Activity size={12} />
              {status?.running ? "Running" : "Stopped"}
            </span>
            <span className="small muted">
              {status ? `${status.bound.host}:${status.bound.port}` : "—"}
            </span>
          </div>
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">Providers</span>
            <span className="stat-value">{configuredProviders.length}</span>
            <span className="small muted">
              {configuredProviders.length > 0
                ? configuredProviders.map((provider) => PROVIDER_LABELS[provider.id]).join(", ")
                : "none configured"}
            </span>
          </div>
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">Active tokens</span>
            <span className="stat-value">{status?.token_count ?? 0}</span>
            <span className="small muted">{status?.rate_limit_per_minute ?? 0}/min each</span>
          </div>
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">In flight</span>
            <span className="stat-value">{status?.in_flight ?? 0}</span>
            <span className="small muted">cap {status?.max_concurrent ?? 0}</span>
          </div>
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">Requests (24h)</span>
            <span className="stat-value">{formatNumber(usage?.totals.requests ?? 0)}</span>
            <span className="small muted">{formatNumber(usage?.totals.errors ?? 0)} errors</span>
          </div>
          <div className="ai-gw-stat">
            <span className="tiny uppercase font-bold muted">Tokens (24h)</span>
            <span className="stat-value">
              {formatNumber(
                (usage?.totals.prompt_tokens ?? 0) + (usage?.totals.completion_tokens ?? 0)
              )}
            </span>
            <span className="small muted">
              {formatNumber(usage?.totals.prompt_tokens ?? 0)} in /{" "}
              {formatNumber(usage?.totals.completion_tokens ?? 0)} out
            </span>
          </div>
        </div>

        {status?.enabled && !status.running && (
          <div className="alert alert-amber" role="status">
            <AlertTriangle size={18} />
            <div>
              <div className="alert-title">Enabled but not listening</div>
              <p className="small muted">
                The listener failed to bind port {status.bound.port} — usually another process is
                already on it. Check the server log, then toggle off and on.
              </p>
            </div>
          </div>
        )}

        {status?.debug_bodies_until && Date.parse(status.debug_bodies_until) > Date.now() && (
          <div className="alert alert-amber" role="status">
            <AlertTriangle size={18} />
            <div>
              <div className="alert-title">Request logging is on</div>
              <p className="small muted">
                Request shape (model, roles, counts — never prompt text) is being logged until{" "}
                {new Date(status.debug_bodies_until).toLocaleTimeString()}.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ---- External container connection ------------------------------ */}
      {isExternal ? (
        <section className="card ai-gw-external">
          <div className="ai-gw-provider-head">
            <span className="chip xsmall tag-green">
              <ShieldCheck size={12} />
              Managing container
            </span>
            <code className="small">{status?.external_url}</code>
            <button
              className="ghost xsmall danger"
              onClick={() => void disconnectExternalGateway()}
              disabled={busyKey === "external-disconnect"}
            >
              {busyKey === "external-disconnect" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Disconnect
            </button>
          </div>
          <p className="tiny muted">
            This tab manages a standalone SubGate container. The Anthropic/OpenAI key lives in the
            container's environment (not here); the tab mints tokens, reads usage, and runs tests
            against it.
          </p>
        </section>
      ) : (
        <section className="card ai-gw-external">
          <div className="card-head">
            <div className="card-title">
              <Activity size={16} />
              <h3>Manage a standalone container</h3>
            </div>
          </div>
          <p className="small muted">
            Optional. Point this tab at a standalone SubGate container (e.g. one reachable by other
            Docker services) to manage its tokens and usage from here. Leave blank to run the
            in-process gateway instead.
          </p>
          <form className="ai-gw-inline" onSubmit={(event) => void connectExternalGateway(event)}>
            <input
              type="url"
              placeholder="http://172.17.0.1:8788"
              value={externalUrlDraft}
              onChange={(event) => setExternalUrlDraft(event.target.value)}
            />
            <input
              type="password"
              autoComplete="off"
              placeholder="Admin token"
              value={externalTokenDraft}
              onChange={(event) => setExternalTokenDraft(event.target.value)}
            />
            <button
              className="primary xsmall"
              type="submit"
              disabled={busyKey === "external-connect" || !externalUrlDraft.trim() || !externalTokenDraft.trim()}
            >
              {busyKey === "external-connect" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              Connect
            </button>
          </form>
        </section>
      )}

      <div className="grid-2 ai-gw-grid">
        {/* ---- Providers ------------------------------------------------ */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">
              <KeyRound size={16} />
              <h3>Providers</h3>
            </div>
          </div>
          <p className="small muted">
            {isExternal
              ? "The provider key is managed in the container's environment, not here. This lists which providers the container reports as usable."
              : "Keys are encrypted at rest and never returned by any endpoint. The fingerprint lets you confirm which key is installed without displaying it."}
          </p>

          {(status?.providers ?? []).map((provider: ProviderStatus) => (
            <div key={provider.id} className="ai-gw-provider">
              <div className="ai-gw-provider-head">
                <strong>{PROVIDER_LABELS[provider.id]}</strong>
                {provider.configured ? (
                  <span className="chip xsmall tag-green">
                    <ShieldCheck size={12} />
                    Configured
                  </span>
                ) : (
                  <span className="chip xsmall warn-chip">
                    <AlertTriangle size={12} />
                    No key
                  </span>
                )}
                {provider.fingerprint && (
                  <code className="tiny muted" title="SHA-256 prefix of the stored key">
                    {provider.fingerprint}
                  </code>
                )}
              </div>

              {!isExternal && (
                <>
                  <div className="ai-gw-provider-body">
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={
                        provider.configured
                          ? `Replace key (${provider.keyPreview})`
                          : PROVIDER_KEY_HINTS[provider.id]
                      }
                      value={keyDrafts[provider.id] ?? ""}
                      onChange={(event) =>
                        setKeyDrafts((drafts) => ({ ...drafts, [provider.id]: event.target.value }))
                      }
                    />
                    <button
                      className="primary xsmall"
                      onClick={() => void saveProviderKey(provider.id)}
                      disabled={busyKey === `key:${provider.id}` || !(keyDrafts[provider.id] ?? "").trim()}
                    >
                      {busyKey === `key:${provider.id}` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                      Save
                    </button>
                  </div>

                  <div className="ai-gw-provider-actions">
                    <button
                      className="ghost xsmall"
                      onClick={() => void checkProvider(provider.id)}
                      disabled={!provider.configured || busyKey === `check:${provider.id}`}
                      data-tooltip="Send a 1-token completion to verify the key still works"
                    >
                      {busyKey === `check:${provider.id}` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      Check now
                    </button>
                    <button
                      className="ghost xsmall danger"
                      onClick={() => void removeProviderKey(provider.id)}
                      disabled={!provider.configured || busyKey === `clear:${provider.id}`}
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  </div>
                </>
              )}

              <div className="ai-gw-model-list">
                {models
                  .filter((model) => model.provider === provider.id)
                  .map((model) => (
                    <span key={model.id} className="chip xsmall">
                      {model.id}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </section>

        {/* ---- Connection details --------------------------------------- */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">
              <Activity size={16} />
              <h3>Connection</h3>
            </div>
            <button
              className="ghost xsmall"
              onClick={() => void runTest()}
              disabled={busyKey === "test" || configuredProviders.length === 0}
              data-tooltip="Round-trips a real completion through the full translation path"
            >
              {busyKey === "test" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Test
            </button>
          </div>

          <form className="field" onSubmit={(event) => void savePublicUrl(event)}>
            <span>Public URL</span>
            <div className="ai-gw-inline">
              <input
                type="url"
                placeholder="https://ai.example.com"
                value={publicUrlDraft}
                onChange={(event) => {
                  publicUrlTouched.current = true;
                  setPublicUrlDraft(event.target.value);
                }}
              />
              <button className="ghost xsmall" type="submit" disabled={busyKey === "publicUrl"}>
                {busyKey === "publicUrl" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Save
              </button>
            </div>
            <span className="tiny muted">
              The hostname you mapped to 127.0.0.1:{status?.bound.port ?? "—"} in Edge Ingress.
              Supabase Edge Functions can only reach the gateway through this.
            </span>
          </form>

          <div className="field">
            <span>Environment for consumers</span>
            <pre className="ai-gw-snippet">{envSnippet}</pre>
            <div className="row">
              <button className="ghost xsmall" onClick={() => void copy(envSnippet, "env")}>
                {copied === "env" ? <Check size={14} /> : <Copy size={14} />}
                Copy env block
              </button>
              {baseUrl && (
                <button className="ghost xsmall" onClick={() => void copy(baseUrl, "base")}>
                  {copied === "base" ? <Check size={14} /> : <Copy size={14} />}
                  Copy base URL
                </button>
              )}
            </div>
            <span className="tiny muted">
              Anthropic-format clients use{" "}
              <code>{status?.anthropic_base_url ?? "https://<host>"}</code> and hit{" "}
              <code>/v1/messages</code>.
            </span>
          </div>

          {testResult && (
            <div className={`alert ${testResult.ok ? "alert-green" : "alert-amber"}`} role="status">
              {testResult.ok ? <Check size={18} /> : <AlertTriangle size={18} />}
              <div>
                <div className="alert-title">
                  {testResult.ok
                    ? `${testResult.provider} responded in ${testResult.duration_ms}ms`
                    : `Test failed (${testResult.code})`}
                </div>
                {testResult.ok ? (
                  <>
                    <p className="small">{testResult.content || "(empty response)"}</p>
                    <p className="tiny muted">
                      {testResult.model} · {testResult.translated ? "translated" : "passthrough"} ·{" "}
                      {testResult.usage.total_tokens} tokens
                    </p>
                  </>
                ) : (
                  <p className="small muted">{testResult.error}</p>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ---- Consumer tokens --------------------------------------------- */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">
            <ShieldCheck size={16} />
            <h3>Consumer tokens</h3>
          </div>
        </div>
        <p className="small muted">
          One token per app. Revoking a token cannot affect the provider keys, so a leak in one
          consumer never forces a key rotation.
        </p>

        <form className="ai-gw-inline" onSubmit={(event) => void createToken(event)}>
          <input
            placeholder="Consumer name (e.g. mymetaview-prod)"
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            maxLength={80}
          />
          <button className="primary xsmall" type="submit" disabled={busyKey === "mint" || !tokenName.trim()}>
            {busyKey === "mint" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Mint token
          </button>
        </form>

        {mintedToken && (
          <div className="alert alert-amber" role="status">
            <AlertTriangle size={18} />
            <div>
              <div className="alert-title">Copy "{mintedToken.name}" now</div>
              <p className="small muted">
                This is the only time it is shown — only a hash is stored.
              </p>
              <pre className="ai-gw-snippet">{mintedToken.token}</pre>
              <div className="row">
                <button
                  className="ghost xsmall"
                  onClick={() => void copy(mintedToken.token, "token")}
                >
                  {copied === "token" ? <Check size={14} /> : <Copy size={14} />}
                  Copy token
                </button>
                <button className="ghost xsmall" onClick={() => setMintedToken(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="ai-gw-token-list">
          {tokens.length === 0 && <p className="small muted">No tokens yet.</p>}
          {tokens.map((token) => (
            <article key={token.id} className="ai-gw-token-row">
              <div>
                <div className="row">
                  <strong>{token.name}</strong>
                  {!token.active && <span className="chip xsmall warn-chip">Revoked</span>}
                </div>
                <code className="tiny muted">{token.preview}</code>
              </div>
              <div className="small muted">
                {formatNumber(token.request_count)} requests · last used{" "}
                {relativeTime(token.last_used_at)}
              </div>
              <button
                className="ghost xsmall danger"
                onClick={() => void removeToken(token)}
                disabled={!token.active || busyKey === `revoke:${token.id}`}
              >
                {busyKey === `revoke:${token.id}` ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Revoke
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* ---- Request log -------------------------------------------------- */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">
            <Activity size={16} />
            <h3>Recent requests</h3>
          </div>
          <span className="tiny muted">Metadata only — prompt text is never recorded.</span>
        </div>

        {(usage?.recent.length ?? 0) === 0 ? (
          <p className="small muted">No requests yet.</p>
        ) : (
          <div className="ai-gw-log">
            {usage?.recent.map((entry) => (
              <div key={entry.id} className="ai-gw-log-row">
                <span className={`chip xsmall ${entry.status_code >= 400 ? "warn-chip" : "tag-green"}`}>
                  {entry.status_code}
                </span>
                <code className="small">{entry.model}</code>
                <span className="tiny muted">{entry.provider}</span>
                <span className="tiny muted">{entry.wire}</span>
                {entry.streamed && <span className="chip xsmall">stream</span>}
                <span className="tiny muted">{entry.token_name ?? "—"}</span>
                <span className="tiny muted">{formatNumber(entry.total_tokens)} tok</span>
                <span className="tiny muted">{entry.duration_ms}ms</span>
                {entry.error_code && <span className="tiny muted">{entry.error_code}</span>}
                <span className="tiny muted">{relativeTime(entry.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
