import { useEffect, useState } from "react";
import { Mail, Server, Loader2, CheckCircle2, AlertCircle, Plus, Trash2, Send, RotateCw, Inbox, ArrowRight } from "lucide-react";

import { api } from "../lib/api";
import { toast } from "../lib/toast";

type EmailSettings = {
  host: string;
  port: string;
  user: string;
  from: string;
  from_name: string;
  password_set: boolean;
  configured: boolean;
};

type ProjectRow = { id: string; name: string; applied: boolean; from: string };

/** Per-stack outcome of enabling email on a Supabase-backed project. */
type ApplyStack = {
  resource_id: string;
  name: string;
  skipped?: string;
  error?: string;
  restart_required?: boolean;
  warnings?: string[];
};
type ApplyResult = { message?: string; supabase_stacks?: ApplyStack[] };

type ZoneRow = { id: string; name: string };
type RuleRow = { id: string; to: string; dest: string; enabled: boolean; name: string };
type ReceivingData = {
  catch_all: { enabled: boolean; dest: string };
  rules: RuleRow[];
  destinations: { email: string; verified: boolean }[];
};

export function EmailPage() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [form, setForm] = useState({
    host: "smtp.mx.cloudflare.net",
    port: "465",
    user: "api_token",
    from: "",
    fromName: "",
    password: ""
  });
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [appFrom, setAppFrom] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Receiving (Cloudflare Email Routing)
  const [rcvConfigured, setRcvConfigured] = useState(false);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [rcvZone, setRcvZone] = useState("");
  const [rcvData, setRcvData] = useState<ReceivingData | null>(null);
  const [rcvLoading, setRcvLoading] = useState(false);
  const [fwMode, setFwMode] = useState<"all" | "specific">("all");
  const [fwLocal, setFwLocal] = useState("");
  const [fwTo, setFwTo] = useState("");

  async function load() {
    try {
      const [s, p] = await Promise.all([
        api<EmailSettings>("/email/settings", { silent: true }),
        api<ProjectRow[]>("/email/projects", { silent: true })
      ]);
      setSettings(s);
      setForm({
        host: s.host || "smtp.mx.cloudflare.net",
        port: s.port || "465",
        user: s.user || "api_token",
        from: s.from || "",
        fromName: s.from_name || "",
        password: ""
      });
      setProjects(p);
      setAppFrom(Object.fromEntries(p.map((pr) => [pr.id, pr.from || s.from || ""])));
      if (!testTo && s.from) setTestTo(s.from);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    void loadReceiving();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings() {
    if (!form.host.trim() || !form.from.trim()) {
      toast.error("Host and Default From are required");
      return;
    }
    setBusy("save");
    try {
      await api("/email/settings", {
        method: "PUT",
        body: JSON.stringify({
          host: form.host,
          port: form.port,
          user: form.user,
          from: form.from,
          fromName: form.fromName,
          password: form.password ? form.password : undefined
        })
      });
      toast.success("SMTP credentials saved");
      setForm((f) => ({ ...f, password: "" }));
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!testTo.trim()) {
      toast.error("Enter a recipient address");
      return;
    }
    setBusy("test");
    try {
      const res = await api<{ ok: boolean; message?: string }>("/email/test", {
        method: "POST",
        body: JSON.stringify({ to: testTo.trim() })
      });
      toast.success(res.message || `Test email sent to ${testTo.trim()}`);
    } catch {
      /* toasted with the server's 502 detail */
    } finally {
      setBusy(null);
    }
  }

  async function applyApp(id: string) {
    setBusy(`app-${id}`);
    try {
      const res = (await api(`/email/apply/${id}`, {
        method: "POST",
        body: JSON.stringify({ from: appFrom[id]?.trim() || undefined })
      })) as ApplyResult;
      toast.success(res?.message || "Email enabled — redeploy/restart that app's services to apply");
      // A Supabase-backed app's auth mail comes from GoTrue, not from SMTP_*.
      // Enabling email rewrites its config.toml, but a running stack keeps the
      // old settings until it is restarted — and enable_confirmations is a
      // product decision we deliberately never flip. Both are silent unless we
      // say so here, which is exactly how signup mail went missing before.
      for (const stack of res?.supabase_stacks ?? []) {
        if (stack.skipped) toast.info(`${stack.name}: ${stack.skipped}`);
        else if (stack.error) toast.error(`${stack.name}: ${stack.error}`);
        else if (stack.restart_required) toast.info(`Restart the "${stack.name}" resource to send auth mail`);
        for (const warning of stack.warnings ?? []) toast.warning(`${stack.name}: ${warning}`);
      }
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function removeApp(id: string) {
    setBusy(`app-${id}`);
    try {
      await api(`/email/remove/${id}`, { method: "POST", body: JSON.stringify({}) });
      toast.success("Email removed — restart that app's services to apply");
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function restartApp(id: string) {
    setBusy(`restart-${id}`);
    try {
      await api(`/projects/${id}/restart-all`, { method: "POST" });
      toast.success("Restarting services — the new email env is now live once they're back up");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function loadReceiving() {
    try {
      const r = await api<{ configured: boolean; zones: ZoneRow[] }>("/email/receiving/zones", { silent: true });
      setRcvConfigured(r.configured);
      setZones(r.zones);
      if (r.configured && r.zones.length && !rcvZone) {
        setRcvZone(r.zones[0].id);
        void loadZone(r.zones[0].id);
      }
    } catch {
      /* silent */
    }
  }

  async function loadZone(zoneId: string) {
    if (!zoneId) {
      setRcvData(null);
      return;
    }
    setRcvLoading(true);
    try {
      const d = await api<ReceivingData>(`/email/receiving/${zoneId}/rules`, { silent: true });
      setRcvData(d);
    } catch {
      setRcvData(null);
    } finally {
      setRcvLoading(false);
    }
  }

  async function addForward() {
    if (!fwTo.trim()) {
      toast.error("Enter the inbox to forward to");
      return;
    }
    const domain = zones.find((z) => z.id === rcvZone)?.name ?? "";
    const from = fwMode === "specific" && fwLocal.trim() ? `${fwLocal.trim()}@${domain}` : undefined;
    setBusy("forward");
    try {
      const res = await api<{ message?: string }>(`/email/receiving/${rcvZone}/forward`, {
        method: "POST",
        body: JSON.stringify({ to: fwTo.trim(), from })
      });
      toast.success(res.message || "Forwarding set");
      setFwLocal("");
      await loadZone(rcvZone);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(ruleId: string) {
    setBusy(`rule-${ruleId}`);
    try {
      await api(`/email/receiving/${rcvZone}/rules/${ruleId}`, { method: "DELETE" });
      toast.success("Removed");
      await loadZone(rcvZone);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const rcvDomain = zones.find((z) => z.id === rcvZone)?.name ?? "";
  const configured = Boolean(settings?.configured);

  return (
    <div className="email-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Email</h2>
          <p className="muted">Shared SMTP for your apps — configure once, enable per app.</p>
        </div>
      </header>

      {loading ? (
        <div className="form-stack">
          <div className="card" aria-busy="true">
            <div className="skeleton-line" style={{ width: "40%" }} />
            <div className="skeleton-line" style={{ width: "75%" }} />
            <div className="skeleton-line" style={{ width: "60%" }} />
          </div>
        </div>
      ) : (
        <div className="form-stack">
          <div className="card">
            <div className="row">
              <Server className="text-info" size={20} />
              <h3>SMTP credentials</h3>
            </div>
            <p className="muted small" style={{ margin: "0.75rem 0 1rem" }}>
              Shared outbound SMTP (e.g. Cloudflare Email Service) reused by every app you enable below.
            </p>

            <div className="form-row">
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Host</label>
                <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.mx.cloudflare.net" />
              </div>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Port</label>
                <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="465" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Username</label>
                <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="api_token" />
              </div>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Password / API token</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={settings?.password_set ? "•••• (set — leave blank to keep)" : "token"}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Default From</label>
                <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="noreply@yourdomain.com" />
              </div>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">From name</label>
                <input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} placeholder="Your App" />
              </div>
            </div>

            <button className="primary" style={{ marginTop: "1rem" }} onClick={saveSettings} disabled={busy === "save"}>
              {busy === "save" && <Loader2 size={16} className="spin" />} Save credentials
            </button>

            <div className="email-test">
              <label className="tiny uppercase font-bold muted">Send a test email</label>
              <div className="row" style={{ gap: "0.5rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
                <input
                  style={{ flex: "1 1 220px" }}
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                  disabled={!configured}
                />
                <button className="button small" onClick={sendTest} disabled={!configured || busy === "test"} title={!configured ? "Save SMTP credentials first" : undefined}>
                  {busy === "test" ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send test
                </button>
              </div>
              {!configured && <span className="muted tiny">Save SMTP credentials (incl. a Default From) to enable the test.</span>}
            </div>
          </div>

          <div className="card">
            <div className="row">
              <Mail className="text-accent" size={20} />
              <h3>Apps</h3>
            </div>
            <p className="muted small" style={{ margin: "0.75rem 0 1rem" }}>
              Enable email on an app to inject the SMTP env vars into it. Each app can send from its own address (defaults to the shared From). Redeploy/restart the app's services to apply.
            </p>

            {!configured && (
              <div className="row small" style={{ marginBottom: "0.75rem" }}>
                <AlertCircle size={14} className="text-warning" />
                <span className="muted">Save SMTP credentials above before enabling apps.</span>
              </div>
            )}

            <div className="email-apps">
              {projects.map((pr) => (
                <div key={pr.id} className="email-app-row">
                  <div className="row" style={{ gap: "0.6rem", minWidth: 0, flex: "1 1 180px" }}>
                    <span className="font-bold">{pr.name}</span>
                    {pr.applied && (
                      <span className="badge-ok">
                        <CheckCircle2 size={12} /> Enabled
                      </span>
                    )}
                  </div>
                  <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <input
                      className="email-from-input"
                      value={appFrom[pr.id] ?? ""}
                      onChange={(e) => setAppFrom((m) => ({ ...m, [pr.id]: e.target.value }))}
                      placeholder="from@app-domain.com"
                      disabled={!configured || busy === `app-${pr.id}`}
                      title="From address for this app"
                    />
                    <button
                      className="button small"
                      onClick={() => applyApp(pr.id)}
                      disabled={!configured || busy === `app-${pr.id}`}
                      title={!configured ? "Save SMTP credentials first" : undefined}
                    >
                      {busy === `app-${pr.id}` ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} {pr.applied ? "Update" : "Enable"}
                    </button>
                    {pr.applied && (
                      <button
                        className="ghost small"
                        onClick={() => restartApp(pr.id)}
                        disabled={busy === `restart-${pr.id}`}
                        title="Restart this app's services so the email env takes effect"
                      >
                        {busy === `restart-${pr.id}` ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />} Restart to apply
                      </button>
                    )}
                    {pr.applied && (
                      <button className="ghost text-danger small" onClick={() => removeApp(pr.id)} disabled={busy === `app-${pr.id}`}>
                        <Trash2 size={14} /> Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {projects.length === 0 && <p className="muted small">No projects yet.</p>}
            </div>
          </div>

          <div className="card">
            <div className="row">
              <Inbox className="text-info" size={20} />
              <h3>Receiving (forwarding)</h3>
            </div>
            <p className="muted small" style={{ margin: "0.75rem 0 1rem" }}>
              Forward inbound mail for your domains to an inbox — via Cloudflare Email Routing.
            </p>

            {!rcvConfigured ? (
              <div className="row small">
                <AlertCircle size={14} className="text-warning" />
                <span className="muted">Add a Cloudflare token with Email Routing access to enable receiving.</span>
              </div>
            ) : (
              <>
                <div className="form-group" style={{ maxWidth: 320 }}>
                  <label className="tiny uppercase font-bold muted">Domain</label>
                  <select
                    value={rcvZone}
                    onChange={(e) => {
                      setRcvZone(e.target.value);
                      void loadZone(e.target.value);
                    }}
                  >
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </select>
                </div>

                {rcvLoading ? (
                  <p className="muted small" style={{ marginTop: "0.75rem" }}>
                    Loading…
                  </p>
                ) : rcvData ? (
                  <div style={{ marginTop: "1rem" }}>
                    <div className="email-apps">
                      {rcvData.catch_all.enabled && rcvData.catch_all.dest && (
                        <div className="email-app-row">
                          <div className="row" style={{ gap: "0.4rem", minWidth: 0 }}>
                            <span className="font-bold">All mail</span>
                            <ArrowRight size={13} className="muted" />
                            <span className="mono">{rcvData.catch_all.dest}</span>
                            {rcvData.destinations.some((d) => d.email === rcvData.catch_all.dest && !d.verified) && (
                              <span className="badge-warn">pending verification</span>
                            )}
                          </div>
                          <button
                            className="ghost text-danger small"
                            onClick={() => removeRule("catch_all")}
                            disabled={busy === "rule-catch_all"}
                          >
                            <Trash2 size={14} /> Remove
                          </button>
                        </div>
                      )}
                      {rcvData.rules.map((r) => (
                        <div key={r.id} className="email-app-row">
                          <div className="row" style={{ gap: "0.4rem", minWidth: 0 }}>
                            <span className="mono">{r.to}</span>
                            <ArrowRight size={13} className="muted" />
                            <span className="mono">{r.dest}</span>
                            {rcvData.destinations.some((d) => d.email === r.dest && !d.verified) && (
                              <span className="badge-warn">pending verification</span>
                            )}
                          </div>
                          <button
                            className="ghost text-danger small"
                            onClick={() => removeRule(r.id)}
                            disabled={busy === `rule-${r.id}`}
                          >
                            <Trash2 size={14} /> Remove
                          </button>
                        </div>
                      ))}
                      {!rcvData.catch_all.enabled && rcvData.rules.length === 0 && (
                        <p className="muted small">No forwarding rules yet.</p>
                      )}
                    </div>

                    <div className="email-test">
                      <label className="tiny uppercase font-bold muted">Add a forward</label>
                      <div className="row" style={{ gap: "0.5rem", marginTop: "0.35rem", flexWrap: "wrap", alignItems: "center" }}>
                        <select value={fwMode} onChange={(e) => setFwMode(e.target.value as "all" | "specific")} style={{ flex: "0 0 auto" }}>
                          <option value="all">All mail (catch-all)</option>
                          <option value="specific">Specific address</option>
                        </select>
                        {fwMode === "specific" && (
                          <span className="row" style={{ gap: 0, alignItems: "center" }}>
                            <input style={{ width: 110 }} value={fwLocal} onChange={(e) => setFwLocal(e.target.value)} placeholder="hello" />
                            <span className="mono muted" style={{ padding: "0 0.25rem" }}>@{rcvDomain}</span>
                          </span>
                        )}
                        <ArrowRight size={14} className="muted" />
                        <input style={{ flex: "1 1 200px" }} value={fwTo} onChange={(e) => setFwTo(e.target.value)} placeholder="your@inbox.com" />
                        <button className="button small" onClick={addForward} disabled={busy === "forward" || !fwTo.trim()}>
                          {busy === "forward" ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add forward
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="muted small" style={{ marginTop: "0.75rem" }}>
                    Select a domain.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .email-page .form-stack { display: flex; flex-direction: column; gap: 1rem; }
        .email-page .email-apps { display: flex; flex-direction: column; gap: 0.4rem; }
        .email-page .email-app-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.6rem 0.75rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-sunken); }
        .email-page .email-from-input { font-size: 0.8rem; padding: 0.3rem 0.5rem; width: 220px; max-width: 46vw; }
        .email-page .email-test { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
        .email-page .badge-ok { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; font-weight: 700; color: var(--success); background: var(--accent-soft); padding: 0.15rem 0.45rem; border-radius: var(--radius-md); }
        .email-page .badge-warn { display: inline-flex; align-items: center; font-size: 0.65rem; font-weight: 700; color: #b45309; background: rgba(180,83,9,0.14); padding: 0.1rem 0.4rem; border-radius: var(--radius-md); white-space: nowrap; }
        .email-page .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; }
        .email-page .spin { animation: email-spin 0.8s linear infinite; }
        @keyframes email-spin { to { transform: rotate(360deg); } }
        .email-page .skeleton-line { height: 0.9rem; margin: 0.5rem 0; border-radius: var(--radius-md); background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--bg-glass) 50%, var(--bg-sunken) 75%); background-size: 200% 100%; animation: email-shimmer 1.4s ease-in-out infinite; }
        @keyframes email-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      `
        }}
      />
    </div>
  );
}
