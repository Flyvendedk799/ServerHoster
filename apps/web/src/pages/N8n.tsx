import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  Webhook,
  Zap
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";

type N8nStatus = {
  installed: boolean;
  running: boolean;
  state: string;
  reachable: boolean;
  version: string | null;
  port: number;
  dataDir: string;
  publicUrl: string | null;
  openUrl: string | null;
  webhookUrl: string | null;
  autostart: boolean;
  encryptionKeySet: boolean;
  apiKeySet: boolean;
  aiGateway: {
    wired: boolean;
    baseUrl: string | null;
    tokenPreview: string | null;
    gatewayEnabled: boolean;
  };
  updatedAt: string;
};

type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string | null;
};

type N8nEventStarter = {
  event: string;
  label: string;
  description: string;
  installed: boolean;
  webhookUrl: string | null;
};

const POLL_MS = 10000;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy");
  }
}

export function N8nPage() {
  const [status, setStatus] = useState<N8nStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [workflows, setWorkflows] = useState<N8nWorkflow[]>([]);
  const [workflowsMeta, setWorkflowsMeta] = useState<{ available: boolean; error?: string }>({
    available: false
  });
  const [starters, setStarters] = useState<N8nEventStarter[]>([]);
  const [publicUrlDraft, setPublicUrlDraft] = useState("");
  const [webhookDrafts, setWebhookDrafts] = useState<Record<string, string>>({});

  const loadStatus = useCallback(async (): Promise<N8nStatus | null> => {
    try {
      const res = await api<N8nStatus>("/n8n/status", { silent: true });
      setStatus(res);
      setPublicUrlDraft(res.publicUrl ?? "");
      setLoadError(false);
      return res;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  const loadWorkflows = useCallback(async (running: boolean): Promise<void> => {
    if (!running) {
      setWorkflows([]);
      setWorkflowsMeta({ available: false });
      return;
    }
    try {
      const res = await api<{ available: boolean; items: N8nWorkflow[]; error?: string }>(
        "/n8n/workflows",
        { silent: true }
      );
      setWorkflows(res.items);
      setWorkflowsMeta({ available: res.available, error: res.error });
    } catch {
      setWorkflows([]);
      setWorkflowsMeta({ available: false, error: "Failed to load workflows" });
    }
  }, []);

  const loadStarters = useCallback(async (): Promise<void> => {
    try {
      const res = await api<{ items: N8nEventStarter[] }>("/n8n/webhooks", { silent: true });
      setStarters(res.items);
      setWebhookDrafts((prev) => {
        const next = { ...prev };
        for (const s of res.items) {
          if (s.webhookUrl && !next[s.event]) next[s.event] = s.webhookUrl;
        }
        return next;
      });
    } catch {
      /* silent */
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await loadStatus();
    await Promise.all([loadWorkflows(Boolean(res?.running)), loadStarters()]);
  }, [loadStatus, loadWorkflows, loadStarters]);

  useEffect(() => {
    void refresh();
    const intv = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(intv);
  }, [refresh]);

  async function power(action: "start" | "stop" | "restart"): Promise<void> {
    if (action !== "start") {
      const ok = await confirmDialog({
        title: `${action === "stop" ? "Stop" : "Restart"} n8n?`,
        message:
          action === "stop"
            ? "Active workflow executions will be interrupted and the editor will go offline."
            : "Active executions may be interrupted while n8n restarts.",
        confirmLabel: action === "stop" ? "Stop n8n" : "Restart n8n",
        danger: true
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      const res = await api<N8nStatus>("/n8n/power", {
        method: "POST",
        body: JSON.stringify({ action })
      });
      setStatus(res);
      toast.success(`n8n ${action === "stop" ? "stopped" : `${action}ed`}`);
      await loadWorkflows(res.running);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function toggleAutostart(): Promise<void> {
    if (!status) return;
    setBusy("autostart");
    try {
      const res = await api<N8nStatus>("/n8n/autostart", {
        method: "POST",
        body: JSON.stringify({ enabled: !status.autostart })
      });
      setStatus(res);
      toast.success(res.autostart ? "n8n will restart with Docker" : "n8n autostart disabled");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function savePublicUrl(): Promise<void> {
    setBusy("public-url");
    try {
      const res = await api<N8nStatus>("/n8n/public-url", {
        method: "POST",
        body: JSON.stringify({ url: publicUrlDraft.trim() })
      });
      setStatus(res);
      toast.success(res.publicUrl ? "Public URL saved — WEBHOOK_URL updated" : "Public URL cleared");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function bootstrap(): Promise<void> {
    setBusy("bootstrap");
    try {
      const res = await api<N8nStatus>("/n8n/bootstrap", { method: "POST", body: "{}" });
      setStatus(res);
      toast.success("Encryption + API keys ready");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function wireAi(): Promise<void> {
    setBusy("ai");
    try {
      const res = await api<N8nStatus>("/n8n/ai-gateway/wire", { method: "POST", body: "{}" });
      setStatus(res);
      toast.success("AI Gateway wired into n8n");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function loadLogs(): Promise<void> {
    setBusy("logs");
    try {
      const res = await api<{ log: string }>("/n8n/logs?lines=300");
      setLog(res.log);
      setLogOpen(true);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function installStarter(event: string): Promise<void> {
    const url = (webhookDrafts[event] ?? "").trim();
    if (!url) {
      toast.error("Paste the n8n Webhook URL first");
      return;
    }
    setBusy(`wh-${event}`);
    try {
      await api("/n8n/webhooks", {
        method: "POST",
        body: JSON.stringify({ event, webhookUrl: url })
      });
      toast.success("Webhook starter installed");
      await loadStarters();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function removeStarter(event: string): Promise<void> {
    const ok = await confirmDialog({
      title: "Remove webhook starter?",
      message: `LocalSURV will stop forwarding ${event} events to n8n.`,
      confirmLabel: "Remove",
      danger: true
    });
    if (!ok) return;
    setBusy(`wh-${event}`);
    try {
      await api(`/n8n/webhooks/${encodeURIComponent(event)}`, { method: "DELETE" });
      toast.success("Webhook starter removed");
      await loadStarters();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function downloadWorkflow(event: string): Promise<void> {
    try {
      const res = await api<Record<string, unknown>>(
        `/n8n/webhooks/${encodeURIComponent(event)}/workflow.json`
      );
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `localsurv-${event.replace(/\./g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      const suggested = (res.meta as { suggestedUrl?: string } | undefined)?.suggestedUrl;
      if (suggested) {
        setWebhookDrafts((prev) => ({ ...prev, [event]: suggested }));
      }
      toast.success("Workflow JSON downloaded — import it in n8n");
    } catch {
      /* toasted */
    }
  }

  if (loadError && !status) {
    return (
      <div className="n8n-page">
        <header className="page-header">
          <h2>n8n</h2>
        </header>
        <section className="card">
          <div className="empty-state">
            <Activity size={28} />
            <p>Could not reach the control plane for n8n status.</p>
          </div>
        </section>
      </div>
    );
  }

  const running = Boolean(status?.running);
  const badge = !status
    ? "none"
    : status.running
      ? "running"
      : status.state === "absent"
        ? "stopped"
        : status.state === "exited"
          ? "stopped"
          : "stopped";

  return (
    <div className="n8n-page">
      <header className="page-header">
        <h2>n8n</h2>
        <div className="row" style={{ gap: "0.6rem" }}>
          <StatusBadge status={badge} label={status?.state ?? "unknown"} />
          {running && status?.openUrl && (
            <a
              className="ghost xsmall n8n-open"
              href={status.openUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={13} /> Open n8n
            </a>
          )}
          <button className="ghost xsmall" onClick={() => void refresh()} title="Refresh">
            <RotateCw size={13} />
          </button>
        </div>
      </header>

      <section className="card">
        <div className="section-title">
          <h3>Server</h3>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              className="primary small"
              disabled={running || busy !== null}
              onClick={() => void power("start")}
            >
              {busy === "start" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start
            </button>
            <button
              className="ghost small"
              disabled={!status?.installed || busy !== null}
              onClick={() => void power("restart")}
            >
              {busy === "restart" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{" "}
              Restart
            </button>
            <button
              className="ghost small danger"
              disabled={!running || busy !== null}
              onClick={() => void power("stop")}
            >
              {busy === "stop" ? <Loader2 size={14} className="spin" /> : <Square size={14} />} Stop
            </button>
          </div>
        </div>

        <div className="n8n-kv">
          <div>
            <span className="muted tiny uppercase">Image</span>
            <span>{status?.version ?? "n8n:latest"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">API</span>
            <span>
              {status?.reachable ? (
                `127.0.0.1:${status.port}`
              ) : (
                <span className="muted">not responding</span>
              )}
            </span>
          </div>
          <div>
            <span className="muted tiny uppercase">Data</span>
            <span className="n8n-paths">{status?.dataDir ?? "—"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">Restart policy</span>
            <span className="row" style={{ gap: "0.5rem" }}>
              {status?.autostart ? "unless-stopped" : "no"}
              <button
                className="ghost tiny"
                disabled={busy !== null}
                onClick={() => void toggleAutostart()}
              >
                {busy === "autostart" ? <Loader2 size={12} className="spin" /> : <Power size={12} />}
                {status?.autostart ? "Disable" : "Enable"}
              </button>
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <ExternalLink size={15} /> Public exposure
          </h3>
        </div>
        <p className="muted small">
          Set the public https URL that reaches this n8n (via Edge Ingress / tunnel). It becomes{" "}
          <code>WEBHOOK_URL</code> and the Open link.
        </p>
        <div className="row n8n-upload-opts" style={{ marginTop: "0.75rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="https://n8n.example.com"
            value={publicUrlDraft}
            onChange={(e) => setPublicUrlDraft(e.target.value)}
          />
          <button className="primary small" disabled={busy !== null} onClick={() => void savePublicUrl()}>
            {busy === "public-url" ? <Loader2 size={14} className="spin" /> : null} Save
          </button>
          {status?.webhookUrl && (
            <button className="ghost small" onClick={() => void copyText(status.webhookUrl!)}>
              <Copy size={14} /> Copy webhook base
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <KeyRound size={15} /> Secrets &amp; bootstrap
          </h3>
          <button className="ghost small" disabled={busy !== null} onClick={() => void bootstrap()}>
            {busy === "bootstrap" ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}{" "}
            Bootstrap keys
          </button>
        </div>
        <div className="n8n-kv">
          <div>
            <span className="muted tiny uppercase">Encryption key</span>
            <span>{status?.encryptionKeySet ? "Set" : "Missing"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">n8n API key</span>
            <span>{status?.apiKeySet ? "Set" : "Missing"}</span>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: "0.75rem" }}>
          Bootstrap generates <code>N8N_ENCRYPTION_KEY</code> and an API key (stored hashed in
          settings) and reinjects them into the container.
        </p>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Zap size={15} /> AI Gateway
          </h3>
          <button className="primary small" disabled={busy !== null} onClick={() => void wireAi()}>
            {busy === "ai" ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} One-click
            wire
          </button>
        </div>
        <div className="n8n-kv">
          <div>
            <span className="muted tiny uppercase">Wired</span>
            <span>{status?.aiGateway.wired ? "Yes" : "No"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">OPENAI_BASE_URL</span>
            <span className="n8n-paths">{status?.aiGateway.baseUrl ?? "—"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">Token</span>
            <span>{status?.aiGateway.tokenPreview ?? "—"}</span>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: "0.75rem" }}>
          Mints a dedicated AI Gateway consumer token and injects it as{" "}
          <code>OPENAI_API_KEY</code> / <code>OPENAI_BASE_URL</code>. Use OpenAI-compatible nodes
          inside n8n.
        </p>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Activity size={15} /> Workflows
          </h3>
          <span className="chip">{workflows.length}</span>
        </div>
        {!running ? (
          <div className="muted italic small">Start n8n to list workflows.</div>
        ) : !workflowsMeta.available ? (
          <div className="muted italic small">
            {workflowsMeta.error ?? "Workflow API unavailable — bootstrap keys and ensure n8n is reachable."}
          </div>
        ) : workflows.length === 0 ? (
          <div className="muted italic small">No workflows yet.</div>
        ) : (
          <div className="n8n-list">
            {workflows.map((w) => (
              <div key={w.id} className="n8n-row">
                <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <span className="n8n-title">{w.name}</span>
                  <span className="muted tiny">
                    {w.active ? "active" : "inactive"}
                    {w.updatedAt ? ` · ${w.updatedAt}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Webhook size={15} /> LocalSURV event webhooks
          </h3>
        </div>
        <p className="muted small">
          Download a starter workflow, import it in n8n, then paste the production Webhook URL here
          so LocalSURV can forward events (including license.*).
        </p>
        <div className="n8n-list" style={{ marginTop: "0.75rem" }}>
          {starters.map((s) => (
            <div key={s.event} className="n8n-entry">
              <div className="n8n-row">
                <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <span className="n8n-title">
                    {s.label}{" "}
                    {s.installed && <span className="chip">installed</span>}
                  </span>
                  <span className="muted tiny">{s.description}</span>
                </div>
                <button className="ghost tiny" onClick={() => void downloadWorkflow(s.event)}>
                  <Download size={12} /> JSON
                </button>
                {s.installed && (
                  <button
                    className="ghost tiny danger"
                    disabled={busy !== null}
                    onClick={() => void removeStarter(s.event)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div className="row n8n-sub-add">
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 180 }}
                  placeholder="https://…/webhook/localsurv-…"
                  value={webhookDrafts[s.event] ?? ""}
                  onChange={(e) =>
                    setWebhookDrafts((prev) => ({ ...prev, [s.event]: e.target.value }))
                  }
                />
                <button
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() => void installStarter(s.event)}
                >
                  {busy === `wh-${s.event}` ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <Webhook size={12} />
                  )}{" "}
                  Save URL
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>Diagnostics</h3>
          <button className="ghost small" disabled={busy !== null} onClick={() => void loadLogs()}>
            {busy === "logs" ? <Loader2 size={14} className="spin" /> : null}
            {logOpen ? "Refresh logs" : "Load logs"}
          </button>
        </div>
        {logOpen && (
          <pre className="n8n-log">{log || "No logs available."}</pre>
        )}
      </section>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .n8n-page .n8n-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; margin-top: 0.75rem; }
        .n8n-page .n8n-kv > div { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
        .n8n-page .n8n-kv span:last-child { font-size: 0.85rem; font-weight: 500; }
        .n8n-page .uppercase { text-transform: uppercase; letter-spacing: 0.04em; }
        .n8n-page .n8n-list { display: flex; flex-direction: column; margin-top: 0.5rem; }
        .n8n-page .n8n-row { display: flex; align-items: center; gap: 1rem; padding: 0.7rem 0; border-bottom: 1px solid var(--border-subtle); }
        .n8n-page .n8n-row:last-child { border-bottom: none; }
        .n8n-page .n8n-title { font-size: 0.88rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .n8n-page .n8n-paths { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono, monospace); font-size: 0.78rem; }
        .n8n-page .n8n-open { display: inline-flex; align-items: center; gap: 0.35rem; text-decoration: none; }
        .n8n-page .n8n-log { margin-top: 0.75rem; max-height: 420px; overflow: auto; font-size: 0.72rem; line-height: 1.5; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
        .n8n-page .section-title h3 { display: inline-flex; align-items: center; gap: 0.45rem; }
        .n8n-page .n8n-entry { border-bottom: 1px solid var(--border-subtle); }
        .n8n-page .n8n-entry:last-child { border-bottom: none; }
        .n8n-page .n8n-entry .n8n-row { border-bottom: none; }
        .n8n-page .n8n-sub-add { gap: 0.6rem; padding: 0 0 0.75rem 0; flex-wrap: wrap; align-items: center; }
        .n8n-page .spin { animation: n8n-spin 1s linear infinite; }
        @keyframes n8n-spin { to { transform: rotate(360deg); } }
      `
        }}
      />
    </div>
  );
}
