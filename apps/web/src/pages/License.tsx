import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Ban,
  CalendarPlus,
  Mail,
  BookOpen
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";

type Overview = {
  products: number;
  keys_active: number;
  keys_revoked: number;
  activations: number;
  validations_24h: number;
  public_url: string | null;
  validate_url: string | null;
};

type Product = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  max_activations: number;
  license_count?: number;
};

type LicenseKey = {
  id: string;
  product_id: string;
  product_slug?: string;
  product_name?: string;
  key_prefix: string;
  customer_email: string | null;
  customer_name: string | null;
  status: "active" | "revoked" | "expired";
  expires_at: string | null;
  max_activations: number | null;
  activation_count: number;
  created_at: string;
};

type Activation = {
  id: string;
  license_id: string;
  product_slug?: string;
  key_prefix?: string;
  device_fingerprint: string;
  device_name: string | null;
  last_seen_at: string;
  created_at: string;
  deactivated_at: string | null;
};

type ClientIntegration = {
  validate_url: string;
  public_url: string | null;
  example: { curl: string; env: string };
};

type Tab = "overview" | "products" | "keys" | "activations" | "client";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy");
  }
}

export function LicensePage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [keys, setKeys] = useState<LicenseKey[]>([]);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [client, setClient] = useState<ClientIntegration | null>(null);
  const [publicUrlDraft, setPublicUrlDraft] = useState("");
  const [mintedKey, setMintedKey] = useState<string | null>(null);

  // Product form
  const [prodSlug, setProdSlug] = useState("");
  const [prodName, setProdName] = useState("");
  const [prodMax, setProdMax] = useState("1");

  // Key form
  const [keyProductId, setKeyProductId] = useState("");
  const [keyEmail, setKeyEmail] = useState("");
  const [keyName, setKeyName] = useState("");
  const [keyExpires, setKeyExpires] = useState("");
  const [keyMax, setKeyMax] = useState("");

  // Inject helper
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [injectProjectId, setInjectProjectId] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [ov, prods, ks, acts, ci, projs] = await Promise.all([
        api<Overview>("/license/overview", { silent: true }),
        api<{ items: Product[] }>("/license/products", { silent: true }),
        api<{ items: LicenseKey[] }>("/license/keys", { silent: true }),
        api<{ items: Activation[] }>("/license/activations", { silent: true }),
        api<ClientIntegration>("/license/client-integration", { silent: true }),
        api<Array<{ id: string; name: string }>>("/projects", { silent: true }).catch(() => [])
      ]);
      setOverview(ov);
      setPublicUrlDraft(ov.public_url ?? "");
      setProducts(prods.items);
      setKeys(ks.items);
      setActivations(acts.items);
      setClient(ci);
      setProjects(projs);
      setKeyProductId((cur) => cur || prods.items[0]?.id || "");
      setInjectProjectId((cur) => cur || projs[0]?.id || "");
    } catch {
      /* toasted */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function savePublicUrl(): Promise<void> {
    setBusy("public-url");
    try {
      await api("/license/public-url", {
        method: "POST",
        body: JSON.stringify({ url: publicUrlDraft.trim() })
      });
      toast.success("License public URL saved");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function createProduct(): Promise<void> {
    if (!prodSlug.trim() || !prodName.trim()) {
      toast.error("Slug and name are required");
      return;
    }
    setBusy("product");
    try {
      await api("/license/products", {
        method: "POST",
        body: JSON.stringify({
          slug: prodSlug.trim(),
          name: prodName.trim(),
          maxActivations: Number(prodMax) || 1
        })
      });
      setProdSlug("");
      setProdName("");
      setProdMax("1");
      toast.success("Product created");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function removeProduct(p: Product): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete product "${p.name}"?`,
      message: "Only products with no keys can be deleted.",
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    setBusy(`del-${p.id}`);
    try {
      await api(`/license/products/${p.id}`, { method: "DELETE" });
      toast.success("Product deleted");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function generateKey(): Promise<void> {
    if (!keyProductId) {
      toast.error("Select a product");
      return;
    }
    setBusy("mint");
    try {
      const res = await api<{ key: string; record: LicenseKey; warning: string }>("/license/keys", {
        method: "POST",
        body: JSON.stringify({
          productId: keyProductId,
          customerEmail: keyEmail.trim() || undefined,
          customerName: keyName.trim() || undefined,
          expiresAt: keyExpires.trim() || null,
          maxActivations: keyMax.trim() ? Number(keyMax) : null
        })
      });
      setMintedKey(res.key);
      toast.success("License key minted — copy it now");
      setKeyEmail("");
      setKeyName("");
      setKeyExpires("");
      setKeyMax("");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(k: LicenseKey): Promise<void> {
    const ok = await confirmDialog({
      title: "Revoke this license key?",
      message: `${k.key_prefix}… will immediately fail validation.`,
      confirmLabel: "Revoke",
      danger: true
    });
    if (!ok) return;
    setBusy(`rev-${k.id}`);
    try {
      await api(`/license/keys/${k.id}/revoke`, { method: "POST", body: "{}" });
      toast.success("License revoked");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function extendKey(k: LicenseKey): Promise<void> {
    const next = window.prompt(
      "New expiry (ISO datetime), or leave empty for never:",
      k.expires_at ?? ""
    );
    if (next === null) return;
    setBusy(`ext-${k.id}`);
    try {
      await api(`/license/keys/${k.id}/extend`, {
        method: "POST",
        body: JSON.stringify({ expiresAt: next.trim() || null })
      });
      toast.success("License expiry updated");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function emailKey(k: LicenseKey): Promise<void> {
    if (!mintedKey) {
      toast.error("Plaintext key is only available right after mint — generate a new key to email it.");
      return;
    }
    const to = k.customer_email || window.prompt("Recipient email:") || "";
    if (!to) return;
    setBusy(`mail-${k.id}`);
    try {
      const res = await api<{ message: string }>(`/license/keys/${k.id}/email`, {
        method: "POST",
        body: JSON.stringify({ to, key: mintedKey })
      });
      toast.success(res.message);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function deactivate(a: Activation): Promise<void> {
    const ok = await confirmDialog({
      title: "Deactivate this seat?",
      message: `Fingerprint ${a.device_fingerprint} will free a seat.`,
      confirmLabel: "Deactivate",
      danger: true
    });
    if (!ok) return;
    setBusy(`act-${a.id}`);
    try {
      await api(`/license/activations/${a.id}/deactivate`, { method: "POST", body: "{}" });
      toast.success("Activation deactivated");
      await refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function injectUrl(): Promise<void> {
    if (!injectProjectId) return;
    setBusy("inject");
    try {
      const res = await api<{ key: string; value: string }>("/license/inject-server-url", {
        method: "POST",
        body: JSON.stringify({ projectId: injectProjectId })
      });
      toast.success(`Set ${res.key} on project`);
      await copyText(`${res.key}=${res.value}`);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "products", label: "Products" },
    { id: "keys", label: "Keys" },
    { id: "activations", label: "Activations" },
    { id: "client", label: "Client integration" }
  ];

  return (
    <div className="license-page">
      <header className="page-header">
        <h2>License Server</h2>
        <div className="row" style={{ gap: "0.6rem" }}>
          <StatusBadge status="running" label="v1" />
          <button className="ghost xsmall" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      <div className="row license-tabs" style={{ gap: "0.35rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "primary small" : "ghost small"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <section className="card">
            <div className="section-title">
              <h3>
                <Shield size={15} /> Overview
              </h3>
            </div>
            <div className="license-kv">
              <div>
                <span className="muted tiny uppercase">Products</span>
                <span>{overview?.products ?? "—"}</span>
              </div>
              <div>
                <span className="muted tiny uppercase">Active keys</span>
                <span>{overview?.keys_active ?? "—"}</span>
              </div>
              <div>
                <span className="muted tiny uppercase">Revoked</span>
                <span>{overview?.keys_revoked ?? "—"}</span>
              </div>
              <div>
                <span className="muted tiny uppercase">Activations</span>
                <span>{overview?.activations ?? "—"}</span>
              </div>
              <div>
                <span className="muted tiny uppercase">Validations (24h)</span>
                <span>{overview?.validations_24h ?? "—"}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-title">
              <h3>Public URL</h3>
            </div>
            <p className="muted small">
              Optional https origin that reaches this control plane. Clients validate at{" "}
              <code>/license/v1/validate</code>.
            </p>
            <div className="row" style={{ marginTop: "0.75rem", gap: "0.5rem", flexWrap: "wrap" }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="https://license.example.com"
                value={publicUrlDraft}
                onChange={(e) => setPublicUrlDraft(e.target.value)}
              />
              <button className="primary small" disabled={busy !== null} onClick={() => void savePublicUrl()}>
                {busy === "public-url" ? <Loader2 size={14} className="spin" /> : null} Save
              </button>
              {overview?.validate_url && (
                <button className="ghost small" onClick={() => void copyText(overview.validate_url!)}>
                  <Copy size={14} /> Copy validate URL
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {tab === "products" && (
        <section className="card">
          <div className="section-title">
            <h3>Products</h3>
          </div>
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <input
              className="input"
              placeholder="slug"
              value={prodSlug}
              onChange={(e) => setProdSlug(e.target.value)}
              style={{ width: 140 }}
            />
            <input
              className="input"
              placeholder="Display name"
              value={prodName}
              onChange={(e) => setProdName(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <input
              className="input"
              placeholder="Max seats"
              value={prodMax}
              onChange={(e) => setProdMax(e.target.value)}
              style={{ width: 100 }}
            />
            <button className="primary small" disabled={busy !== null} onClick={() => void createProduct()}>
              {busy === "product" ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create
            </button>
          </div>
          {products.length === 0 ? (
            <div className="muted italic small">No products yet.</div>
          ) : (
            <div className="license-list">
              {products.map((p) => (
                <div key={p.id} className="license-row">
                  <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                    <span className="license-title">
                      {p.name} <span className="muted tiny">({p.slug})</span>
                    </span>
                    <span className="muted tiny">
                      {p.max_activations} seat{p.max_activations === 1 ? "" : "s"} · {p.license_count ?? 0}{" "}
                      keys
                    </span>
                  </div>
                  <button
                    className="ghost tiny danger"
                    disabled={busy !== null}
                    onClick={() => void removeProduct(p)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "keys" && (
        <>
          <section className="card">
            <div className="section-title">
              <h3>
                <KeyRound size={15} /> Generate key
              </h3>
            </div>
            <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <select
                className="input"
                value={keyProductId}
                onChange={(e) => setKeyProductId(e.target.value)}
                style={{ minWidth: 160 }}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Customer email"
                value={keyEmail}
                onChange={(e) => setKeyEmail(e.target.value)}
              />
              <input
                className="input"
                placeholder="Customer name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Expires (ISO, optional)"
                value={keyExpires}
                onChange={(e) => setKeyExpires(e.target.value)}
              />
              <input
                className="input"
                placeholder="Seat override"
                value={keyMax}
                onChange={(e) => setKeyMax(e.target.value)}
                style={{ width: 110 }}
              />
              <button className="primary small" disabled={busy !== null || !products.length} onClick={() => void generateKey()}>
                {busy === "mint" ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Mint
              </button>
            </div>
            {mintedKey && (
              <div className="license-note" style={{ marginTop: "1rem" }}>
                <strong>Copy now — shown once:</strong>
                <code style={{ display: "block", marginTop: "0.4rem", wordBreak: "break-all" }}>
                  {mintedKey}
                </code>
                <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button className="ghost small" onClick={() => void copyText(mintedKey)}>
                    <Copy size={14} /> Copy
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-title">
              <h3>Keys</h3>
              <span className="chip">{keys.length}</span>
            </div>
            {keys.length === 0 ? (
              <div className="muted italic small">No keys yet.</div>
            ) : (
              <div className="license-list">
                {keys.map((k) => (
                  <div key={k.id} className="license-row">
                    <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                      <span className="license-title">
                        <code>{k.key_prefix}…</code>{" "}
                        <StatusBadge
                          status={
                            k.status === "active" ? "running" : k.status === "revoked" ? "crashed" : "stopped"
                          }
                          label={k.status}
                        />
                      </span>
                      <span className="muted tiny">
                        {[k.product_name, k.customer_email, k.expires_at ? `exp ${k.expires_at}` : "no expiry"]
                          .filter(Boolean)
                          .join(" · ")}{" "}
                        · {k.activation_count} seats
                      </span>
                    </div>
                    <button
                      className="ghost tiny"
                      disabled={busy !== null || k.status === "revoked"}
                      onClick={() => void extendKey(k)}
                      title="Extend"
                    >
                      <CalendarPlus size={12} />
                    </button>
                    <button
                      className="ghost tiny"
                      disabled={busy !== null}
                      onClick={() => void emailKey(k)}
                      title="Email key"
                    >
                      <Mail size={12} />
                    </button>
                    <button
                      className="ghost tiny danger"
                      disabled={busy !== null || k.status === "revoked"}
                      onClick={() => void revokeKey(k)}
                      title="Revoke"
                    >
                      <Ban size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {tab === "activations" && (
        <section className="card">
          <div className="section-title">
            <h3>Activations</h3>
            <span className="chip">{activations.filter((a) => !a.deactivated_at).length} active</span>
          </div>
          {activations.length === 0 ? (
            <div className="muted italic small">No activations yet.</div>
          ) : (
            <div className="license-list">
              {activations.map((a) => (
                <div key={a.id} className="license-row">
                  <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                    <span className="license-title">
                      {a.device_name || a.device_fingerprint}
                      {a.deactivated_at && <span className="chip warn">deactivated</span>}
                    </span>
                    <span className="muted tiny">
                      {[a.product_slug, a.key_prefix ? `${a.key_prefix}…` : null, a.last_seen_at]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  {!a.deactivated_at && (
                    <button
                      className="ghost tiny danger"
                      disabled={busy !== null}
                      onClick={() => void deactivate(a)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "client" && (
        <>
          <section className="card">
            <div className="section-title">
              <h3>
                <BookOpen size={15} /> Client integration
              </h3>
            </div>
            <p className="muted small">
              Apps call the public validate endpoint with a license key and device fingerprint.
              Keys are hashed at rest; plaintext is never returned after mint.
            </p>
            {client && (
              <>
                <div className="license-kv" style={{ marginTop: "0.75rem" }}>
                  <div>
                    <span className="muted tiny uppercase">Validate URL</span>
                    <span className="license-paths">{client.validate_url}</span>
                  </div>
                </div>
                <pre className="license-log" style={{ marginTop: "0.75rem" }}>
                  {client.example.curl}
                </pre>
                <button
                  className="ghost small"
                  style={{ marginTop: "0.5rem" }}
                  onClick={() => void copyText(client.example.curl)}
                >
                  <Copy size={14} /> Copy curl
                </button>
                <pre className="license-log" style={{ marginTop: "0.75rem" }}>
                  {client.example.env}
                </pre>
              </>
            )}
          </section>

          <section className="card">
            <div className="section-title">
              <h3>Inject LICENSE_SERVER_URL</h3>
            </div>
            <p className="muted small">
              Writes the license server base URL into a project&apos;s shared env (Secrets inventory).
            </p>
            <div className="row" style={{ gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
              <select
                className="input"
                value={injectProjectId}
                onChange={(e) => setInjectProjectId(e.target.value)}
                style={{ minWidth: 180 }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="primary small"
                disabled={busy !== null || !injectProjectId}
                onClick={() => void injectUrl()}
              >
                {busy === "inject" ? <Loader2 size={14} className="spin" /> : null} Inject
              </button>
            </div>
          </section>
        </>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .license-page .license-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-top: 0.75rem; }
        .license-page .license-kv > div { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
        .license-page .license-kv span:last-child { font-size: 0.85rem; font-weight: 500; }
        .license-page .uppercase { text-transform: uppercase; letter-spacing: 0.04em; }
        .license-page .license-list { display: flex; flex-direction: column; margin-top: 0.5rem; }
        .license-page .license-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.7rem 0; border-bottom: 1px solid var(--border-subtle); }
        .license-page .license-row:last-child { border-bottom: none; }
        .license-page .license-title { font-size: 0.88rem; font-weight: 600; display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .license-page .license-paths { font-family: var(--font-mono, monospace); font-size: 0.78rem; word-break: break-all; }
        .license-page .license-note { padding: 0.6rem 0.8rem; border-radius: 8px; background: var(--warning-soft); color: var(--warning); }
        .license-page .license-log { margin-top: 0.5rem; max-height: 220px; overflow: auto; font-size: 0.72rem; line-height: 1.5; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
        .license-page .section-title h3 { display: inline-flex; align-items: center; gap: 0.45rem; }
        .license-page .chip.warn { background: var(--warning-soft); color: var(--warning); border-color: var(--warning); }
        .license-page .spin { animation: license-spin 1s linear infinite; }
        @keyframes license-spin { to { transform: rotate(360deg); } }
      `
        }}
      />
    </div>
  );
}
