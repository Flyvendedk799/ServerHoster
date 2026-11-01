import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Check, CreditCard, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, Trash2, Unplug } from "lucide-react";
import { ApiError } from "../lib/api";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
import { Skeleton } from "../components/ui/Skeleton";
import {
  connectApp,
  disconnectApp,
  ensurePortal,
  ensurePrice,
  ensureWebhook,
  getApps,
  getStatus,
  removeKeys,
  saveKeys,
  toMinorUnits,
  verifyKeys,
  type KeyPart,
  type ModeStatus,
  type PortalResult,
  type PriceResult,
  type StripeApp,
  type StripeMode,
  type StripeStatus,
  type WebhookResult
} from "../lib/stripe";

const MODE_LABEL: Record<StripeMode, string> = { test: "Test mode", live: "Live mode" };
const PART_LABEL: Record<KeyPart, string> = { secret_key: "Secret key", publishable_key: "Publishable key", webhook_secret: "Webhook signing secret" };

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** A change that touches LIVE Stripe waits here until the owner types LIVE. */
type LiveRequest = { title: string; run: () => Promise<void> };

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`chip xsmall ${ok ? "tag-green" : "warn-chip"}`}>{ok ? <Check size={11} /> : <AlertTriangle size={11} />} {label}</span>;
}

type KeyCardProps = {
  mode: StripeMode;
  status: ModeStatus;
  busy: string | null;
  onSave: (mode: StripeMode, keys: { secretKey?: string; publishableKey?: string; webhookSecret?: string }) => Promise<boolean>;
  onRemove: (mode: StripeMode, part: KeyPart) => void;
  onVerify: (mode: StripeMode) => void;
};

function KeyCard({ mode, status, busy, onSave, onRemove, onVerify }: KeyCardProps) {
  const [secret, setSecret] = useState("");
  const [publishable, setPublishable] = useState("");
  const [webhook, setWebhook] = useState("");
  const account = status.account;
  const hasSecret = status.secret_key.configured;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await onSave(mode, {
      secretKey: secret || undefined,
      publishableKey: publishable || undefined,
      webhookSecret: webhook || undefined
    });
    if (ok) {
      // Never keep a key in the page once it has been sent.
      setSecret("");
      setPublishable("");
      setWebhook("");
    }
  }

  const parts: Array<{ part: KeyPart; value: string; set: (v: string) => void; placeholder: string }> = [
    { part: "secret_key", value: secret, set: setSecret, placeholder: mode === "live" ? "sk_live_… or rk_live_…" : "sk_test_… or rk_test_…" },
    { part: "publishable_key", value: publishable, set: setPublishable, placeholder: mode === "live" ? "pk_live_…" : "pk_test_…" },
    { part: "webhook_secret", value: webhook, set: setWebhook, placeholder: "whsec_… (optional, filled in automatically when you create a webhook below)" }
  ];

  return (
    <section className={`card stripe-key-card ${mode === "live" ? "stripe-live" : ""}`} aria-labelledby={`stripe-keys-${mode}`}>
      <div className="card-head">
        <span className="card-title" id={`stripe-keys-${mode}`}>
          <KeyRound size={14} /> {MODE_LABEL[mode]}
        </span>
        {mode === "live" ? <span className="chip xsmall tag-red">real money</span> : <span className="chip xsmall tag-green">safe to experiment</span>}
      </div>

      <form onSubmit={(e) => void submit(e)} className="stripe-form" autoComplete="off">
        {parts.map(({ part, value, set, placeholder }) => {
          const info = status[part];
          const id = `stripe-${mode}-${part}`;
          return (
            <div key={part} className="stripe-field">
              <label htmlFor={id}>{PART_LABEL[part]}</label>
              <div className="stripe-field-state small">
                {info.configured ? (
                  <>
                    <span className="chip xsmall tag-green">stored</span>
                    <code>{info.preview}</code>
                    <span className="muted xsmall" title="Non-reversible fingerprint">
                      id {info.fingerprint}
                    </span>
                    <button
                      type="button"
                      className="ghost xsmall danger"
                      onClick={() => onRemove(mode, part)}
                      disabled={busy !== null}
                      aria-label={`Remove ${PART_LABEL[part].toLowerCase()} (${mode})`}
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  </>
                ) : (
                  <span className="chip xsmall">not set</span>
                )}
              </div>
              <input
                id={id}
                name={`${mode}-${part}`}
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                value={value}
                placeholder={info.configured ? "Paste a new value to replace it" : placeholder}
                onChange={(e) => set(e.target.value)}
              />
            </div>
          );
        })}
        <div className="row stripe-actions">
          <button className="primary" type="submit" disabled={busy !== null || !(secret || publishable || webhook)}>
            {busy === `save:${mode}` ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save {mode} keys
          </button>
          <button className="ghost" type="button" onClick={() => onVerify(mode)} disabled={busy !== null || !hasSecret}>
            {busy === `verify:${mode}` ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Verify with Stripe
          </button>
        </div>
      </form>

      <div className="stripe-account" aria-live="polite">
        {account ? (
          <>
            <div className="small">
              <strong>{account.name ?? account.id}</strong> <span className="muted">· {account.id} · {account.country ?? "?"} · {account.default_currency?.toUpperCase() ?? "?"} · checked {relativeTime(account.verified_at)}</span>
            </div>
            <div className="row stripe-flags">
              <Flag ok={account.details_submitted} label="Details submitted" />
              <Flag ok={account.charges_enabled} label="Charges enabled" />
              <Flag ok={account.payouts_enabled} label="Payouts enabled" />
            </div>
            {account.currently_due.length > 0 && (
              <p className="small muted">
                Stripe still needs from you: <code>{account.currently_due.join(", ")}</code>
              </p>
            )}
          </>
        ) : (
          <p className="small muted">{hasSecret ? "Not verified yet. Press “Verify with Stripe” to read the account state." : "Add a secret key to verify the account."}</p>
        )}
      </div>
    </section>
  );
}

export function StripePage() {
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [apps, setApps] = useState<StripeApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState<LiveRequest | null>(null);
  const [liveText, setLiveText] = useState("");
  const [appMode, setAppMode] = useState<Record<string, StripeMode>>({});

  // setup form
  const [setupMode, setSetupMode] = useState<StripeMode>("test");
  const [price, setPrice] = useState({ name: "", amount: "", currency: "eur", interval: "month", tax: "inclusive", lookup: "", service: "", envName: "STRIPE_PRICE_ID" });
  const [hook, setHook] = useState({ url: "", events: "" });
  const [portalUrl, setPortalUrl] = useState("");
  const [priceResult, setPriceResult] = useState<PriceResult | null>(null);
  const [hookResult, setHookResult] = useState<WebhookResult | null>(null);
  const [portalResult, setPortalResult] = useState<PortalResult | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [s, a] = await Promise.all([getStatus({ silent: true }), getApps({ silent: true })]);
      setStatus(s);
      setApps(a.apps);
      setHook((h) => (h.events ? h : { ...h, events: s.default_webhook_events.join("\n") }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run an action; anything that touches live Stripe waits for the typed confirmation first. */
  function guard(mode: StripeMode, title: string, run: () => Promise<void>) {
    if (mode === "live") {
      setLiveText("");
      setLive({ title, run });
    } else void run();
  }

  async function withBusy(key: string, work: () => Promise<void>) {
    setBusy(key);
    try {
      await work();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onSaveKeys(mode: StripeMode, keys: { secretKey?: string; publishableKey?: string; webhookSecret?: string }): Promise<boolean> {
    let ok = false;
    await withBusy(`save:${mode}`, async () => {
      const r = await saveKeys(mode, keys);
      toast.success(r.restart_needed ? `${MODE_LABEL[mode]} keys saved. Connected apps were updated: restart them.` : `${MODE_LABEL[mode]} keys saved and encrypted.`);
      ok = true;
      await load(true);
    });
    return ok;
  }

  async function onRemoveKey(mode: StripeMode, part: KeyPart) {
    const extra = part === "secret_key" ? " Apps connected in this mode are disconnected and their Stripe variables removed." : "";
    const yes = await confirmDialog({
      title: `Remove the ${PART_LABEL[part].toLowerCase()} (${mode})?`,
      message: `It is deleted from ServerHoster. Stripe keeps working with it until you roll it in Stripe.${extra}`,
      confirmLabel: "Remove",
      danger: true
    });
    if (!yes) return;
    await withBusy(`remove:${mode}:${part}`, async () => {
      await removeKeys(mode, part);
      toast.warning(`${PART_LABEL[part]} removed`);
      await load(true);
    });
  }

  async function onVerify(mode: StripeMode) {
    await withBusy(`verify:${mode}`, async () => {
      const r = await verifyKeys(mode);
      toast.success(`Verified: ${r.account.name ?? r.account.id}`);
      await load(true);
    });
  }

  async function connect(app: StripeApp, mode: StripeMode, takeover = false) {
    const run = async () => {
      setBusy(`app:${app.service_id}`);
      try {
        await connectApp(app.service_id, { mode, confirmLive: mode === "live", takeover }, { silent: true });
        toast.success(`${app.name} connected in ${mode} mode. Restart it so it reads the new variables.`);
        await load(true);
      } catch (err) {
        if (err instanceof ApiError && err.code === "env_conflict") {
          const conflicts = ((err.meta?.conflicts as string[] | undefined) ?? []).join(", ");
          setBusy(null);
          const yes = await confirmDialog({
            title: `Replace ${app.name}'s own Stripe variables?`,
            message: `${app.name} already defines ${conflicts} itself. ServerHoster can manage them instead; the old values are deleted.`,
            confirmLabel: "Replace",
            danger: true
          });
          if (yes) await connect(app, mode, true);
        } else toast.error(errorMessage(err));
      } finally {
        setBusy(null);
      }
    };
    guard(mode, `Inject LIVE Stripe keys into ${app.name}`, run);
  }

  async function disconnect(app: StripeApp) {
    const yes = await confirmDialog({
      title: `Disconnect ${app.name} from Stripe?`,
      message: "The Stripe variables ServerHoster added are removed. Restart the app afterwards.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!yes) return;
    await withBusy(`app:${app.service_id}`, async () => {
      await disconnectApp(app.service_id);
      toast.warning(`${app.name} disconnected`);
      await load(true);
    });
  }

  const connectedApps = apps.filter((a) => a.connected && a.mode === setupMode);

  function submitPrice(e: FormEvent) {
    e.preventDefault();
    const minor = toMinorUnits(price.amount, price.currency);
    if (minor === null) {
      toast.error("Enter the price as a number, for example 9 or 9.50");
      return;
    }
    guard(setupMode, "Create a product and price in LIVE Stripe", async () => {
      await withBusy("price", async () => {
        const r = await ensurePrice({
          mode: setupMode,
          name: price.name.trim(),
          unitAmount: minor,
          currency: price.currency.trim().toLowerCase(),
          interval: price.interval,
          taxBehavior: price.tax,
          lookupKey: price.lookup.trim(),
          serviceId: price.service || undefined,
          priceEnvName: price.service ? price.envName.trim() : undefined,
          confirmLive: setupMode === "live"
        });
        setPriceResult(r);
        toast.success(r.created ? "Product and price created" : "Price already existed: nothing changed");
        await load(true);
      });
    });
  }

  function submitHook(e: FormEvent) {
    e.preventDefault();
    const events = hook.events.split(/[\s,]+/).filter(Boolean);
    guard(setupMode, "Create a webhook endpoint in LIVE Stripe", async () => {
      await withBusy("hook", async () => {
        const r = await ensureWebhook({ mode: setupMode, url: hook.url.trim(), events: events.length ? events : undefined, confirmLive: setupMode === "live" });
        setHookResult(r);
        toast.success(r.created ? "Webhook created. Its signing secret was stored encrypted." : r.updated ? "Webhook events updated" : "Webhook already set up");
        await load(true);
      });
    });
  }

  function submitPortal(e: FormEvent) {
    e.preventDefault();
    guard(setupMode, "Configure the customer portal in LIVE Stripe", async () => {
      await withBusy("portal", async () => {
        const r = await ensurePortal({ mode: setupMode, returnUrl: portalUrl.trim() || undefined, confirmLive: setupMode === "live" });
        setPortalResult(r);
        toast.success(r.created ? "Customer portal configured" : "Customer portal updated");
        await load(true);
      });
    });
  }

  const presetCoach = () => {
    setPrice({ name: "OpenAim Coach", amount: "9", currency: "eur", interval: "month", tax: "inclusive", lookup: "openaim_coach_monthly", service: "", envName: "STRIPE_PRICE_ID" });
  };

  const liveReady = liveText === "LIVE";
  const modes = useMemo(() => (["test", "live"] as StripeMode[]), []);

  return (
    <div className="stripe-page">
      <header className="page-header">
        <div>
          <div className="page-title">Stripe</div>
          <p className="muted">
            Store your Stripe keys once, then connect any app to them and set up its product, webhook and customer portal. Keys are encrypted,
            never shown again, and never leave this server except into the apps you connect.
          </p>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="alert alert-amber" role="alert">
          <AlertTriangle size={18} />
          <div>
            <div className="alert-title">Could not load Stripe status</div>
            <p className="small muted">{error}</p>
          </div>
        </div>
      )}

      <div className="alert alert-amber" role="note">
        <ShieldCheck size={18} />
        <div>
          <div className="alert-title">What only you can do in Stripe</div>
          <p className="small muted">
            An API key cannot complete merchant verification, add payout details or register for tax. Do those in the Stripe Dashboard; the status
            flags below show what is still missing. Start in test mode: nothing here charges real money until you use live keys and confirm.
          </p>
        </div>
      </div>

      {live && (
        <section className="card stripe-live-confirm" role="alertdialog" aria-labelledby="stripe-live-title" aria-describedby="stripe-live-desc">
          <div className="card-head">
            <span className="card-title" id="stripe-live-title">
              <AlertTriangle size={14} /> Live Stripe: {live.title}
            </span>
          </div>
          <p className="small muted" id="stripe-live-desc">
            This affects your real Stripe account and may involve real customers and money. Type <strong>LIVE</strong> to continue.
          </p>
          <div className="row stripe-actions">
            <label htmlFor="stripe-live-input" className="sr-only">
              Type LIVE to confirm
            </label>
            <input id="stripe-live-input" value={liveText} onChange={(e) => setLiveText(e.target.value)} placeholder="LIVE" autoComplete="off" autoFocus />
            <button
              className="danger"
              disabled={!liveReady}
              onClick={() => {
                const run = live.run;
                setLive(null);
                setLiveText("");
                void run();
              }}
            >
              Confirm live change
            </button>
            <button className="ghost" onClick={() => setLive(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <div className="stripe-two">
        {loading && !status
          ? [0, 1].map((i) => <Skeleton key={i} style={{ height: "18rem", width: "100%" }} />)
          : status && modes.map((m) => <KeyCard key={m} mode={m} status={status.modes[m]} busy={busy} onSave={onSaveKeys} onRemove={onRemoveKey} onVerify={onVerify} />)}
      </div>

      <section className="card">
        <div className="card-head">
          <span className="card-title">
            <Plug size={14} /> Apps
          </span>
        </div>
        <p className="small muted">
          Connecting adds <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PUBLISHABLE_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code> (when stored) and{" "}
          <code>STRIPE_MODE</code> to the app as encrypted variables. Restart the app afterwards. Nothing else about the app is changed: its own
          feature switches, such as billing flags, stay as you set them.
        </p>
        <div className="stripe-table-wrap">
          <table className="stripe-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Status</th>
                <th>Stripe</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const chosen = appMode[a.service_id] ?? a.mode ?? "test";
                return (
                  <tr key={a.service_id}>
                    <td>
                      {a.name} <span className="muted xsmall">{a.type}</span>
                    </td>
                    <td className="muted">{a.status}</td>
                    <td>
                      {a.connected ? (
                        <>
                          <span className={`chip xsmall ${a.mode === "live" ? "tag-red" : "tag-green"}`}>{a.mode}</span>
                          {a.restart_needed && <span className="chip xsmall warn-chip">restart needed</span>}
                        </>
                      ) : (
                        <span className="chip xsmall">not connected</span>
                      )}
                    </td>
                    <td className="stripe-row-actions">
                      <label className="sr-only" htmlFor={`stripe-mode-${a.service_id}`}>
                        Stripe mode for {a.name}
                      </label>
                      <select
                        id={`stripe-mode-${a.service_id}`}
                        value={chosen}
                        onChange={(e) => setAppMode({ ...appMode, [a.service_id]: e.target.value as StripeMode })}
                      >
                        <option value="test">test</option>
                        <option value="live">live</option>
                      </select>
                      <button className="primary xsmall" disabled={busy !== null} onClick={() => void connect(a, chosen)}>
                        {busy === `app:${a.service_id}` ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />} {a.connected ? "Update" : "Connect"}
                      </button>
                      {a.connected && (
                        <button className="ghost xsmall danger" disabled={busy !== null} onClick={() => void disconnect(a)}>
                          <Unplug size={12} /> Disconnect
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {apps.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted small">
                    No services yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="stripe-setup-title">
        <div className="card-head">
          <span className="card-title" id="stripe-setup-title">
            <CreditCard size={14} /> Set up billing objects
          </span>
          <div className="row">
            <label htmlFor="stripe-setup-mode" className="small muted">
              Mode
            </label>
            <select id="stripe-setup-mode" value={setupMode} onChange={(e) => setSetupMode(e.target.value as StripeMode)}>
              <option value="test">test</option>
              <option value="live">live (needs confirmation)</option>
            </select>
          </div>
        </div>
        <p className="small muted">
          Each step looks before it creates, so running it again never makes duplicates. Amounts are in the currency you choose (9 means 9.00).
        </p>

        <div className="stripe-steps">
          <form className="stripe-step" onSubmit={submitPrice} aria-label="Product and price">
            <h4>1. Product and recurring price</h4>
            <div className="stripe-grid">
              <label>
                Product name
                <input value={price.name} onChange={(e) => setPrice({ ...price, name: e.target.value })} required maxLength={100} />
              </label>
              <label>
                Amount
                <input inputMode="decimal" value={price.amount} onChange={(e) => setPrice({ ...price, amount: e.target.value })} placeholder="9" required />
              </label>
              <label>
                Currency
                <input value={price.currency} onChange={(e) => setPrice({ ...price, currency: e.target.value })} maxLength={3} required />
              </label>
              <label>
                Every
                <select value={price.interval} onChange={(e) => setPrice({ ...price, interval: e.target.value })}>
                  <option value="month">month</option>
                  <option value="year">year</option>
                  <option value="week">week</option>
                  <option value="day">day</option>
                </select>
              </label>
              <label>
                Tax
                <select value={price.tax} onChange={(e) => setPrice({ ...price, tax: e.target.value })}>
                  <option value="inclusive">tax included in the price</option>
                  <option value="exclusive">tax added on top</option>
                </select>
              </label>
              <label>
                Lookup key
                <input value={price.lookup} onChange={(e) => setPrice({ ...price, lookup: e.target.value })} placeholder="openaim_coach_monthly" required />
              </label>
              <label>
                Give the price id to
                <select value={price.service} onChange={(e) => setPrice({ ...price, service: e.target.value })}>
                  <option value="">no app</option>
                  {connectedApps.map((a) => (
                    <option key={a.service_id} value={a.service_id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                as variable
                <input value={price.envName} onChange={(e) => setPrice({ ...price, envName: e.target.value })} disabled={!price.service} />
              </label>
            </div>
            <div className="row stripe-actions">
              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === "price" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create or find price
              </button>
              <button className="ghost" type="button" onClick={presetCoach}>
                Fill in OpenAim Coach (9 EUR / month, tax included)
              </button>
            </div>
            {priceResult && (
              <p className="small stripe-result" role="status">
                <span className={`chip xsmall ${priceResult.created ? "tag-green" : ""}`}>{priceResult.created ? "created" : "already existed"}</span>{" "}
                price <code>{priceResult.price.id}</code> · product <code>{priceResult.product.id}</code>
                {priceResult.injected && <> · written to the app as <code>{priceResult.injected.env}</code>; restart it</>}
              </p>
            )}
          </form>

          <form className="stripe-step" onSubmit={submitHook} aria-label="Webhook endpoint">
            <h4>2. Webhook endpoint</h4>
            <div className="stripe-grid">
              <label className="stripe-wide">
                Endpoint URL (https)
                <input type="url" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://coach.mast3kmedia.dk/v1/billing/webhook" required />
              </label>
              <label className="stripe-wide">
                Events (one per line)
                <textarea rows={5} value={hook.events} onChange={(e) => setHook({ ...hook, events: e.target.value })} />
              </label>
            </div>
            <p className="small muted">Stripe shows the signing secret once, when the endpoint is created. ServerHoster stores it encrypted and puts it into connected apps; it is never displayed.</p>
            <div className="row stripe-actions">
              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === "hook" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create or update webhook
              </button>
            </div>
            {hookResult && (
              <p className="small stripe-result" role="status">
                <span className={`chip xsmall ${hookResult.created ? "tag-green" : ""}`}>{hookResult.created ? "created" : hookResult.updated ? "updated" : "already existed"}</span>{" "}
                <code>{hookResult.endpoint.id}</code> · signing secret {hookResult.secret_stored ? "stored" : "not available"}
                {hookResult.note && <> · {hookResult.note}</>}
                {hookResult.restart_needed && <> · restart the connected app</>}
              </p>
            )}
          </form>

          <form className="stripe-step" onSubmit={submitPortal} aria-label="Customer portal">
            <h4>3. Customer portal</h4>
            <div className="stripe-grid">
              <label className="stripe-wide">
                Return URL (optional, https)
                <input type="url" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} placeholder="https://coach.mast3kmedia.dk/account" />
              </label>
            </div>
            <p className="small muted">Customers can cancel at the end of the period, update their payment method and see invoices.</p>
            <div className="row stripe-actions">
              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === "portal" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create or update portal
              </button>
            </div>
            {portalResult && (
              <p className="small stripe-result" role="status">
                <span className={`chip xsmall ${portalResult.created ? "tag-green" : ""}`}>{portalResult.created ? "created" : "updated"}</span> <code>{portalResult.portal.id}</code>
              </p>
            )}
          </form>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">For agents and scripts</span>
        </div>
        <p className="small muted">
          The same actions are available over REST under <code>/api/stripe/…</code> and as MCP tools on the operator endpoint:{" "}
          <code>stripe_status</code>, <code>stripe_verify</code>, <code>stripe_list_apps</code>, <code>stripe_connect_app</code>,{" "}
          <code>stripe_disconnect_app</code>, <code>stripe_ensure_product_price</code>, <code>stripe_ensure_webhook</code>,{" "}
          <code>stripe_ensure_portal</code>. Keys can only be entered here; no tool accepts or returns one, and live changes need{" "}
          <code>confirmLive: true</code>.
        </p>
      </section>
    </div>
  );
}
