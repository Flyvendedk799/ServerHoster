import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, Copy, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";

type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

type CreatedToken = ApiToken & { token: string };

const EXPIRY_OPTIONS = [
  { value: "", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" }
];

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Settings → API tokens. Long-lived, revocable credentials for scripts and
 * agents (shk_…). Unlike a dashboard session they survive restarts; the
 * plaintext is shown once, right after creation, and never again.
 */
export function ApiTokensPanel() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A ref, not just state: a second Enter can arrive before the re-render that
  // disables the button, and every duplicate request mints a real token.
  const creatingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ tokens: ApiToken[] }>("/auth/tokens", { silent: true });
      setTokens(res.tokens);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Could not load API tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (creatingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the token a name so you can tell it apart later");
      return;
    }
    creatingRef.current = true;
    setBusy(true);
    try {
      const result = await api<CreatedToken>("/auth/tokens", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, expiresInDays: expiry ? Number(expiry) : null })
      });
      setCreated(result);
      setName("");
      void load();
    } catch {
      /* toasted by api() */
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  }

  async function revoke(token: ApiToken) {
    const ok = await confirmDialog({
      title: `Revoke ${token.name}?`,
      message: "Anything using this token loses access immediately. This cannot be undone.",
      confirmLabel: "Revoke",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/auth/tokens/${token.id}`, { method: "DELETE" });
      toast.success(`${token.name} revoked`);
      if (created?.id === token.id) setCreated(null);
      void load();
    } catch {
      /* toasted */
    }
  }

  function copyCreated() {
    if (!created) return;
    const manual = () => toast.error("Copy is unavailable here — select the token and copy it manually");
    try {
      if (!navigator.clipboard?.writeText) {
        manual();
        return;
      }
      navigator.clipboard
        .writeText(created.token)
        .then(() => toast.success("Token copied to clipboard"))
        .catch(manual);
    } catch {
      manual();
    }
  }

  return (
    <div className="form-stack api-tokens-panel">
      <div className="card">
        <div className="row">
          <KeyRound className="text-accent" size={20} />
          <h3>Create an API token</h3>
        </div>
        <p className="muted small" style={{ margin: "1rem 0" }}>
          For scripts and automation agents. A token works until you revoke it (or it expires) and survives
          restarts, unlike a dashboard login. It has full API access but can never create, list or revoke
          other tokens. On the host you can also run <code className="text-accent">survhub token create</code>
          .
        </p>

        <label className="small font-bold" htmlFor="api-token-name">
          Name
        </label>
        <input
          id="api-token-name"
          type="text"
          placeholder="e.g. claude-automation"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void create();
          }}
          style={{ marginTop: "0.4rem" }}
        />

        <label className="small font-bold" htmlFor="api-token-expiry" style={{ marginTop: "1rem" }}>
          Expiry
        </label>
        <select
          id="api-token-expiry"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          style={{ marginTop: "0.4rem" }}
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <div className="footer-actions">
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Create token
          </button>
        </div>

        {created && (
          <div className="api-token-created">
            <p className="small api-token-warning">
              <AlertTriangle size={14} />
              Copy this token now. It is shown only once and cannot be recovered.
            </p>
            <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
              <div className="ssh-box" style={{ flex: 1 }}>
                <code className="api-token-secret">{created.token}</code>
              </div>
              <button className="ghost small font-bold" onClick={copyCreated}>
                <Copy size={14} /> Copy
              </button>
            </div>
            <p className="muted tiny" style={{ marginTop: "0.5rem" }}>
              Use as: <code className="text-accent">Authorization: Bearer &lt;token&gt;</code>
            </p>
            <button className="ghost small" onClick={() => setCreated(null)} style={{ marginTop: "0.5rem" }}>
              <Check size={14} /> I have stored it
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row">
          <Bot className="text-muted" size={20} />
          <h3>API tokens</h3>
        </div>
        {loadError ? (
          <div className="api-token-load-error" role="alert">
            <p className="small api-token-warning">
              <AlertTriangle size={14} />
              Could not load API tokens: {loadError}. The list below may be out of date.
            </p>
            <button className="ghost small" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Retry
            </button>
          </div>
        ) : null}
        {loading && tokens.length === 0 && !loadError ? (
          <p className="muted small" style={{ marginTop: "1rem" }}>
            <Loader2 size={14} className="spin" /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          loadError ? null : (
            <p className="muted small" style={{ marginTop: "1rem" }}>
              No API tokens yet.
            </p>
          )
        ) : (
          <ul className="api-token-list">
            {tokens.map((token) => (
              <li key={token.id} className={token.status === "active" ? "" : "inactive"}>
                <div className="column" style={{ gap: "2px", alignItems: "flex-start" }}>
                  <span className="font-bold small">
                    {token.name} <code className="tiny muted">{token.tokenPrefix}…</code>
                  </span>
                  <span className="tiny muted">
                    {token.status === "active" ? "active" : token.status} · created{" "}
                    {shortDate(token.createdAt)} · last used {relativeTime(token.lastUsedAt)} ·{" "}
                    {token.expiresAt ? `expires ${shortDate(token.expiresAt)}` : "no expiry"}
                  </span>
                </div>
                {token.status !== "revoked" && (
                  <button className="ghost small danger ml-auto" onClick={() => revoke(token)}>
                    <Trash2 size={14} /> Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .api-tokens-panel select, .api-tokens-panel input[type="text"] { width: 100%; }
        .api-tokens-panel .api-token-created { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
        .api-tokens-panel .api-token-created code { overflow-wrap: anywhere; }
        .api-tokens-panel .api-token-secret { user-select: all; }
        .api-tokens-panel .api-token-load-error { margin-top: 1rem; }
        .api-tokens-panel .api-token-warning { display: flex; gap: 0.45rem; align-items: center; color: var(--warning); margin-bottom: 0.5rem; }
        .api-tokens-panel .api-token-list { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
        .api-tokens-panel .api-token-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
        .api-tokens-panel .api-token-list li.inactive { opacity: 0.6; }
      `
        }}
      />
    </div>
  );
}
