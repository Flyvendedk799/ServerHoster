import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, Play, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { StatusBadge } from "../components/StatusBadge";

type Pipeline = {
  id: string;
  service_id: string;
  service_name: string;
  github_repo_url?: string | null;
  github_branch?: string | null;
  name: string;
  enabled: number;
  gate_deploy: number;
  config_source: string;
  inline_config: string | null;
  image: string;
  timeout_minutes: number;
  memory_mb: number;
  cpus: number;
  trigger_branches?: string | null;
  trigger_pull_requests?: number | null;
  auto_created?: number | null;
  last_status?: string | null;
  last_run_at?: string | null;
  last_commit?: string | null;
};

type Attachable = { id: string; name: string; github_repo_url: string; github_branch?: string | null };

type Run = {
  id: string;
  pipeline_id: string;
  service_id: string;
  service_name?: string | null;
  commit_hash?: string | null;
  branch?: string | null;
  status: string;
  trigger_source: string;
  event?: string | null;
  pr_number?: number | null;
  status_warning?: string | null;
  deploy_after: number;
  deploy_status?: string | null;
  failure_step?: string | null;
  error?: string | null;
  setup_log?: string;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  steps?: Step[];
};

type Step = {
  id: string;
  position: number;
  name: string;
  status: string;
  exit_code?: number | null;
  log: string;
  started_at?: string | null;
  finished_at?: string | null;
};

type Draft = {
  id: string | null;
  serviceId: string;
  name: string;
  enabled: boolean;
  gateDeploy: boolean;
  configSource: "repo" | "inline";
  inlineConfig: string;
  image: string;
  timeoutMinutes: number;
  memoryMb: number;
  cpus: number;
  triggerBranches: string;
  triggerPullRequests: boolean;
};

type CiSettings = {
  maxConcurrent: number | null;
  budgetPercent: number;
  readonlyRootfs: boolean;
  cacheMaxMb: number;
  workspaceMaxMb: number;
};

type CiSettingsView = {
  host: { cpus: number; totalMemMb: number; freeMemMb: number };
  settings: CiSettings;
  effectiveMaxConcurrent: number;
  running: number;
  reservedMemoryMb: number;
  reservedCpus: number;
  waiting: string | null;
  firewall: { applied: boolean; note: string };
  webhookInsecure: boolean;
  webhookSecretConfigured: boolean;
  publicUrlConfigured: boolean;
  autoAll?: boolean;
  autoWebhooks?: { ready: true; url: string } | { ready: false; reason: string };
};

const EMPTY: Draft = {
  id: null,
  serviceId: "",
  name: "",
  enabled: true,
  gateDeploy: false,
  configSource: "repo",
  inlineConfig: "",
  image: "node:22-bookworm",
  timeoutMinutes: 20,
  memoryMb: 2048,
  cpus: 1,
  triggerBranches: "",
  triggerPullRequests: true
};

function badge(status: string): string {
  if (status === "passed") return "running";
  if (status === "failed") return "error";
  if (status === "running" || status === "queued") return "building";
  return "stopped";
}

function shortSha(sha?: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function duration(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const ms = Date.parse(end || new Date().toISOString()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function CiPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [attachable, setAttachable] = useState<Attachable[]>([]);
  const [example, setExample] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [ciSettings, setCiSettings] = useState<CiSettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<CiSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [searchParams] = useSearchParams();
  const runParam = searchParams.get("run");

  useEffect(() => {
    // Commit statuses on GitHub link here with ?run=<id>.
    if (runParam) setExpanded(runParam);
  }, [runParam]);

  async function loadSettings(): Promise<void> {
    const view = await api<CiSettingsView>("/api/ci/settings", { silent: true });
    setCiSettings(view);
    setSettingsDraft((prev) => prev ?? view.settings);
  }

  async function saveSettings(): Promise<void> {
    if (!settingsDraft) return;
    setSavingSettings(true);
    try {
      const view = await api<CiSettingsView>("/api/ci/settings", {
        method: "PUT",
        body: JSON.stringify(settingsDraft)
      });
      setCiSettings(view);
      setSettingsDraft(view.settings);
      toast.success("CI host settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save CI settings");
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleAutoAll(next: boolean): Promise<void> {
    setSavingSettings(true);
    try {
      const view = await api<CiSettingsView>("/api/ci/settings", {
        method: "PUT",
        body: JSON.stringify({ autoAll: next })
      });
      setCiSettings(view);
      toast.success(next ? "CI is on for every repository" : "Automatic CI for new repositories is off");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the setting");
    } finally {
      setSavingSettings(false);
    }
  }

  async function clearCache(pipeline: Pipeline): Promise<void> {
    const ok = await confirmDialog({
      title: `Clear the dependency cache for ${pipeline.service_name}?`,
      message: "The next run downloads dependencies again. Runs in progress keep their files.",
      confirmLabel: "Clear cache"
    });
    if (!ok) return;
    try {
      await api(`/api/ci/pipelines/${pipeline.id}/cache`, { method: "DELETE" });
      toast.success("Cache cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the cache");
    }
  }

  async function load(): Promise<void> {
    const [pipes, history] = await Promise.all([
      api<{ pipelines: Pipeline[]; attachableServices: Attachable[]; exampleYaml: string }>(
        "/api/ci/pipelines",
        {
          silent: true
        }
      ),
      api<{ runs: Run[] }>("/api/ci/runs", { silent: true })
    ]);
    setPipelines(pipes.pipelines);
    setAttachable(pipes.attachableServices);
    setExample(pipes.exampleYaml);
    setRuns(history.runs);
    setDraft((prev) =>
      prev.serviceId || pipes.attachableServices.length === 0
        ? prev
        : {
            ...prev,
            serviceId: pipes.attachableServices[0].id,
            inlineConfig: prev.inlineConfig || pipes.exampleYaml
          }
    );
  }

  useEffect(() => {
    void load()
      .catch(() => undefined)
      .finally(() => setLoading(false));
    void loadSettings().catch(() => undefined);
    let socket: { close: () => void } | null = null;
    try {
      socket = connectLogs((payload) => {
        const type = typeof payload === "object" && payload ? (payload as { type?: string }).type : undefined;
        if (type === "ci_run") void load().catch(() => undefined);
      });
    } catch {
      /* no websocket */
    }
    return () => socket?.close();
  }, []);

  useEffect(() => {
    if (!expanded) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api<Run>(`/api/ci/runs/${expanded}`, { silent: true })
      .then((run) => {
        if (!cancelled) setDetail(run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [expanded, runs]);

  const busy = runs.some((run) => run.status === "queued" || run.status === "running");

  useEffect(() => {
    if (!busy && !expanded) return;
    const timer = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [busy, expanded]);

  function edit(pipeline: Pipeline): void {
    setDraft({
      id: pipeline.id,
      serviceId: pipeline.service_id,
      name: pipeline.name,
      enabled: pipeline.enabled !== 0,
      gateDeploy: pipeline.gate_deploy !== 0,
      configSource: pipeline.config_source === "inline" ? "inline" : "repo",
      inlineConfig: pipeline.inline_config || example,
      image: pipeline.image,
      timeoutMinutes: pipeline.timeout_minutes,
      memoryMb: pipeline.memory_mb,
      cpus: pipeline.cpus,
      triggerBranches: pipeline.trigger_branches ?? "",
      triggerPullRequests: pipeline.trigger_pull_requests !== 0
    });
    setOpen(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    const body = {
      serviceId: draft.serviceId,
      name: draft.name || undefined,
      enabled: draft.enabled,
      gateDeploy: draft.gateDeploy,
      configSource: draft.configSource,
      inlineConfig: draft.configSource === "inline" ? draft.inlineConfig : null,
      image: draft.image,
      timeoutMinutes: Number(draft.timeoutMinutes),
      memoryMb: Number(draft.memoryMb),
      cpus: Number(draft.cpus),
      triggerBranches: draft.triggerBranches.trim() || null,
      triggerPullRequests: draft.triggerPullRequests
    };
    try {
      if (draft.id)
        await api(`/api/ci/pipelines/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/ci/pipelines", { method: "POST", body: JSON.stringify(body) });
      toast.success(draft.id ? "Pipeline updated" : "Pipeline created");
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the pipeline");
    } finally {
      setSaving(false);
    }
  }

  async function runNow(id: string): Promise<void> {
    try {
      await api(`/api/ci/pipelines/${id}/run`, { method: "POST" });
      toast.success("CI run queued on this machine");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the run");
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await api(`/api/ci/runs/${id}/cancel`, { method: "POST" });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel");
    }
  }

  async function remove(pipeline: Pipeline): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${pipeline.name}?`,
      message: "Past runs for this pipeline are removed. The repository is not touched.",
      confirmLabel: "Delete pipeline",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/ci/pipelines/${pipeline.id}`, { method: "DELETE" });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete");
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="page-title">CI</div>
          <p className="muted">
            Jobs run in Docker on this machine. They never register a GitHub Actions runner, so private
            repositories do not use Actions minutes.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={attachable.length === 0 && !open}
          onClick={() => {
            setDraft({
              ...EMPTY,
              serviceId: attachable[0]?.id ?? "",
              inlineConfig: example
            });
            setOpen(true);
          }}
        >
          <Cpu size={16} /> New pipeline
        </button>
      </header>

      {open && (
        <section className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="section-title">
            <h3>{draft.id ? "Edit pipeline" : "New pipeline"}</h3>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: "1rem", marginTop: "1rem" }}>
            <div className="field-group" style={{ minWidth: 220 }}>
              <label className="tiny font-bold uppercase muted">Service</label>
              {draft.id ? (
                <input
                  value={pipelines.find((p) => p.id === draft.id)?.service_name ?? draft.serviceId}
                  disabled
                />
              ) : (
                <select
                  aria-label="Service"
                  value={draft.serviceId}
                  onChange={(e) => setDraft((d) => ({ ...d, serviceId: e.target.value }))}
                >
                  {attachable.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field-group" style={{ minWidth: 220 }}>
              <label className="tiny font-bold uppercase muted">Name</label>
              <input
                aria-label="Pipeline name"
                placeholder="Optional"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="field-group" style={{ minWidth: 220 }}>
              <label className="tiny font-bold uppercase muted">Image</label>
              <input
                aria-label="Docker image"
                value={draft.image}
                onChange={(e) => setDraft((d) => ({ ...d, image: e.target.value }))}
              />
            </div>
            <div className="field-group" style={{ width: 110 }}>
              <label className="tiny font-bold uppercase muted">Minutes</label>
              <input
                aria-label="Timeout minutes"
                type="number"
                min={1}
                max={120}
                value={draft.timeoutMinutes}
                onChange={(e) => setDraft((d) => ({ ...d, timeoutMinutes: Number(e.target.value) }))}
              />
            </div>
            <div className="field-group" style={{ width: 120 }}>
              <label className="tiny font-bold uppercase muted">Memory MB</label>
              <input
                aria-label="Memory MB"
                type="number"
                min={128}
                max={8192}
                value={draft.memoryMb}
                onChange={(e) => setDraft((d) => ({ ...d, memoryMb: Number(e.target.value) }))}
              />
            </div>
            <div className="field-group" style={{ minWidth: 260, flex: 1 }}>
              <label className="tiny font-bold uppercase muted">Other branches</label>
              <input
                aria-label="Branches to test"
                placeholder="Empty = deploy branch only. e.g. feature/*, release-*"
                value={draft.triggerBranches}
                onChange={(e) => setDraft((d) => ({ ...d, triggerBranches: e.target.value }))}
              />
            </div>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: "1rem", marginTop: "0.75rem" }}>
            <label className="row tiny">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              Enabled
            </label>
            <label className="row tiny">
              <input
                type="checkbox"
                checked={draft.gateDeploy}
                onChange={(e) => setDraft((d) => ({ ...d, gateDeploy: e.target.checked }))}
              />
              Hold deploy until CI passes
            </label>
            <label className="row tiny">
              <input
                type="checkbox"
                checked={draft.triggerPullRequests}
                onChange={(e) => setDraft((d) => ({ ...d, triggerPullRequests: e.target.checked }))}
              />
              Test pull requests into the deploy branch
            </label>
            <label className="row tiny">
              <input
                type="radio"
                name="ci-source"
                checked={draft.configSource === "repo"}
                onChange={() => setDraft((d) => ({ ...d, configSource: "repo" }))}
              />
              Read .survhub/ci.yml from the repo
            </label>
            <label className="row tiny">
              <input
                type="radio"
                name="ci-source"
                checked={draft.configSource === "inline"}
                onChange={() =>
                  setDraft((d) => ({ ...d, configSource: "inline", inlineConfig: d.inlineConfig || example }))
                }
              />
              Inline config
            </label>
          </div>
          <p className="muted tiny" style={{ marginTop: "0.75rem" }}>
            Production env vars are not injected. List the ones a job needs under <code>secrets:</code>. The
            container has no Docker socket and a memory cap ({draft.memoryMb} MB, {draft.timeoutMinutes} min).
            Branch and pull request runs never deploy; pull requests from forks are skipped.
          </p>
          {draft.configSource === "inline" ? (
            <textarea
              aria-label="Inline CI config"
              value={draft.inlineConfig}
              onChange={(e) => setDraft((d) => ({ ...d, inlineConfig: e.target.value }))}
              rows={12}
              style={{
                width: "100%",
                marginTop: "0.75rem",
                fontFamily: "var(--mono, ui-monospace, monospace)"
              }}
            />
          ) : (
            <pre className="logs-viewer" style={{ height: 220, marginTop: "0.75rem" }}>
              {example || "Loading example…"}
            </pre>
          )}
          <div className="row" style={{ marginTop: "1rem", gap: "0.5rem" }}>
            <button
              type="button"
              className="primary"
              disabled={saving || (!draft.id && !draft.serviceId)}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save pipeline"}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="section-title">
          <h3>Pipelines</h3>
          {busy && (
            <span className="row tiny muted">
              <Loader2 size={14} className="animate-spin" /> Running on this host
            </span>
          )}
        </div>
        {ciSettings && (
          <div style={{ marginTop: "0.75rem" }}>
            <label className="row tiny">
              <input
                type="checkbox"
                aria-label="CI for every repository"
                checked={Boolean(ciSettings.autoAll)}
                disabled={savingSettings}
                onChange={(e) => void toggleAutoAll(e.target.checked)}
              />
              <strong>CI for every repository</strong>
            </label>
            <p className="tiny muted" style={{ marginTop: "0.25rem" }}>
              Every service linked to GitHub, including new ones, gets a pipeline and a webhook. A repo is
              only tested when it has a .survhub/ci.yml file; repos without one are skipped and get no status
              on GitHub. Automatic pipelines never hold a deploy. Edit one to change it, or delete it to turn
              CI off for that service.
            </p>
            {ciSettings.autoAll && ciSettings.autoWebhooks && !ciSettings.autoWebhooks.ready && (
              <p className="tiny text-danger" style={{ marginTop: "0.25rem" }}>
                <AlertTriangle size={12} /> Webhooks are not set up yet: {ciSettings.autoWebhooks.reason}
              </p>
            )}
          </div>
        )}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : pipelines.length === 0 ? (
          <p className="muted" style={{ marginTop: "1rem" }}>
            No pipelines yet. Attach one to a service that already deploys from GitHub. A push still notifies
            GitHub for free; the test job stays here.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1rem" }}>
            {pipelines.map((pipeline) => (
              <div key={pipeline.id} className="row between" style={{ gap: "1rem", flexWrap: "wrap" }}>
                <div>
                  <strong>{pipeline.service_name}</strong>
                  <div className="tiny muted">
                    {pipeline.auto_created ? "Automatic · " : ""}
                    {pipeline.config_source === "inline" ? "Inline config" : ".survhub/ci.yml"} ·{" "}
                    {pipeline.image}
                    {pipeline.gate_deploy ? " · holds deploy" : ""}
                    {pipeline.github_branch ? ` · ${pipeline.github_branch}` : ""}
                    {pipeline.trigger_branches ? ` · also ${pipeline.trigger_branches}` : ""}
                    {pipeline.trigger_pull_requests !== 0 ? " · PRs" : ""}
                  </div>
                </div>
                <div className="row" style={{ gap: "0.5rem" }}>
                  {pipeline.last_status && (
                    <StatusBadge status={badge(pipeline.last_status)} label={pipeline.last_status} />
                  )}
                  <button type="button" className="ghost xsmall" onClick={() => void runNow(pipeline.id)}>
                    <Play size={12} /> Run
                  </button>
                  <button type="button" className="ghost xsmall" onClick={() => edit(pipeline)}>
                    Edit
                  </button>
                  <button type="button" className="ghost xsmall" onClick={() => void clearCache(pipeline)}>
                    Clear cache
                  </button>
                  <button type="button" className="ghost xsmall" onClick={() => void remove(pipeline)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {ciSettings && settingsDraft && (
        <section className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="section-title">
            <h3>Host limits</h3>
            <span className="tiny muted">
              {ciSettings.host.cpus} CPUs · {Math.round(ciSettings.host.totalMemMb / 1024)} GB RAM (
              {Math.round(ciSettings.host.freeMemMb / 1024)} GB free) · {ciSettings.running} running
            </span>
          </div>
          {(ciSettings.webhookInsecure || !ciSettings.webhookSecretConfigured) && (
            <p className="tiny text-danger" style={{ marginTop: "0.75rem" }}>
              <AlertTriangle size={12} /> No webhook secret is set
              {ciSettings.webhookInsecure ? " (SURVHUB_WEBHOOK_INSECURE is on)" : ""}. Pull request and branch
              CI stay off until you set SURVHUB_WEBHOOK_SECRET, because anyone could send an unsigned event.
            </p>
          )}
          {!ciSettings.publicUrlConfigured && (
            <p className="tiny muted" style={{ marginTop: "0.5rem" }}>
              Set SURVHUB_PUBLIC_URL to link GitHub commit statuses to this page.
            </p>
          )}
          <div className="row" style={{ flexWrap: "wrap", gap: "1rem", marginTop: "1rem" }}>
            <div className="field-group" style={{ width: 150 }}>
              <label className="tiny font-bold uppercase muted">Parallel jobs</label>
              <input
                aria-label="Parallel jobs"
                type="number"
                min={1}
                max={16}
                placeholder={`Auto (${ciSettings.effectiveMaxConcurrent})`}
                value={settingsDraft.maxConcurrent ?? ""}
                onChange={(e) =>
                  setSettingsDraft((d) =>
                    d ? { ...d, maxConcurrent: e.target.value === "" ? null : Number(e.target.value) } : d
                  )
                }
              />
            </div>
            <div className="field-group" style={{ width: 150 }}>
              <label className="tiny font-bold uppercase muted">Host budget %</label>
              <input
                aria-label="Host budget percent"
                type="number"
                min={10}
                max={90}
                value={settingsDraft.budgetPercent}
                onChange={(e) =>
                  setSettingsDraft((d) => (d ? { ...d, budgetPercent: Number(e.target.value) } : d))
                }
              />
            </div>
            <div className="field-group" style={{ width: 150 }}>
              <label className="tiny font-bold uppercase muted">Cache MB / repo</label>
              <input
                aria-label="Cache MB per repo"
                type="number"
                min={0}
                value={settingsDraft.cacheMaxMb}
                onChange={(e) =>
                  setSettingsDraft((d) => (d ? { ...d, cacheMaxMb: Number(e.target.value) } : d))
                }
              />
            </div>
            <div className="field-group" style={{ width: 150 }}>
              <label className="tiny font-bold uppercase muted">Workspace MB</label>
              <input
                aria-label="Workspace MB"
                type="number"
                min={512}
                value={settingsDraft.workspaceMaxMb}
                onChange={(e) =>
                  setSettingsDraft((d) => (d ? { ...d, workspaceMaxMb: Number(e.target.value) } : d))
                }
              />
            </div>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: "1rem", marginTop: "0.75rem" }}>
            <label className="row tiny">
              <input
                type="checkbox"
                checked={settingsDraft.readonlyRootfs}
                onChange={(e) =>
                  setSettingsDraft((d) => (d ? { ...d, readonlyRootfs: e.target.checked } : d))
                }
              />
              Read-only container filesystem (only /workspace, /cache and /tmp are writable)
            </label>
          </div>
          <p className="muted tiny" style={{ marginTop: "0.75rem" }}>
            A second job starts only while all jobs fit in the budget and RAM stays free; otherwise it waits
            in line. Cache 0 turns caching off. {ciSettings.waiting ? `Waiting: ${ciSettings.waiting}. ` : ""}
            Network: {ciSettings.firewall.note}
          </p>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="primary"
              disabled={savingSettings}
              onClick={() => void saveSettings()}
            >
              {savingSettings ? "Saving…" : "Save host limits"}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-title">
          <h3>Runs</h3>
        </div>
        {runs.length === 0 ? (
          <p className="muted" style={{ marginTop: "1rem" }}>
            Runs show up here when you press Run or when a new commit lands.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1rem" }}>
            {runs.map((run) => (
              <div key={run.id}>
                <button
                  type="button"
                  className="row between"
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: 0,
                    color: "inherit",
                    cursor: "pointer"
                  }}
                  onClick={() => setExpanded((current) => (current === run.id ? null : run.id))}
                >
                  <span className="row" style={{ gap: "0.6rem" }}>
                    {run.status === "passed" ? (
                      <CheckCircle2 size={16} className="text-success" />
                    ) : run.status === "failed" ? (
                      <XCircle size={16} className="text-danger" />
                    ) : (
                      <Loader2 size={16} className={run.status === "running" ? "animate-spin" : ""} />
                    )}
                    <strong>{run.service_name ?? "Service"}</strong>
                    <span className="tiny muted">
                      {shortSha(run.commit_hash)} ·{" "}
                      {run.pr_number ? `PR #${run.pr_number}` : run.branch || "—"} · {run.trigger_source} ·{" "}
                      {duration(run.started_at, run.finished_at)}
                    </span>
                  </span>
                  <StatusBadge
                    status={badge(run.status)}
                    label={run.deploy_status ? `${run.status} · deploy ${run.deploy_status}` : run.status}
                  />
                </button>
                {expanded === run.id && detail?.id === run.id && (
                  <div style={{ marginTop: "0.5rem" }}>
                    {run.error && <p className="tiny text-danger">{detail.error || run.error}</p>}
                    {run.status_warning && (
                      <p className="tiny muted">
                        <AlertTriangle size={12} /> GitHub status: {run.status_warning}
                      </p>
                    )}
                    {detail.setup_log && (
                      <pre className="logs-viewer" style={{ height: 140, marginBottom: "0.5rem" }}>
                        {detail.setup_log}
                      </pre>
                    )}
                    {(detail.steps ?? []).map((step) => (
                      <div key={step.id} style={{ marginBottom: "0.5rem" }}>
                        <div className="tiny">
                          {step.name} · {step.status}
                          {step.exit_code != null ? ` · exit ${step.exit_code}` : ""}
                        </div>
                        {step.log && (
                          <pre className="logs-viewer" style={{ height: 180 }}>
                            {step.log}
                          </pre>
                        )}
                      </div>
                    ))}
                    {(run.status === "queued" || run.status === "running") && (
                      <button type="button" className="ghost xsmall" onClick={() => void cancel(run.id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
