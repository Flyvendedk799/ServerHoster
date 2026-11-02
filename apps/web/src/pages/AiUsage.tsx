import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Check, Loader2, Plug, RefreshCw, Unplug, Wallet } from "lucide-react";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
import { Skeleton } from "../components/ui/Skeleton";
import {
  connectApp,
  disconnectApp,
  formatCount,
  formatMs,
  formatUsd,
  getApps,
  getEvents,
  getPrices,
  getSummary,
  saveBudgets,
  savePrices,
  type Budgets,
  type ModelPrice,
  type Price,
  type RangeKey,
  type UsageApp,
  type UsageEvent,
  type UsageSummary
} from "../lib/aiUsage";

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" }
];

const POLL_MS = 15000;

/** Distinct, theme-safe series colours; anything past the 7th app folds into "Other". */
const SERIES_COLORS = ["#5488f0", "#37d48a", "#edaa3a", "#e95f5f", "#a78bfa", "#2dd4bf", "#f472b6"];
const OTHER_COLOR = "#707784";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Every bucket from the range start to now, so quiet periods show as gaps, not as missing bars. */
function bucketKeys(from: string, bucket: "hour" | "day"): string[] {
  const out: string[] = [];
  const start = new Date(from);
  const step = bucket === "hour" ? 3600_000 : 86_400_000;
  const cursor =
    bucket === "hour"
      ? new Date(
          Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours())
        )
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const end = Date.now();
  for (let t = cursor.getTime(); t <= end && out.length < 400; t += step) {
    const iso = new Date(t).toISOString();
    out.push(bucket === "hour" ? iso.slice(0, 13) : iso.slice(0, 10));
  }
  return out;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

type SpendChartProps = { summary: UsageSummary };

function SpendChart({ summary }: SpendChartProps) {
  const { keys, groups, stacks, max } = useMemo(() => {
    const keys = bucketKeys(summary.from, summary.bucket);
    const ranked = summary.by_service.map((s) => s.service_id);
    const top = ranked.slice(0, SERIES_COLORS.length);
    const groups = top.map((id, i) => ({
      id,
      name: summary.by_service.find((s) => s.service_id === id)?.app_name ?? id,
      color: SERIES_COLORS[i]
    }));
    if (ranked.length > top.length) groups.push({ id: "__other", name: "Other apps", color: OTHER_COLOR });
    const stacks = keys.map((k) => {
      const parts = groups.map((g) => ({ ...g, cost: 0, requests: 0 }));
      for (const p of summary.series) {
        if (p.bucket !== k) continue;
        const idx = parts.findIndex((g) => g.id === p.service_id);
        const target = idx >= 0 ? parts[idx] : parts.find((g) => g.id === "__other");
        if (target) {
          target.cost += p.cost_micro_usd;
          target.requests += p.requests;
        }
      }
      return { key: k, parts, total: parts.reduce((s, x) => s + x.cost, 0) };
    });
    return { keys, groups, stacks, max: niceMax(Math.max(...stacks.map((s) => s.total), 0)) };
  }, [summary]);

  const W = 760;
  const H = 220;
  const pad = { l: 56, r: 8, t: 8, b: 26 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(keys.length, 1);
  const barW = Math.max(2, Math.min(34, slot * 0.72));
  const label = (k: string) => (summary.bucket === "hour" ? `${k.slice(11)}:00` : k.slice(5));
  const everyN = Math.max(1, Math.ceil(keys.length / 8));
  const total = stacks.reduce((s, x) => s + x.total, 0);

  if (total === 0) {
    return (
      <div className="ai-usage-empty small muted">
        No priced spend in this period yet. Connect an app below, or send a request from one that is already
        connected.
      </div>
    );
  }
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ai-usage-chart"
        role="img"
        aria-label={`Spend per ${summary.bucket}, ${formatUsd(total)} in total`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = pad.t + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="ai-usage-grid" />
              <text x={pad.l - 8} y={y + 4} textAnchor="end" className="ai-usage-axis">
                {formatUsd(max * f)}
              </text>
            </g>
          );
        })}
        {stacks.map((s, i) => {
          let yCursor = pad.t + plotH;
          const x = pad.l + i * slot + (slot - barW) / 2;
          return (
            <g key={s.key}>
              {s.parts.map((p) => {
                if (p.cost <= 0) return null;
                const h = Math.max(1, (p.cost / max) * plotH);
                yCursor -= h;
                return (
                  <rect key={p.id} x={x} y={yCursor} width={barW} height={h} fill={p.color} rx={1.5}>
                    <title>{`${p.name} · ${label(s.key)} · ${formatUsd(p.cost)} · ${p.requests} requests`}</title>
                  </rect>
                );
              })}
              {i % everyN === 0 && (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="ai-usage-axis">
                  {label(s.key)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ai-usage-legend">
        {groups.map((g) => (
          <span key={g.id} className="ai-usage-legend-item">
            <span className="ai-usage-swatch" style={{ background: g.color }} />
            {g.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ai-usage-stat">
      <span className="tiny uppercase font-bold muted">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const tone = pct >= 100 ? "var(--red)" : pct >= 80 ? "var(--amber)" : "var(--green)";
  return (
    <div className="ai-usage-budget-bar" title={`${formatUsd(spent)} of ${formatUsd(limit)}`}>
      <div style={{ width: `${Math.min(100, pct)}%`, background: tone }} />
    </div>
  );
}

export function AiUsagePage() {
  const [range, setRange] = useState<RangeKey>("7d");
  const [service, setService] = useState<string>("");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [apps, setApps] = useState<UsageApp[]>([]);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<Set<string>>(new Set());
  const [budgetDraft, setBudgetDraft] = useState<{
    global: string;
    apps: Record<string, { daily: string; monthly: string }>;
  }>({
    global: "",
    apps: {}
  });
  const [budgetDirty, setBudgetDirty] = useState(false);
  const [priceDraft, setPriceDraft] = useState<Record<string, Price>>({});

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [s, e, a, p] = await Promise.all([
          getSummary(range, service || undefined, { silent: true }),
          getEvents(30, service || undefined, { silent: true }),
          getApps({ silent: true }),
          getPrices({ silent: true })
        ]);
        setSummary(s);
        setEvents(e.events);
        setApps(a.apps);
        setPrices(p.models);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load usage");
      } finally {
        setLoading(false);
      }
    },
    [range, service]
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Seed the budget form from the server unless the user is mid-edit.
  useEffect(() => {
    if (!summary || budgetDirty) return;
    const b = summary.budgets;
    const appsDraft: Record<string, { daily: string; monthly: string }> = {};
    for (const [id, v] of Object.entries(b.per_service)) {
      appsDraft[id] = { daily: v.daily_usd?.toString() ?? "", monthly: v.monthly_usd?.toString() ?? "" };
    }
    setBudgetDraft({ global: b.global_daily_usd?.toString() ?? "", apps: appsDraft });
  }, [summary, budgetDirty]);

  const unpricedModels = useMemo(() => prices.filter((m) => !m.priced), [prices]);
  const connectedApps = apps.filter((a) => a.connected);

  async function onConnect(app: UsageApp) {
    setBusy(`connect:${app.service_id}`);
    try {
      await connectApp(app.service_id);
      setJustConnected((prev) => new Set(prev).add(app.service_id));
      toast.success(`${app.name} connected. Restart it so it picks up the usage token.`);
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect(app: UsageApp) {
    const ok = await confirmDialog({
      title: `Disconnect ${app.name}?`,
      message:
        "Its usage token is revoked and removed from the app's environment. Past usage stays in the history. Restart the app afterwards.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!ok) return;
    setBusy(`connect:${app.service_id}`);
    try {
      await disconnectApp(app.service_id);
      toast.warning(`${app.name} disconnected`);
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(null);
    }
  }

  async function onSaveBudgets() {
    const parse = (v: string): number | null => {
      const n = Number(v.replace(",", "."));
      return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
    };
    const next: Budgets = { global_daily_usd: parse(budgetDraft.global), per_service: {} };
    for (const [id, v] of Object.entries(budgetDraft.apps)) {
      const daily = parse(v.daily);
      const monthly = parse(v.monthly);
      if (daily || monthly) next.per_service[id] = { daily_usd: daily, monthly_usd: monthly };
    }
    setBusy("budgets");
    try {
      await saveBudgets(next);
      setBudgetDirty(false);
      toast.success("Budgets saved. You'll get a notification at 80% and 100%.");
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save budgets");
    } finally {
      setBusy(null);
    }
  }

  async function onSavePrices() {
    setBusy("prices");
    try {
      const res = await savePrices(priceDraft);
      setPrices(res.models);
      toast.success("Prices saved. They apply to new requests only.");
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save prices");
    } finally {
      setBusy(null);
    }
  }

  const setPriceField = (model: string, field: keyof Price, value: string) => {
    const base = priceDraft[model] ??
      prices.find((p) => p.model === model)?.price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const n = Number(value.replace(",", "."));
    setPriceDraft({ ...priceDraft, [model]: { ...base, [field]: Number.isFinite(n) && n >= 0 ? n : 0 } });
  };

  const t = summary?.totals;

  return (
    <div className="ai-usage-page">
      <header className="page-header">
        <div>
          <div className="page-title">AI Usage</div>
          <p className="muted">
            What your hosted apps spend on AI APIs: cost, tokens, errors and latency per app and model. Apps
            report each call themselves; prompts and replies are never stored here.
          </p>
        </div>
        <div className="row">
          <select
            className="ai-usage-select"
            aria-label="Filter by app"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">All apps</option>
            {connectedApps.map((a) => (
              <option key={a.service_id} value={a.service_id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="ai-usage-range" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={range === r.key ? "primary xsmall" : "ghost xsmall"}
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="alert alert-amber" role="alert">
          <AlertTriangle size={18} />
          <div>
            <div className="alert-title">Could not load usage</div>
            <p className="small muted">{error}</p>
          </div>
        </div>
      )}

      {t && t.unpriced_requests > 0 && (
        <div className="alert alert-amber" role="status">
          <AlertTriangle size={18} />
          <div>
            <div className="alert-title">{t.unpriced_requests} requests have no price</div>
            <p className="small muted">
              These used {unpricedModels.map((m) => m.model).join(", ") || "models without a known price"} and
              are counted as requests and tokens but not in spend, so the totals below are a lower bound. Set
              a price under “Model prices”.
            </p>
          </div>
        </div>
      )}

      <section className="card ai-usage-kpis" aria-label="Summary">
        {loading && !summary ? (
          <Skeleton style={{ height: "4rem", width: "100%" }} />
        ) : (
          <>
            <Stat
              label="Spend"
              value={formatUsd(t?.cost_micro_usd ?? 0)}
              sub={`avg ${formatUsd(t?.avg_cost_micro_usd ?? 0)} / request`}
            />
            <Stat label="Today (UTC)" value={formatUsd(summary?.spend.today_micro_usd ?? 0)} sub="all apps" />
            <Stat label="This month" value={formatUsd(summary?.spend.month_micro_usd ?? 0)} sub="all apps" />
            <Stat
              label="Requests"
              value={formatCount(t?.requests ?? 0)}
              sub={`${formatCount(t?.errors ?? 0)} errors (${((t?.error_rate ?? 0) * 100).toFixed(1)}%)`}
            />
            <Stat
              label="Tokens"
              value={formatCount((t?.input_tokens ?? 0) + (t?.output_tokens ?? 0))}
              sub={`${formatCount(t?.input_tokens ?? 0)} in · ${formatCount(t?.output_tokens ?? 0)} out`}
            />
            <Stat
              label="Latency"
              value={formatMs(t?.p50_ms ?? null)}
              sub={`p95 ${formatMs(t?.p95_ms ?? null)}`}
            />
            <Stat
              label="Cache hits"
              value={`${((t?.cache_hit_rate ?? 0) * 100).toFixed(0)}%`}
              sub="of input tokens"
            />
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Spend over time</span>
        </div>
        {summary ? <SpendChart summary={summary} /> : <Skeleton style={{ height: "12rem", width: "100%" }} />}
      </section>

      <div className="ai-usage-two">
        <section className="card">
          <div className="card-head">
            <span className="card-title">By app</span>
          </div>
          {summary && summary.by_service.length > 0 ? (
            <table className="ai-usage-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="num">Spend</th>
                  <th className="num">Requests</th>
                  <th className="num">Tokens</th>
                  <th className="num">Errors</th>
                  <th className="num">Avg latency</th>
                  <th>Last call</th>
                </tr>
              </thead>
              <tbody>
                {summary.by_service.map((s) => (
                  <tr key={s.service_id}>
                    <td>{s.app_name}</td>
                    <td className="num">
                      {formatUsd(s.cost_micro_usd)}
                      {s.unpriced_requests > 0 && (
                        <span className="warn-chip chip xsmall" title="Some calls had no price">
                          + unpriced
                        </span>
                      )}
                    </td>
                    <td className="num">{formatCount(s.requests)}</td>
                    <td className="num">{formatCount(s.input_tokens + s.output_tokens)}</td>
                    <td className="num">{s.errors > 0 ? s.errors : "—"}</td>
                    <td className="num">{formatMs(s.avg_duration_ms || null)}</td>
                    <td className="muted">{relativeTime(s.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small muted">No calls reported in this period.</p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <span className="card-title">By model</span>
          </div>
          {summary && summary.by_model.length > 0 ? (
            <table className="ai-usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Spend</th>
                  <th className="num">Requests</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                </tr>
              </thead>
              <tbody>
                {summary.by_model.map((m) => (
                  <tr key={`${m.provider}:${m.model}`}>
                    <td>
                      <code className="small">{m.model}</code>{" "}
                      <span className="muted xsmall">{m.provider}</span>
                    </td>
                    <td className="num">
                      {m.unpriced_requests === m.requests && m.requests > 0 ? (
                        <span className="warn-chip chip xsmall">no price</span>
                      ) : (
                        formatUsd(m.cost_micro_usd)
                      )}
                    </td>
                    <td className="num">{formatCount(m.requests)}</td>
                    <td className="num">{formatCount(m.input_tokens)}</td>
                    <td className="num">{formatCount(m.output_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small muted">No calls reported in this period.</p>
          )}
          {summary && summary.error_codes.length > 0 && (
            <p className="small muted ai-usage-errors">
              Errors: {summary.error_codes.map((c) => `${c.error_code} ×${c.n}`).join(", ")}
            </p>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Apps</span>
        </div>
        <p className="small muted">
          Connecting an app gives it a private usage token and two environment variables,{" "}
          <code>SURVHUB_AI_USAGE_URL</code> and <code>SURVHUB_AI_USAGE_TOKEN</code>. The app then reports one
          event per model call. Restart it after connecting. Apps that call a model API directly are
          supported; the AI Gateway page covers traffic that goes through the gateway.
        </p>
        <table className="ai-usage-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Type</th>
              <th>Status</th>
              <th>Last report</th>
              <th className="num">Events</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.service_id}>
                <td>{a.name}</td>
                <td className="muted">{a.type}</td>
                <td>
                  {a.connected ? (
                    <span className="chip xsmall tag-green">
                      <Check size={11} /> Connected
                    </span>
                  ) : (
                    <span className="chip xsmall">Not connected</span>
                  )}
                  {justConnected.has(a.service_id) && (
                    <span className="warn-chip chip xsmall">restart to apply</span>
                  )}
                </td>
                <td className="muted">
                  {a.connected
                    ? a.last_used_at
                      ? relativeTime(a.last_used_at)
                      : "waiting for first call"
                    : "—"}
                </td>
                <td className="num">{formatCount(a.total_events)}</td>
                <td className="num">
                  {a.connected ? (
                    <span className="row ai-usage-actions">
                      <button
                        className="ghost xsmall"
                        disabled={busy === `connect:${a.service_id}`}
                        onClick={() => void onConnect(a)}
                        title="Replace the token"
                      >
                        <RefreshCw size={12} /> Rotate
                      </button>
                      <button
                        className="ghost xsmall danger"
                        disabled={busy === `connect:${a.service_id}`}
                        onClick={() => void onDisconnect(a)}
                      >
                        <Unplug size={12} /> Disconnect
                      </button>
                    </span>
                  ) : (
                    <button
                      className="primary xsmall"
                      disabled={busy === `connect:${a.service_id}`}
                      onClick={() => void onConnect(a)}
                    >
                      {busy === `connect:${a.service_id}` ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Plug size={12} />
                      )}{" "}
                      Connect
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {apps.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  No services yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">
            <Wallet size={14} /> Budgets and alerts
          </span>
        </div>
        <p className="small muted">
          A notification is raised at 80% and again at 100% of each budget (once per day or month).
          Notifications are forwarded to your external webhook if one is set under Settings.
        </p>
        <div className="ai-usage-budgets">
          <label className="ai-usage-budget-row">
            <span>All apps, per day (UTC)</span>
            <input
              inputMode="decimal"
              placeholder="no limit"
              value={budgetDraft.global}
              onChange={(e) => {
                setBudgetDirty(true);
                setBudgetDraft({ ...budgetDraft, global: e.target.value });
              }}
            />
            <span className="muted small">USD per day</span>
            {summary && summary.budgets.global_daily_usd ? (
              <BudgetBar
                spent={summary.spend.today_micro_usd}
                limit={summary.budgets.global_daily_usd * 1_000_000}
              />
            ) : (
              <span />
            )}
          </label>
          {connectedApps.map((a) => {
            const v = budgetDraft.apps[a.service_id] ?? { daily: "", monthly: "" };
            const saved = summary?.budgets.per_service[a.service_id];
            return (
              <div key={a.service_id} className="ai-usage-budget-row">
                <span>{a.name}</span>
                <input
                  aria-label={`${a.name} daily budget in USD`}
                  inputMode="decimal"
                  placeholder="per day"
                  value={v.daily}
                  onChange={(e) => {
                    setBudgetDirty(true);
                    setBudgetDraft({
                      ...budgetDraft,
                      apps: { ...budgetDraft.apps, [a.service_id]: { ...v, daily: e.target.value } }
                    });
                  }}
                />
                <input
                  aria-label={`${a.name} monthly budget in USD`}
                  inputMode="decimal"
                  placeholder="per month"
                  value={v.monthly}
                  onChange={(e) => {
                    setBudgetDirty(true);
                    setBudgetDraft({
                      ...budgetDraft,
                      apps: { ...budgetDraft.apps, [a.service_id]: { ...v, monthly: e.target.value } }
                    });
                  }}
                />
                {saved?.daily_usd ? (
                  <BudgetBar
                    spent={summary?.spend.per_service_today[a.service_id] ?? 0}
                    limit={saved.daily_usd * 1_000_000}
                  />
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={!budgetDirty || busy === "budgets"}
            onClick={() => void onSaveBudgets()}
          >
            {busy === "budgets" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
            budgets
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">
            <Activity size={14} /> Recent calls
          </span>
        </div>
        {events.length > 0 ? (
          <table className="ai-usage-table">
            <thead>
              <tr>
                <th>When</th>
                <th>App</th>
                <th>Model</th>
                <th className="num">In / out</th>
                <th className="num">Cost</th>
                <th className="num">Time</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{relativeTime(e.created_at)}</td>
                  <td>{e.app_name}</td>
                  <td>
                    <code className="small">{e.model}</code>
                  </td>
                  <td className="num">
                    {formatCount(e.input_tokens + e.cache_read_tokens + e.cache_write_tokens)} /{" "}
                    {formatCount(e.output_tokens)}
                  </td>
                  <td className="num">
                    {e.cost_micro_usd === null ? (
                      <span className="warn-chip chip xsmall">no price</span>
                    ) : (
                      formatUsd(e.cost_micro_usd)
                    )}
                  </td>
                  <td className="num">{e.duration_ms ? formatMs(e.duration_ms) : "—"}</td>
                  <td>
                    {e.status === "ok" ? (
                      <span className="chip xsmall tag-green">ok</span>
                    ) : (
                      <span className="chip xsmall tag-red">{e.error_code ?? "error"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="small muted">Nothing yet. Calls appear here a moment after an app reports them.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Model prices</span>
        </div>
        <p className="small muted">
          USD per million tokens. Defaults are Anthropic's list prices; cache writes are assumed to cost 1.25×
          input. Edit a row to override it (for example for a negotiated rate), or fill in a model that has no
          price. Changes apply to new calls only.
        </p>
        <table className="ai-usage-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((m) => {
              const draft = priceDraft[m.model];
              const p = draft ?? m.price;
              return (
                <tr key={m.model}>
                  <td>
                    <code className="small">{m.model}</code>{" "}
                    {!m.priced && <span className="warn-chip chip xsmall">no price</span>}
                    {m.custom && <span className="chip xsmall text-accent">custom</span>}
                  </td>
                  {(["input", "output", "cacheRead", "cacheWrite"] as const).map((f) => (
                    <td key={f} className="num">
                      <input
                        className="ai-usage-price"
                        aria-label={`${m.model} ${f}`}
                        inputMode="decimal"
                        value={p ? String(p[f]) : ""}
                        placeholder="—"
                        onChange={(e) => setPriceField(m.model, f, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          <button
            className="primary"
            disabled={Object.keys(priceDraft).length === 0 || busy === "prices"}
            onClick={() => void onSavePrices()}
          >
            {busy === "prices" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
            prices
          </button>
        </div>
      </section>

      {summary?.gateway && summary.gateway.requests > 0 && (
        <section className="card">
          <div className="card-head">
            <span className="card-title">AI Gateway traffic</span>
          </div>
          <p className="small muted">
            {formatCount(summary.gateway.requests)} requests through the gateway in this period (
            {formatCount(summary.gateway.prompt_tokens)} in / {formatCount(summary.gateway.completion_tokens)}{" "}
            out tokens, {summary.gateway.errors} errors). The gateway uses your provider subscription, so it
            has no per-token cost here. See the AI Gateway page for per-token details.
          </p>
        </section>
      )}
    </div>
  );
}
