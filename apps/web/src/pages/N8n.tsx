import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  History,
  KeyRound,
  Loader2,
  Mail,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Settings2,
  Square,
  Trash2,
  Upload,
  Webhook,
  Workflow,
  Zap
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";
import { copyText, downloadJson, formatDuration, timeAgo } from "../lib/format";

type N8nConfig = {
  imageTag: string;
  timezone: string;
  pruneEnabled: boolean;
  pruneMaxAgeHours: number;
  runnersEnabled: boolean;
  useSharedSmtp: boolean;
  extraEnv: Record<string, string>;
};

type N8nStatus = {
  installed: boolean;
  running: boolean;
  state: string;
  reachable: boolean;
  ready: boolean;
  version: string | null;
  image: string;
  startedAt: string | null;
  port: number;
  dataDir: string;
  publicUrl: string | null;
  openUrl: string | null;
  webhookUrl: string | null;
  autostart: boolean;
  encryptionKeySet: boolean;
  api: { keySet: boolean; ok: boolean; error: string | null; settingsUrl: string | null };
  config: N8nConfig;
  pendingRestart: boolean;
  aiGateway: {
    wired: boolean;
    baseUrl: string | null;
    tokenPreview: string | null;
    gatewayEnabled: boolean;
  };
  updatedAt: string;
};

type N8nMetrics = {
  available: boolean;
  cpuPercent: number | null;
  memoryMb: number | null;
  memoryLimitMb: number | null;
};

type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  tags: string[];
  nodeCount: number;
  triggers: string[];
  webhooks: Array<{ method: string; path: string; productionUrl: string }>;
  editorUrl: string | null;
};

type N8nExecution = {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  status: string;
  mode: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  retryOf: string | null;
};

type N8nEventStarter = {
  event: string;
  label: string;
  description: string;
  group: string;
  installed: boolean;
  webhookUrl: string | null;
};

type Tab = "overview" | "workflows" | "executions" | "automations" | "settings" | "logs";

const TABS: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "executions", label: "Executions", icon: History },
  { id: "automations", label: "LocalSURV events", icon: Webhook },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "logs", label: "Logs", icon: Square }
];

const POLL_MS = 10000;

function uptime(startedAt: string | null): string {
  if (!startedAt) return "—";
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function execTone(status: string): string {
  if (status === "success") return "ok";
  if (status === "error" || status === "crashed" || status === "failed") return "bad";
  if (status === "running" || status === "waiting" || status === "new") return "busy";
  return "neutral";
}

export function N8nPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === "overview") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  };

  const [status, setStatus] = useState<N8nStatus | null>(null);
  const [metrics, setMetrics] = useState<N8nMetrics | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<N8nWorkflow[]>([]);
  const [workflowsMeta, setWorkflowsMeta] = useState<{ available: boolean; error?: string; loaded: boolean }>({
    available: false,
    loaded: false
  });
  const [starters, setStarters] = useState<N8nEventStarter[]>([]);

  const loadStatus = useCallback(async (): Promise<N8nStatus | null> => {
    try {
      const res = await api<N8nStatus>("/n8n/status", { silent: true });
      setStatus(res);
      setLoadError(false);
      if (res.running) {
        api<N8nMetrics>("/n8n/metrics", { silent: true })
          .then(setMetrics)
          .catch(() => setMetrics(null));
      } else {
        setMetrics(null);
      }
      return res;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  const loadWorkflows = useCallback(async (): Promise<void> => {
    try {
      const res = await api<{ available: boolean; items: N8nWorkflow[]; error?: string }>("/n8n/workflows", {
        silent: true
      });
      setWorkflows(res.items);
      setWorkflowsMeta({ available: res.available, error: res.error, loaded: true });
    } catch {
      setWorkflowsMeta({ available: false, error: "Failed to load workflows", loaded: true });
    }
  }, []);

  const loadStarters = useCallback(async (): Promise<void> => {
    try {
      const res = await api<{ items: N8nEventStarter[] }>("/n8n/webhooks", { silent: true });
      setStarters(res.items);
    } catch {
      /* silent */
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await loadStatus();
    await Promise.all([res?.running ? loadWorkflows() : Promise.resolve(), loadStarters()]);
    if (!res?.running) {
      setWorkflows([]);
      setWorkflowsMeta({ available: false, error: "n8n is stopped", loaded: true });
    }
  }, [loadStatus, loadWorkflows, loadStarters]);

  useEffect(() => {
    void refresh();
    const intv = setInterval(() => void loadStatus(), POLL_MS);
    return () => clearInterval(intv);
  }, [refresh, loadStatus]);

  async function run<T>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | null> {
    setBusy(key);
    try {
      const res = await fn();
      if (success) toast.success(typeof success === "function" ? success(res) : success);
      return res;
    } catch {
      /* toasted by api() */
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function power(action: "start" | "stop" | "restart"): Promise<void> {
    if (action !== "start") {
      const ok = await confirmDialog({
        title: `${action === "stop" ? "Stop" : "Restart"} n8n?`,
        message:
          action === "stop"
            ? "Running executions are interrupted, webhooks stop answering and the editor goes offline."
            : "The container is recreated with the saved settings. Running executions may be interrupted; workflows and credentials are kept.",
        confirmLabel: action === "stop" ? "Stop n8n" : "Restart n8n",
        danger: action === "stop"
      });
      if (!ok) return;
    }
    const res = await run(
      action,
      () => api<N8nStatus>("/n8n/power", { method: "POST", body: JSON.stringify({ action }) }),
      action === "stop" ? "n8n stopped" : action === "start" ? "n8n started" : "n8n restarted"
    );
    if (res) {
      setStatus(res);
      if (res.running) void loadWorkflows();
    }
  }

  async function updateImage(): Promise<void> {
    const ok = await confirmDialog({
      title: "Update n8n?",
      message: `Pulls ${status?.image ?? "the configured image"} again and recreates the container if a newer build exists. Your data directory is kept. Back up workflows first if you're crossing a major version.`,
      confirmLabel: "Pull & update"
    });
    if (!ok) return;
    const res = await run(
      "update",
      () => api<N8nStatus & { updated: boolean }>("/n8n/update", { method: "POST", body: "{}" }),
      (r) => (r.updated ? `n8n updated${r.version ? ` to ${r.version}` : ""}` : "Already on the newest image")
    );
    if (res) setStatus(res);
  }

  const running = Boolean(status?.running);
  const apiOk = Boolean(status?.api.ok);

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
            <button className="ghost small" onClick={() => void refresh()}>
              <RotateCw size={14} /> Retry
            </button>
          </div>
        </section>
        <N8nStyles />
      </div>
    );
  }

  const badge = !status ? "none" : status.running ? (status.reachable ? "running" : "starting") : "stopped";
  const badgeLabel = !status
    ? "loading"
    : status.running
      ? status.reachable
        ? "running"
        : "starting"
      : status.state === "absent"
        ? "not installed"
        : status.state;

  return (
    <div className="n8n-page">
      <header className="page-header">
        <div className="title-group">
          <h2>
            n8n {status?.version && <span className="n8n-version">v{status.version}</span>}
          </h2>
          <p className="muted">Workflow automation, managed by LocalSURV.</p>
        </div>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <StatusBadge status={badge} label={badgeLabel} />
          {running && status?.openUrl && (
            <a className="button primary small n8n-open" href={status.openUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Open editor
            </a>
          )}
          <button className="ghost small" onClick={() => void refresh()} title="Refresh" aria-label="Refresh">
            <RotateCw size={14} />
          </button>
        </div>
      </header>

      {status?.pendingRestart && status.running && (
        <div className="n8n-banner warn">
          <AlertTriangle size={16} />
          <span>Saved settings differ from the running container. Restart n8n to apply them.</span>
          <button className="small" disabled={busy !== null} onClick={() => void power("restart")}>
            {busy === "restart" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Restart now
          </button>
        </div>
      )}

      <nav className="n8n-tabs" role="tablist" aria-label="n8n sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const count =
            t.id === "workflows" && workflowsMeta.available
              ? workflows.length
              : t.id === "automations"
                ? starters.filter((s) => s.installed).length || null
                : null;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`n8n-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={14} /> {t.label}
              {count != null && <span className="n8n-tab-count">{count}</span>}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && status && (
        <OverviewTab
          status={status}
          metrics={metrics}
          workflows={workflows}
          workflowsAvailable={workflowsMeta.available}
          starters={starters}
          busy={busy}
          onPower={(a) => void power(a)}
          onUpdate={() => void updateImage()}
          onStatus={setStatus}
          onGoto={setTab}
          run={run}
          onApiConnected={() => void loadWorkflows()}
        />
      )}
      {tab === "workflows" && (
        <WorkflowsTab
          running={running}
          apiOk={apiOk}
          workflows={workflows}
          meta={workflowsMeta}
          reload={loadWorkflows}
          onGoto={setTab}
        />
      )}
      {tab === "executions" && (
        <ExecutionsTab running={running} apiOk={apiOk} workflows={workflows} openUrl={status?.openUrl ?? null} onGoto={setTab} />
      )}
      {tab === "automations" && status && (
        <AutomationsTab status={status} starters={starters} reload={loadStarters} />
      )}
      {tab === "settings" && status && <SettingsTab status={status} onStatus={setStatus} run={run} busy={busy} />}
      {tab === "logs" && <LogsTab running={running} />}

      <N8nStyles />
    </div>
  );
}

type RunFn = <T>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)) => Promise<T | null>;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab(props: {
  status: N8nStatus;
  metrics: N8nMetrics | null;
  workflows: N8nWorkflow[];
  workflowsAvailable: boolean;
  starters: N8nEventStarter[];
  busy: string | null;
  onPower: (a: "start" | "stop" | "restart") => void;
  onUpdate: () => void;
  onStatus: (s: N8nStatus) => void;
  onGoto: (t: Tab) => void;
  run: RunFn;
  onApiConnected: () => void;
}) {
  const { status, metrics, busy } = props;
  const running = status.running;
  const active = props.workflows.filter((w) => w.active).length;
  const installedEvents = props.starters.filter((s) => s.installed).length;

  const steps: Array<{ done: boolean; title: string; body: ReactNode; action?: ReactNode }> = [
    {
      done: running,
      title: "Start n8n",
      body: "Runs the official n8n image with a persistent data directory and a generated encryption key.",
      action: !running ? (
        <button className="primary xsmall" disabled={busy !== null} onClick={() => props.onPower("start")}>
          <Play size={12} /> Start
        </button>
      ) : undefined
    },
    {
      done: running && status.api.keySet,
      title: "Create the owner account",
      body: "Open the editor and set up the first (owner) user. n8n keeps its own user accounts.",
      action:
        running && status.openUrl ? (
          <a className="button ghost xsmall" href={status.openUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Open editor
          </a>
        ) : undefined
    },
    {
      done: status.api.ok,
      title: "Connect the n8n API",
      body: "Lets LocalSURV list, toggle, import and back up workflows and show executions.",
      action: undefined
    },
    {
      done: Boolean(status.publicUrl),
      title: "Give n8n a public URL",
      body: "Needed for webhooks called from the internet (Stripe, GitHub, forms…) and for OAuth credentials.",
      action: (
        <button className="ghost xsmall" onClick={() => props.onGoto("settings")}>
          Settings
        </button>
      )
    },
    {
      done: status.aiGateway.wired,
      title: "Wire the AI Gateway (optional)",
      body: "Gives AI / OpenAI-compatible nodes a key and base URL through LocalSURV's gateway.",
      action: (
        <button className="ghost xsmall" onClick={() => props.onGoto("settings")}>
          Settings
        </button>
      )
    },
    {
      done: installedEvents > 0,
      title: "Automate LocalSURV events (optional)",
      body: "React to deploys, crashes, inbound email and license events inside n8n.",
      action: (
        <button className="ghost xsmall" onClick={() => props.onGoto("automations")}>
          Events
        </button>
      )
    }
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="n8n-grid">
      <section className="card n8n-span-2">
        <div className="section-title">
          <h3>
            <Cpu size={15} /> Container
          </h3>
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
            <button className="primary small" disabled={running || busy !== null} onClick={() => props.onPower("start")}>
              {busy === "start" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start
            </button>
            <button
              className="ghost small"
              disabled={!status.installed || busy !== null}
              onClick={() => props.onPower("restart")}
            >
              {busy === "restart" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Restart
            </button>
            <button className="ghost small text-danger" disabled={!running || busy !== null} onClick={() => props.onPower("stop")}>
              {busy === "stop" ? <Loader2 size={14} className="spin" /> : <Square size={14} />} Stop
            </button>
            <button className="ghost small" disabled={busy !== null} onClick={props.onUpdate} title="Pull the image tag again">
              {busy === "update" ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Update
            </button>
          </div>
        </div>
        <div className="n8n-kv">
          <Kv label="Health">
            {!running ? (
              <span className="muted">stopped</span>
            ) : status.reachable ? (
              <span className="n8n-ok">
                <CheckCircle2 size={13} /> healthy
              </span>
            ) : (
              <span className="n8n-warn">
                <Loader2 size={13} className="spin" /> starting…
              </span>
            )}
          </Kv>
          <Kv label="Uptime">{running ? uptime(status.startedAt) : "—"}</Kv>
          <Kv label="CPU">{metrics?.available ? `${metrics.cpuPercent ?? 0}%` : "—"}</Kv>
          <Kv label="Memory">
            {metrics?.available && metrics.memoryMb != null ? (
              <span>
                {metrics.memoryMb} MB
                {metrics.memoryLimitMb ? <span className="muted"> / {Math.round(metrics.memoryLimitMb / 1024)} GB</span> : null}
              </span>
            ) : (
              "—"
            )}
          </Kv>
          <Kv label="Image">
            <span className="n8n-mono" title={status.image}>
              {status.image.replace("docker.n8n.io/n8nio/", "")}
            </span>
          </Kv>
          <Kv label="Local port">
            <span className="n8n-mono">127.0.0.1:{status.port}</span>
          </Kv>
          <Kv label="Data directory">
            <span className="n8n-mono" title={status.dataDir}>
              {status.dataDir}
            </span>
          </Kv>
          <Kv label="Restart policy">
            <span className="row" style={{ gap: "0.4rem" }}>
              {status.autostart ? "unless-stopped" : "manual"}
              <button
                className="ghost xsmall"
                disabled={busy !== null}
                onClick={async () => {
                  const res = await props.run(
                    "autostart",
                    () =>
                      api<N8nStatus>("/n8n/autostart", {
                        method: "POST",
                        body: JSON.stringify({ enabled: !status.autostart })
                      }),
                    (r) => (r.autostart ? "n8n now restarts with Docker" : "Autostart disabled")
                  );
                  if (res) props.onStatus(res);
                }}
              >
                {busy === "autostart" ? <Loader2 size={12} className="spin" /> : <Power size={12} />}
                {status.autostart ? "Disable" : "Enable"}
              </button>
            </span>
          </Kv>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Workflow size={15} /> At a glance
          </h3>
        </div>
        <div className="n8n-stats">
          <button className="n8n-stat" onClick={() => props.onGoto("workflows")}>
            <span className="n8n-stat-num">{props.workflowsAvailable ? props.workflows.length : "—"}</span>
            <span className="muted tiny">workflows</span>
          </button>
          <button className="n8n-stat" onClick={() => props.onGoto("workflows")}>
            <span className="n8n-stat-num">{props.workflowsAvailable ? active : "—"}</span>
            <span className="muted tiny">active</span>
          </button>
          <button className="n8n-stat" onClick={() => props.onGoto("automations")}>
            <span className="n8n-stat-num">{installedEvents}</span>
            <span className="muted tiny">event hooks</span>
          </button>
        </div>
        <div className="n8n-kv" style={{ marginTop: "1rem" }}>
          <Kv label="Public URL">
            {status.publicUrl ? (
              <a className="link n8n-mono" href={status.publicUrl} target="_blank" rel="noreferrer">
                {status.publicUrl}
              </a>
            ) : (
              <span className="muted">not set</span>
            )}
          </Kv>
          <Kv label="AI Gateway">{status.aiGateway.wired ? "wired" : <span className="muted">not wired</span>}</Kv>
        </div>
      </section>

      <section className="card n8n-span-2">
        <div className="section-title">
          <h3>
            <CheckCircle2 size={15} /> Getting started
          </h3>
          <span className="chip">
            {doneCount}/{steps.length}
          </span>
        </div>
        <ol className="n8n-steps">
          {steps.map((s, i) => (
            <li key={s.title} className={s.done ? "done" : ""}>
              <span className="n8n-step-icon">{s.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
              <div className="fcol" style={{ gap: "0.15rem", flex: 1, minWidth: 0 }}>
                <span className="n8n-step-title">
                  {i + 1}. {s.title}
                </span>
                <span className="muted small">{s.body}</span>
                {s.title === "Connect the n8n API" && !status.api.ok && (
                  <ApiKeyForm status={status} onStatus={props.onStatus} run={props.run} busy={busy} onConnected={props.onApiConnected} />
                )}
              </div>
              {s.action && <div className="n8n-step-action">{s.action}</div>}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <KeyRound size={15} /> Keys
          </h3>
        </div>
        <div className="n8n-kv one">
          <Kv label="Encryption key">
            {status.encryptionKeySet ? (
              <span className="n8n-ok">
                <CheckCircle2 size={13} /> stored in LocalSURV
              </span>
            ) : (
              <span className="muted">generated on first start</span>
            )}
          </Kv>
          <Kv label="Public API key">
            {status.api.ok ? (
              <span className="n8n-ok">
                <CheckCircle2 size={13} /> connected
              </span>
            ) : status.api.keySet ? (
              <span className="n8n-warn">{status.api.error ?? "not verified"}</span>
            ) : (
              <span className="muted">not connected</span>
            )}
          </Kv>
        </div>
        <p className="muted small" style={{ marginTop: "0.75rem" }}>
          The encryption key protects every credential stored in n8n. It lives in LocalSURV's encrypted settings and
          is included in instance backups — losing it means re-entering all credentials.
        </p>
        {status.api.keySet && status.api.ok && (
          <button
            className="ghost xsmall text-danger"
            style={{ marginTop: "0.5rem" }}
            disabled={busy !== null}
            onClick={async () => {
              const res = await props.run(
                "api-key",
                () => api<N8nStatus>("/n8n/api-key", { method: "PUT", body: JSON.stringify({ key: "" }) }),
                "API key removed"
              );
              if (res) props.onStatus(res);
            }}
          >
            <Trash2 size={12} /> Disconnect API key
          </button>
        )}
      </section>
    </div>
  );
}

function ApiKeyForm(props: {
  status: N8nStatus;
  onStatus: (s: N8nStatus) => void;
  run: RunFn;
  busy: string | null;
  onConnected: () => void;
}) {
  const [key, setKey] = useState("");
  const { status } = props;
  return (
    <div className="n8n-apikey">
      {status.api.keySet && status.api.error && (
        <span className="n8n-warn small">
          <AlertTriangle size={13} /> {status.api.error}
        </span>
      )}
      <span className="muted small">
        In n8n open <b>Settings → n8n API</b>, create an API key and paste it here.
        {status.api.settingsUrl && (
          <>
            {" "}
            <a className="link" href={status.api.settingsUrl} target="_blank" rel="noreferrer">
              Open API settings <ExternalLink size={11} />
            </a>
          </>
        )}
      </span>
      <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
        <input
          className="input"
          type="password"
          autoComplete="off"
          style={{ flex: "1 1 240px" }}
          placeholder="eyJhbGciOi… (n8n API key)"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={!status.running}
        />
        <button
          className="primary small"
          disabled={!key.trim() || props.busy !== null || !status.running}
          onClick={async () => {
            const res = await props.run(
              "api-key",
              () => api<N8nStatus>("/n8n/api-key", { method: "PUT", body: JSON.stringify({ key: key.trim() }) }),
              "n8n API connected"
            );
            if (res) {
              props.onStatus(res);
              setKey("");
              props.onConnected();
            }
          }}
        >
          {props.busy === "api-key" ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Connect
        </button>
      </div>
    </div>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="muted tiny n8n-label">{label}</span>
      <span className="n8n-kv-value">{children}</span>
    </div>
  );
}

function NeedsApi({ running, onGoto, what }: { running: boolean; onGoto: (t: Tab) => void; what: string }) {
  return (
    <div className="n8n-empty">
      <KeyRound size={22} />
      <p>{running ? `Connect the n8n API to manage ${what} from here.` : `Start n8n to see ${what}.`}</p>
      <button className="ghost small" onClick={() => onGoto("overview")}>
        {running ? "Connect API" : "Go to overview"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function WorkflowsTab(props: {
  running: boolean;
  apiOk: boolean;
  workflows: N8nWorkflow[];
  meta: { available: boolean; error?: string; loaded: boolean };
  reload: () => Promise<void>;
  onGoto: (t: Tab) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [activateOnImport, setActivateOnImport] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return props.workflows.filter((w) => {
      if (filter === "active" && !w.active) return false;
      if (filter === "inactive" && w.active) return false;
      if (!needle) return true;
      return (
        w.name.toLowerCase().includes(needle) ||
        w.tags.some((t) => t.toLowerCase().includes(needle)) ||
        w.triggers.some((t) => t.toLowerCase().includes(needle))
      );
    });
  }, [props.workflows, q, filter]);

  if (!props.running || (!props.meta.available && !props.apiOk)) {
    return (
      <section className="card">
        {props.meta.error && props.running && props.meta.loaded && props.apiOk === false && (
          <p className="muted small" style={{ marginBottom: "0.5rem" }}>
            {props.meta.error}
          </p>
        )}
        <NeedsApi running={props.running} onGoto={props.onGoto} what="workflows" />
      </section>
    );
  }

  async function toggle(w: N8nWorkflow): Promise<void> {
    setBusyId(w.id);
    try {
      await api(`/n8n/workflows/${encodeURIComponent(w.id)}/active`, {
        method: "POST",
        body: JSON.stringify({ active: !w.active })
      });
      toast.success(`${w.name} ${w.active ? "deactivated" : "activated"}`);
      await props.reload();
    } catch {
      /* toasted — n8n explains why activation failed (e.g. missing credentials) */
    } finally {
      setBusyId(null);
    }
  }

  async function remove(w: N8nWorkflow): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete "${w.name}"?`,
      message: "The workflow is permanently deleted from n8n. Download its JSON first if you might need it.",
      confirmLabel: "Delete workflow",
      danger: true
    });
    if (!ok) return;
    setBusyId(w.id);
    try {
      await api(`/n8n/workflows/${encodeURIComponent(w.id)}`, { method: "DELETE" });
      toast.success("Workflow deleted");
      await props.reload();
    } catch {
      /* toasted */
    } finally {
      setBusyId(null);
    }
  }

  async function download(w: N8nWorkflow): Promise<void> {
    setBusyId(w.id);
    try {
      const json = await api<Record<string, unknown>>(`/n8n/workflows/${encodeURIComponent(w.id)}`);
      downloadJson(`${w.name.replace(/[^\w.-]+/g, "_")}.json`, json);
    } catch {
      /* toasted */
    } finally {
      setBusyId(null);
    }
  }

  async function exportAll(): Promise<void> {
    setBusyId("export");
    try {
      const bundle = await api<{ workflows: unknown[] }>("/n8n/workflows/export");
      downloadJson(`n8n-workflows-${new Date().toISOString().slice(0, 10)}.json`, bundle);
      toast.success(`Exported ${bundle.workflows.length} workflows`);
    } catch {
      /* toasted */
    } finally {
      setBusyId(null);
    }
  }

  async function importFile(file: File): Promise<void> {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error("That file isn't valid JSON");
        return;
      }
      const created = await api<N8nWorkflow>("/n8n/workflows/import", {
        method: "POST",
        body: JSON.stringify({ workflow: parsed, activate: activateOnImport })
      });
      toast.success(`Imported "${created.name}"${created.active ? " and activated it" : ""}`);
      await props.reload();
    } catch {
      /* toasted */
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card">
      <div className="n8n-toolbar">
        <div className="n8n-search">
          <Search size={14} />
          <input placeholder="Search name, tag or trigger…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="n8n-seg" role="group" aria-label="Filter workflows">
          {(["all", "active", "inactive"] as const).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: "0.4rem", marginLeft: "auto", flexWrap: "wrap" }}>
          <label className="toggle-inline small" title="Activate imported workflows immediately">
            <input type="checkbox" checked={activateOnImport} onChange={(e) => setActivateOnImport(e.target.checked)} />
            activate
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
            }}
          />
          <button className="ghost small" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Import
          </button>
          <button className="ghost small" disabled={busyId === "export" || props.workflows.length === 0} onClick={() => void exportAll()}>
            {busyId === "export" ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Export all
          </button>
          <button className="ghost small" onClick={() => void props.reload()} aria-label="Reload workflows">
            <RotateCw size={14} />
          </button>
        </div>
      </div>

      {props.meta.error && !props.meta.available && (
        <div className="n8n-banner warn" style={{ marginTop: "0.75rem" }}>
          <AlertTriangle size={14} /> {props.meta.error}
        </div>
      )}

      {list.length === 0 ? (
        <div className="n8n-empty">
          <Workflow size={22} />
          <p>{props.workflows.length === 0 ? "No workflows yet — build one in the editor or import a JSON file." : "No workflows match."}</p>
        </div>
      ) : (
        <div className="n8n-list">
          {list.map((w) => (
            <div key={w.id} className="n8n-entry">
              <div className="n8n-row">
                <button
                  className={`n8n-switch ${w.active ? "on" : ""}`}
                  role="switch"
                  aria-checked={w.active}
                  aria-label={`${w.active ? "Deactivate" : "Activate"} ${w.name}`}
                  disabled={busyId === w.id}
                  onClick={() => void toggle(w)}
                >
                  <span />
                </button>
                <button
                  className="n8n-row-main"
                  onClick={() => setExpanded(expanded === w.id ? null : w.id)}
                  aria-expanded={expanded === w.id}
                >
                  <span className="n8n-title">{w.name}</span>
                  <span className="n8n-meta">
                    {w.triggers.map((t) => (
                      <span key={t} className="n8n-pill trigger">
                        {t}
                      </span>
                    ))}
                    {w.tags.map((t) => (
                      <span key={t} className="n8n-pill">
                        #{t}
                      </span>
                    ))}
                    <span className="muted tiny">
                      {w.nodeCount} nodes · updated {timeAgo(w.updatedAt)}
                    </span>
                  </span>
                </button>
                <div className="n8n-row-actions">
                  {busyId === w.id && <Loader2 size={14} className="spin muted" />}
                  {w.editorUrl && (
                    <a className="button ghost xsmall" href={w.editorUrl} target="_blank" rel="noreferrer" title="Open in editor">
                      <ExternalLink size={13} />
                    </a>
                  )}
                  <button className="ghost xsmall" onClick={() => void download(w)} title="Download JSON" aria-label="Download JSON">
                    <Download size={13} />
                  </button>
                  <button className="ghost xsmall text-danger" onClick={() => void remove(w)} title="Delete" aria-label="Delete workflow">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {expanded === w.id && (
                <div className="n8n-detail">
                  {w.webhooks.length === 0 ? (
                    <span className="muted small">No webhook triggers in this workflow.</span>
                  ) : (
                    w.webhooks.map((h) => (
                      <div key={`${h.method}-${h.path}`} className="n8n-hook">
                        <span className="n8n-pill">{h.method}</span>
                        <code className="n8n-mono">{h.productionUrl}</code>
                        <button className="ghost xsmall" onClick={() => void copyText(h.productionUrl, "Webhook URL copied")}>
                          <Copy size={12} />
                        </button>
                        {!w.active && <span className="n8n-warn tiny">inactive — production URL won't answer</span>}
                      </div>
                    ))
                  )}
                  <span className="muted tiny">
                    ID {w.id} · created {timeAgo(w.createdAt)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

function ExecutionsTab(props: {
  running: boolean;
  apiOk: boolean;
  workflows: N8nWorkflow[];
  openUrl: string | null;
  onGoto: (t: Tab) => void;
}) {
  const [items, setItems] = useState<N8nExecution[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (append?: string | null) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: "50" });
        if (statusFilter) qs.set("status", statusFilter);
        if (workflowFilter) qs.set("workflowId", workflowFilter);
        if (append) qs.set("cursor", append);
        const res = await api<{ available: boolean; items: N8nExecution[]; nextCursor: string | null; error?: string }>(
          `/n8n/executions?${qs}`,
          { silent: true }
        );
        setError(res.available ? null : res.error ?? "Executions unavailable");
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
      } catch {
        setError("Failed to load executions");
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, workflowFilter]
  );

  useEffect(() => {
    if (props.running && props.apiOk) void load();
  }, [load, props.running, props.apiOk]);

  if (!props.running || !props.apiOk) {
    return (
      <section className="card">
        <NeedsApi running={props.running} onGoto={props.onGoto} what="executions" />
      </section>
    );
  }

  const counts = items.reduce(
    (acc, e) => {
      const tone = execTone(e.status);
      acc[tone] = (acc[tone] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  async function retry(e: N8nExecution): Promise<void> {
    setBusyId(e.id);
    try {
      await api(`/n8n/executions/${encodeURIComponent(e.id)}/retry`, { method: "POST", body: "{}" });
      toast.success("Retry started");
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusyId(null);
    }
  }

  async function remove(e: N8nExecution): Promise<void> {
    setBusyId(e.id);
    try {
      await api(`/n8n/executions/${encodeURIComponent(e.id)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((x) => x.id !== e.id));
    } catch {
      /* toasted */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card">
      <div className="n8n-toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>
          <option value="success">Succeeded</option>
          <option value="error">Failed</option>
          <option value="running">Running</option>
          <option value="waiting">Waiting</option>
          <option value="canceled">Canceled</option>
        </select>
        <select value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)} aria-label="Workflow filter">
          <option value="">All workflows</option>
          {props.workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="row" style={{ gap: "0.5rem", marginLeft: "auto" }}>
          {counts.ok ? <span className="n8n-pill ok">{counts.ok} ok</span> : null}
          {counts.bad ? <span className="n8n-pill bad">{counts.bad} failed</span> : null}
          {counts.busy ? <span className="n8n-pill busy">{counts.busy} running</span> : null}
          <button className="ghost small" onClick={() => void load()} aria-label="Reload executions">
            {loading ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
          </button>
        </div>
      </div>

      {error ? (
        <div className="n8n-banner warn" style={{ marginTop: "0.75rem" }}>
          <AlertTriangle size={14} /> {error}
        </div>
      ) : items.length === 0 && !loading ? (
        <div className="n8n-empty">
          <History size={22} />
          <p>No executions{statusFilter || workflowFilter ? " match these filters" : " yet"}.</p>
        </div>
      ) : (
        <div className="n8n-table-wrap">
          <table className="n8n-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Workflow</th>
                <th>Mode</th>
                <th>Started</th>
                <th>Duration</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`n8n-pill ${execTone(e.status)}`}>{e.status}</span>
                  </td>
                  <td className="n8n-cell-name">
                    {e.workflowName ?? <span className="muted">#{e.workflowId ?? "?"}</span>}
                    {e.retryOf && <span className="muted tiny"> · retry of #{e.retryOf}</span>}
                  </td>
                  <td className="muted small">{e.mode ?? "—"}</td>
                  <td className="small" title={e.startedAt ?? ""}>
                    {timeAgo(e.startedAt)}
                  </td>
                  <td className="small">{formatDuration(e.durationMs)}</td>
                  <td>
                    <div className="n8n-row-actions">
                      {busyId === e.id && <Loader2 size={13} className="spin muted" />}
                      {props.openUrl && e.workflowId && (
                        <a
                          className="button ghost xsmall"
                          href={`${props.openUrl.replace(/\/+$/, "")}/workflow/${e.workflowId}/executions/${e.id}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Inspect in n8n"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                      {execTone(e.status) === "bad" && (
                        <button className="ghost xsmall" onClick={() => void retry(e)} title="Retry" aria-label="Retry execution">
                          <RefreshCw size={12} />
                        </button>
                      )}
                      <button className="ghost xsmall" onClick={() => void remove(e)} title="Delete" aria-label="Delete execution">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <button className="ghost small" style={{ marginTop: "0.75rem" }} disabled={loading} onClick={() => void load(cursor)}>
              {loading ? <Loader2 size={14} className="spin" /> : null} Load more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LocalSURV events
// ---------------------------------------------------------------------------

function AutomationsTab(props: { status: N8nStatus; starters: N8nEventStarter[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const canAuto = props.status.running && props.status.api.ok;

  const groups = useMemo(() => {
    const map = new Map<string, N8nEventStarter[]>();
    for (const s of props.starters) {
      const list = map.get(s.group) ?? [];
      list.push(s);
      map.set(s.group, list);
    }
    return [...map.entries()];
  }, [props.starters]);

  async function act(key: string, fn: () => Promise<void>): Promise<void> {
    setBusy(key);
    try {
      await fn();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const autoInstall = (s: N8nEventStarter) =>
    act(`auto-${s.event}`, async () => {
      const res = await api<{ workflowId: string; editorUrl: string | null }>(
        `/n8n/webhooks/${encodeURIComponent(s.event)}/auto-install`,
        { method: "POST", body: "{}" }
      );
      toast.success(`"${s.label}" workflow created and active in n8n`);
      if (res.editorUrl) window.open(res.editorUrl, "_blank", "noopener");
      await props.reload();
    });

  const testFire = (s: N8nEventStarter) =>
    act(`test-${s.event}`, async () => {
      const res = await api<{ ok: boolean; status: number | null; error?: string }>(
        `/n8n/webhooks/${encodeURIComponent(s.event)}/test`,
        { method: "POST", body: "{}" }
      );
      if (res.ok) toast.success(`n8n accepted the test event (${res.status}) — check Executions`);
      else toast.error(res.error ?? "n8n did not accept the test event");
    });

  const saveCustom = (s: N8nEventStarter) =>
    act(`save-${s.event}`, async () => {
      const url = (drafts[s.event] ?? "").trim();
      if (!url) {
        toast.error("Paste the n8n production webhook URL first");
        return;
      }
      await api("/n8n/webhooks", { method: "POST", body: JSON.stringify({ event: s.event, webhookUrl: url }) });
      toast.success("Webhook saved");
      setCustomOpen(null);
      await props.reload();
    });

  const remove = (s: N8nEventStarter) =>
    act(`rm-${s.event}`, async () => {
      const ok = await confirmDialog({
        title: "Stop forwarding this event?",
        message: `LocalSURV will stop sending ${s.event} to n8n. The workflow in n8n is not deleted.`,
        confirmLabel: "Stop forwarding",
        danger: true
      });
      if (!ok) return;
      await api(`/n8n/webhooks/${encodeURIComponent(s.event)}`, { method: "DELETE" });
      toast.success("Forwarding removed");
      await props.reload();
    });

  const downloadStarter = (s: N8nEventStarter) =>
    act(`json-${s.event}`, async () => {
      const res = await api<Record<string, unknown>>(`/n8n/webhooks/${encodeURIComponent(s.event)}/workflow.json`);
      downloadJson(`localsurv-${s.event.replace(/\./g, "-")}.json`, res);
      const suggested = (res.meta as { suggestedUrl?: string } | undefined)?.suggestedUrl;
      if (suggested) setDrafts((d) => ({ ...d, [s.event]: suggested }));
      setCustomOpen(s.event);
    });

  return (
    <div className="fcol" style={{ gap: "1rem" }}>
      <section className="card">
        <div className="section-title">
          <h3>
            <Webhook size={15} /> LocalSURV → n8n events
          </h3>
        </div>
        <p className="muted small">
          LocalSURV POSTs a JSON payload to n8n whenever one of these happens. <b>Install</b> creates a ready-to-edit
          workflow with a Webhook trigger in n8n, activates it and registers it here — then open it and add your logic
          (Slack, Discord, a ticket, an AI reply…).
          {!canAuto && " Connect the n8n API on the Overview tab to enable one-click install."}
        </p>
        {groups.map(([group, list]) => (
          <div key={group} className="n8n-group">
            <h4 className="n8n-group-title">{group}</h4>
            <div className="n8n-list">
              {list.map((s) => (
                <div key={s.event} className="n8n-entry">
                  <div className="n8n-row">
                    <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                      <span className="n8n-title">
                        {s.label} <code className="n8n-event">{s.event}</code>
                        {s.installed && (
                          <span className="n8n-pill ok">
                            <CheckCircle2 size={11} /> forwarding
                          </span>
                        )}
                      </span>
                      <span className="muted tiny">{s.description}</span>
                      {s.installed && s.webhookUrl && <span className="muted tiny n8n-mono">→ {s.webhookUrl}</span>}
                    </div>
                    <div className="n8n-row-actions">
                      {!s.installed && (
                        <button
                          className="primary xsmall"
                          disabled={!canAuto || busy !== null}
                          onClick={() => void autoInstall(s)}
                          title={canAuto ? "Create + activate the workflow in n8n" : "Connect the n8n API first"}
                        >
                          {busy === `auto-${s.event}` ? <Loader2 size={12} className="spin" /> : <Zap size={12} />} Install
                        </button>
                      )}
                      {s.installed && (
                        <button className="ghost xsmall" disabled={busy !== null} onClick={() => void testFire(s)}>
                          {busy === `test-${s.event}` ? <Loader2 size={12} className="spin" /> : <Send size={12} />} Test
                        </button>
                      )}
                      <button
                        className="ghost xsmall"
                        onClick={() => setCustomOpen(customOpen === s.event ? null : s.event)}
                        title="Use your own webhook URL"
                      >
                        <Settings2 size={12} />
                      </button>
                      {s.installed && (
                        <button className="ghost xsmall text-danger" disabled={busy !== null} onClick={() => void remove(s)} aria-label="Stop forwarding">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  {customOpen === s.event && (
                    <div className="n8n-detail">
                      <span className="muted small">
                        Point this event at any webhook — e.g. an existing workflow's production URL.{" "}
                        <button className="link-button" onClick={() => void downloadStarter(s)}>
                          Download a starter workflow JSON
                        </button>
                      </span>
                      <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
                        <input
                          className="input"
                          style={{ flex: "1 1 260px" }}
                          placeholder="http://127.0.0.1:5678/webhook/…"
                          value={drafts[s.event] ?? s.webhookUrl ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [s.event]: e.target.value }))}
                        />
                        <button className="ghost small" disabled={busy !== null} onClick={() => void saveCustom(s)}>
                          {busy === `save-${s.event}` ? <Loader2 size={12} className="spin" /> : <Webhook size={12} />} Save URL
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Mail size={15} /> n8n → LocalSURV
          </h3>
        </div>
        <p className="muted small">Things your workflows can call back into on this host:</p>
        <ul className="n8n-callbacks">
          <li>
            <b>Send email from a mailbox</b> — HTTP Request node, <code>POST /emailer/api/send</code> with a mailbox
            API token as Bearer. Replies land in the same conversation in the{" "}
            <Link className="link" to="/emailer?view=setup">
              Emailer
            </Link>
            .
          </li>
          <li>
            <b>AI models</b> — once the AI Gateway is wired, OpenAI-compatible nodes use <code>OPENAI_API_KEY</code> /{" "}
            <code>OPENAI_BASE_URL</code> automatically (Settings tab).
          </li>
          <li>
            <b>Other services</b> — n8n reaches the host as <code>host.docker.internal</code>, so a service on port
            3000 is <code>http://host.docker.internal:3000</code>.
          </li>
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const COMMON_TIMEZONES = [
  "UTC",
  "Europe/Copenhagen",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Stockholm",
  "Europe/Oslo",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney"
];

function SettingsTab(props: { status: N8nStatus; onStatus: (s: N8nStatus) => void; run: RunFn; busy: string | null }) {
  const { status, busy } = props;
  const [publicUrl, setPublicUrl] = useState(status.publicUrl ?? "");
  const [cfg, setCfg] = useState<N8nConfig>(status.config);
  const [envRows, setEnvRows] = useState<Array<{ k: string; v: string }>>(
    Object.entries(status.config.extraEnv).map(([k, v]) => ({ k, v }))
  );
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api<{ configured: boolean }>("/email/settings", { silent: true })
      .then((s) => setSmtpConfigured(s.configured))
      .catch(() => setSmtpConfigured(null));
  }, []);

  const dirty =
    JSON.stringify({ ...cfg, extraEnv: undefined }) !== JSON.stringify({ ...status.config, extraEnv: undefined }) ||
    JSON.stringify(Object.fromEntries(envRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]))) !==
      JSON.stringify(status.config.extraEnv);

  async function save(apply: boolean): Promise<void> {
    const res = await props.run(
      apply ? "config-apply" : "config",
      () =>
        api<N8nStatus>("/n8n/config", {
          method: "PUT",
          body: JSON.stringify({
            ...cfg,
            pruneMaxAgeHours: Number(cfg.pruneMaxAgeHours),
            extraEnv: Object.fromEntries(envRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])),
            apply
          })
        }),
      apply ? "Saved and applied — n8n restarted" : "Saved — restart n8n to apply"
    );
    if (res) {
      props.onStatus(res);
      setCfg(res.config);
    }
  }

  return (
    <div className="n8n-grid">
      <section className="card n8n-span-2">
        <div className="section-title">
          <h3>
            <ExternalLink size={15} /> Public URL
          </h3>
        </div>
        <p className="muted small">
          The https address that reaches this n8n through{" "}
          <Link className="link" to="/proxy">
            Edge Ingress
          </Link>{" "}
          or a tunnel to <code>127.0.0.1:{status.port}</code>. It becomes <code>WEBHOOK_URL</code> and the editor URL,
          so webhook nodes and OAuth callbacks show the right address. Saving recreates a running container.
        </p>
        <div className="row" style={{ marginTop: "0.75rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            placeholder="https://n8n.example.com"
            value={publicUrl}
            onChange={(e) => setPublicUrl(e.target.value)}
          />
          <button
            className="primary small"
            disabled={busy !== null || publicUrl.trim() === (status.publicUrl ?? "")}
            onClick={async () => {
              const res = await props.run(
                "public-url",
                () => api<N8nStatus>("/n8n/public-url", { method: "POST", body: JSON.stringify({ url: publicUrl.trim() }) }),
                (r) => (r.publicUrl ? "Public URL saved" : "Public URL cleared")
              );
              if (res) props.onStatus(res);
            }}
          >
            {busy === "public-url" && <Loader2 size={14} className="spin" />} Save
          </button>
          {status.webhookUrl && (
            <button className="ghost small" onClick={() => void copyText(status.webhookUrl!, "Webhook base copied")}>
              <Copy size={14} /> Webhook base
            </button>
          )}
        </div>
        {publicUrl.startsWith("http://") && !/127\.0\.0\.1|localhost/.test(publicUrl) && (
          <p className="n8n-warn small" style={{ marginTop: "0.5rem" }}>
            <AlertTriangle size={13} /> Plain http: secure cookies are turned off so login works, but use https for
            anything internet-facing.
          </p>
        )}
      </section>

      <section className="card n8n-span-2">
        <div className="section-title">
          <h3>
            <Settings2 size={15} /> Runtime
          </h3>
          <div className="row" style={{ gap: "0.4rem" }}>
            <button className="ghost small" disabled={!dirty || busy !== null} onClick={() => void save(false)}>
              {busy === "config" && <Loader2 size={14} className="spin" />} Save
            </button>
            <button className="primary small" disabled={!dirty || busy !== null} onClick={() => void save(true)}>
              {busy === "config-apply" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Save & restart
            </button>
          </div>
        </div>

        <div className="n8n-form">
          <label className="n8n-field">
            <span className="n8n-label tiny muted">Timezone</span>
            <span className="muted tiny">Used by Schedule triggers and date expressions.</span>
            <div className="row" style={{ gap: "0.4rem" }}>
              <input
                className="input"
                list="n8n-tz"
                placeholder="UTC (n8n default: America/New_York)"
                value={cfg.timezone}
                onChange={(e) => setCfg({ ...cfg, timezone: e.target.value })}
              />
              {browserTz && cfg.timezone !== browserTz && (
                <button className="ghost xsmall" onClick={() => setCfg({ ...cfg, timezone: browserTz })}>
                  Use {browserTz}
                </button>
              )}
            </div>
            <datalist id="n8n-tz">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </label>

          <label className="n8n-field">
            <span className="n8n-label tiny muted">Image channel</span>
            <span className="muted tiny">
              <code>latest</code> (stable), <code>next</code> (beta) or a pinned version like <code>1.80.3</code>.
            </span>
            <input
              className="input"
              list="n8n-tags"
              value={cfg.imageTag}
              onChange={(e) => setCfg({ ...cfg, imageTag: e.target.value })}
            />
            <datalist id="n8n-tags">
              <option value="latest" />
              <option value="next" />
              <option value="stable" />
            </datalist>
          </label>

          <div className="n8n-field">
            <span className="n8n-label tiny muted">Execution history</span>
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={cfg.pruneEnabled}
                onChange={(e) => setCfg({ ...cfg, pruneEnabled: e.target.checked })}
              />
              Prune old executions
            </label>
            {cfg.pruneEnabled && (
              <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  style={{ width: 110 }}
                  value={cfg.pruneMaxAgeHours}
                  onChange={(e) => setCfg({ ...cfg, pruneMaxAgeHours: Number(e.target.value) })}
                />
                <span className="muted small">hours ({Math.round((cfg.pruneMaxAgeHours / 24) * 10) / 10} days)</span>
              </div>
            )}
          </div>

          <div className="n8n-field">
            <span className="n8n-label tiny muted">Code execution</span>
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={cfg.runnersEnabled}
                onChange={(e) => setCfg({ ...cfg, runnersEnabled: e.target.checked })}
              />
              Task runners for Code nodes
            </label>
            <span className="muted tiny">Runs Code-node JavaScript in an isolated runner (n8n's recommended setup).</span>
          </div>

          <div className="n8n-field">
            <span className="n8n-label tiny muted">Email (invites & password reset)</span>
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={cfg.useSharedSmtp}
                disabled={smtpConfigured === false && !cfg.useSharedSmtp}
                onChange={(e) => setCfg({ ...cfg, useSharedSmtp: e.target.checked })}
              />
              Use the shared SMTP from the Email tab
            </label>
            {smtpConfigured === false && (
              <span className="muted tiny">
                <Link className="link" to="/email">
                  Configure SMTP
                </Link>{" "}
                first.
              </span>
            )}
          </div>
        </div>

        <div className="n8n-field" style={{ marginTop: "1rem" }}>
          <span className="n8n-label tiny muted">Extra environment</span>
          <span className="muted tiny">
            Any other{" "}
            <a className="link" href="https://docs.n8n.io/hosting/configuration/environment-variables/" target="_blank" rel="noreferrer">
              n8n env var
            </a>{" "}
            — e.g. <code>N8N_LOG_LEVEL</code>, <code>NODE_FUNCTION_ALLOW_EXTERNAL</code>, <code>N8N_DEFAULT_BINARY_DATA_MODE</code>.
          </span>
          <div className="n8n-env">
            {envRows.map((row, i) => (
              <div key={i} className="row" style={{ gap: "0.4rem" }}>
                <input
                  className="input n8n-mono"
                  placeholder="KEY"
                  value={row.k}
                  onChange={(e) =>
                    setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, k: e.target.value.toUpperCase() } : r)))
                  }
                  style={{ flex: "0 1 260px" }}
                />
                <input
                  className="input n8n-mono"
                  placeholder="value"
                  value={row.v}
                  onChange={(e) => setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
                  style={{ flex: 1 }}
                />
                <button
                  className="ghost xsmall"
                  aria-label="Remove variable"
                  onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button className="ghost xsmall" style={{ alignSelf: "flex-start" }} onClick={() => setEnvRows((r) => [...r, { k: "", v: "" }])}>
              <Plus size={12} /> Add variable
            </button>
          </div>
        </div>
      </section>

      <section className="card n8n-span-2">
        <div className="section-title">
          <h3>
            <Zap size={15} /> AI Gateway
          </h3>
          <button
            className="primary small"
            disabled={busy !== null}
            onClick={async () => {
              const res = await props.run(
                "ai",
                () => api<N8nStatus>("/n8n/ai-gateway/wire", { method: "POST", body: "{}" }),
                "AI Gateway wired into n8n"
              );
              if (res) props.onStatus(res);
            }}
          >
            {busy === "ai" ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}{" "}
            {status.aiGateway.wired ? "Re-wire (new token)" : "One-click wire"}
          </button>
        </div>
        <div className="n8n-kv">
          <Kv label="Status">{status.aiGateway.wired ? "wired" : <span className="muted">not wired</span>}</Kv>
          <Kv label="OPENAI_BASE_URL">
            <span className="n8n-mono">{status.aiGateway.baseUrl ?? "—"}</span>
          </Kv>
          <Kv label="Token">
            <span className="n8n-mono">{status.aiGateway.tokenPreview ?? "—"}</span>
          </Kv>
        </div>
        <p className="muted small" style={{ marginTop: "0.75rem" }}>
          Mints a dedicated{" "}
          <Link className="link" to="/ai-gateway">
            AI Gateway
          </Link>{" "}
          consumer token and injects it as <code>OPENAI_API_KEY</code> / <code>OPENAI_BASE_URL</code>. In n8n, create an
          OpenAI credential with that key and base URL (or reference <code>{"{{ $env.OPENAI_API_KEY }}"}</code>).
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function LogsTab({ running }: { running: boolean }) {
  const [log, setLog] = useState("");
  const [lines, setLines] = useState(300);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ log: string }>(`/n8n/logs?lines=${lines}`, { silent: true });
      setLog(res.log);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [lines]);

  useEffect(() => {
    void load();
    if (!follow || !running) return;
    const intv = setInterval(() => void load(), 5000);
    return () => clearInterval(intv);
  }, [load, follow, running]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = log.split("\n");
    return needle ? all.filter((l) => l.toLowerCase().includes(needle)).join("\n") : log;
  }, [log, filter]);

  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [shown, follow]);

  return (
    <section className="card">
      <div className="n8n-toolbar">
        <div className="n8n-search">
          <Search size={14} />
          <input placeholder="Filter lines…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines">
          {[100, 300, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              last {n}
            </option>
          ))}
        </select>
        <label className="toggle-inline small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <div className="row" style={{ gap: "0.4rem", marginLeft: "auto" }}>
          <button className="ghost small" onClick={() => void copyText(shown, "Logs copied")}>
            <Copy size={14} />
          </button>
          <button className="ghost small" onClick={() => void load()} aria-label="Reload logs">
            {loading ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
          </button>
        </div>
      </div>
      <pre ref={preRef} className="n8n-log">
        {shown || (running ? "No log output yet." : "n8n is not running.")}
      </pre>
    </section>
  );
}

function N8nStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
  .n8n-page .title-group h2 { display: flex; align-items: baseline; gap: 0.5rem; }
  .n8n-page .n8n-version { font-size: 0.8rem; font-weight: 500; color: var(--text-muted); font-family: var(--font-mono); }
  .n8n-page .n8n-open { display: inline-flex; align-items: center; gap: 0.35rem; text-decoration: none; }
  .n8n-page .n8n-banner { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.65rem 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-default); margin-bottom: 1rem; font-size: 0.85rem; }
  .n8n-page .n8n-banner.warn { background: var(--warning-soft); border-color: rgba(245, 158, 11, 0.35); color: var(--text-primary); }
  .n8n-page .n8n-banner.warn > svg { color: var(--warning); }
  .n8n-page .n8n-banner button { margin-left: auto; }
  .n8n-page .n8n-tabs { display: flex; gap: 0.25rem; overflow-x: auto; border-bottom: 1px solid var(--border-default); margin-bottom: 1rem; scrollbar-width: thin; }
  .n8n-page .n8n-tab { display: inline-flex; align-items: center; gap: 0.4rem; background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 0.6rem 0.8rem; color: var(--text-secondary); font-size: 0.85rem; font-weight: 600; white-space: nowrap; cursor: pointer; }
  .n8n-page .n8n-tab:hover { color: var(--text-primary); }
  .n8n-page .n8n-tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }
  .n8n-page .n8n-tab-count { font-size: 0.7rem; padding: 0 0.4rem; border-radius: var(--radius-full); background: var(--accent-soft); color: var(--accent-light); }
  .n8n-page .n8n-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
  .n8n-page .n8n-grid > .card { margin: 0; }
  .n8n-page .n8n-span-2 { grid-column: span 2; }
  .n8n-page .n8n-grid > .card:not(.n8n-span-2):only-of-type { grid-column: span 3; }
  @media (max-width: 1100px) { .n8n-page .n8n-grid { grid-template-columns: minmax(0, 1fr); } .n8n-page .n8n-span-2 { grid-column: auto; } }
  .n8n-page .section-title h3, .n8n-page .section-title h4 { display: inline-flex; align-items: center; gap: 0.45rem; }
  .n8n-page .n8n-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.9rem 1rem; margin-top: 0.75rem; }
  .n8n-page .n8n-kv.one { grid-template-columns: minmax(0, 1fr); }
  .n8n-page .n8n-kv > div { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .n8n-page .n8n-label { text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .n8n-page .n8n-kv-value { font-size: 0.85rem; font-weight: 500; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .n8n-page .n8n-mono { font-family: var(--font-mono); font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: 100%; vertical-align: bottom; }
  .n8n-page .n8n-ok { color: var(--success); display: inline-flex; align-items: center; gap: 0.3rem; }
  .n8n-page .n8n-warn { color: var(--warning); display: inline-flex; align-items: center; gap: 0.3rem; }
  .n8n-page .n8n-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.5rem; }
  .n8n-page .n8n-stat { display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem; padding: 0.6rem 0.7rem; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); cursor: pointer; text-align: left; }
  .n8n-page .n8n-stat:hover { border-color: var(--border-glow); }
  .n8n-page .n8n-stat-num { font-size: 1.35rem; font-weight: 700; color: var(--text-primary); line-height: 1.1; }
  .n8n-page .n8n-steps { list-style: none; padding: 0; margin: 0.5rem 0 0; display: flex; flex-direction: column; }
  .n8n-page .n8n-steps li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.7rem 0; border-bottom: 1px solid var(--border-subtle); }
  .n8n-page .n8n-steps li:last-child { border-bottom: none; }
  .n8n-page .n8n-step-icon { color: var(--text-dim); margin-top: 0.1rem; }
  .n8n-page .n8n-steps li.done .n8n-step-icon { color: var(--success); }
  .n8n-page .n8n-steps li.done .n8n-step-title { color: var(--text-secondary); }
  .n8n-page .n8n-step-title { font-weight: 600; font-size: 0.88rem; color: var(--text-primary); }
  .n8n-page .n8n-step-action { flex-shrink: 0; }
  .n8n-page .n8n-apikey { display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.5rem; padding: 0.75rem; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
  .n8n-page .n8n-toolbar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .n8n-page .n8n-search { display: flex; align-items: center; gap: 0.4rem; flex: 1 1 220px; max-width: 360px; padding: 0 0.6rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-sunken); }
  .n8n-page .n8n-search input { border: none; background: transparent; flex: 1; padding: 0.45rem 0; outline: none; min-width: 0; }
  .n8n-page .n8n-seg { display: inline-flex; border: 1px solid var(--border-default); border-radius: var(--radius-md); overflow: hidden; }
  .n8n-page .n8n-seg button { border: none; border-radius: 0; background: transparent; padding: 0.35rem 0.7rem; font-size: 0.78rem; text-transform: capitalize; color: var(--text-secondary); cursor: pointer; }
  .n8n-page .n8n-seg button.active { background: var(--accent-soft); color: var(--accent-light); }
  .n8n-page .n8n-list { display: flex; flex-direction: column; margin-top: 0.5rem; }
  .n8n-page .n8n-entry { border-bottom: 1px solid var(--border-subtle); }
  .n8n-page .n8n-entry:last-child { border-bottom: none; }
  .n8n-page .n8n-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.65rem 0; }
  .n8n-page .n8n-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; background: none; border: none; padding: 0; text-align: left; cursor: pointer; color: inherit; }
  .n8n-page .n8n-row-actions { display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0; }
  .n8n-page .n8n-title { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; max-width: 100%; }
  .n8n-page .n8n-meta { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
  .n8n-page .n8n-pill { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.68rem; font-weight: 600; padding: 0.08rem 0.45rem; border-radius: var(--radius-full); background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-secondary); white-space: nowrap; }
  .n8n-page .n8n-pill.trigger { background: var(--info-soft); border-color: rgba(6, 182, 212, 0.3); color: var(--info); }
  .n8n-page .n8n-pill.ok { background: var(--success-soft); border-color: rgba(16, 185, 129, 0.3); color: var(--success); }
  .n8n-page .n8n-pill.bad { background: var(--danger-soft); border-color: rgba(239, 68, 68, 0.3); color: var(--danger); }
  .n8n-page .n8n-pill.busy { background: var(--warning-soft); border-color: rgba(245, 158, 11, 0.3); color: var(--warning); }
  .n8n-page .n8n-event { font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted); font-weight: 400; }
  .n8n-page .n8n-detail { display: flex; flex-direction: column; gap: 0.45rem; padding: 0 0 0.8rem 3.1rem; }
  .n8n-page .n8n-hook { display: flex; align-items: center; gap: 0.4rem; min-width: 0; flex-wrap: wrap; }
  .n8n-page .n8n-switch { width: 34px; height: 20px; flex-shrink: 0; border-radius: 999px; border: 1px solid var(--border-default); background: var(--bg-sunken); position: relative; padding: 0; cursor: pointer; transition: background var(--transition-fast); }
  .n8n-page .n8n-switch span { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--transition-fast), background var(--transition-fast); }
  .n8n-page .n8n-switch.on { background: var(--success-soft); border-color: var(--success); }
  .n8n-page .n8n-switch.on span { transform: translateX(14px); background: var(--success); }
  .n8n-page .n8n-switch:disabled { opacity: 0.5; cursor: wait; }
  .n8n-page .n8n-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 2.5rem 1rem; color: var(--text-muted); text-align: center; }
  .n8n-page .n8n-empty p { margin: 0; }
  .n8n-page .n8n-table-wrap { overflow-x: auto; margin-top: 0.75rem; }
  .n8n-page .n8n-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  .n8n-page .n8n-table th { text-align: left; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border-default); }
  .n8n-page .n8n-table td { padding: 0.5rem; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
  .n8n-page .n8n-cell-name { color: var(--text-primary); font-weight: 500; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n8n-page .n8n-group { margin-top: 1rem; }
  .n8n-page .n8n-group-title { margin: 0; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .n8n-page .n8n-callbacks { margin: 0.5rem 0 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; }
  .n8n-page .link-button { background: none; border: none; padding: 0; color: var(--accent-light); cursor: pointer; font: inherit; text-decoration: underline; }
  .n8n-page .n8n-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem 1.5rem; margin-top: 0.75rem; }
  .n8n-page .n8n-field { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
  .n8n-page .n8n-env { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.35rem; }
  .n8n-page .n8n-log { margin: 0.75rem 0 0; height: 520px; overflow: auto; font-size: 0.72rem; line-height: 1.5; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 0.75rem; white-space: pre-wrap; word-break: break-all; font-family: var(--font-mono); }
  .n8n-page .spin { animation: n8n-spin 1s linear infinite; }
  @keyframes n8n-spin { to { transform: rotate(360deg); } }
  @media (max-width: 640px) { .n8n-page .n8n-detail { padding-left: 0; } .n8n-page .n8n-row { flex-wrap: wrap; } }
`
      }}
    />
  );
}
