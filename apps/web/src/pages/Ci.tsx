import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, Loader2, Play, XCircle } from "lucide-react";
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
  cpus: 1
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
      cpus: pipeline.cpus
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
      cpus: Number(draft.cpus)
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
                    {pipeline.config_source === "inline" ? "Inline config" : ".survhub/ci.yml"} ·{" "}
                    {pipeline.image}
                    {pipeline.gate_deploy ? " · holds deploy" : ""}
                    {pipeline.github_branch ? ` · ${pipeline.github_branch}` : ""}
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
                  <button type="button" className="ghost xsmall" onClick={() => void remove(pipeline)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

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
                      {shortSha(run.commit_hash)} · {run.branch || "—"} · {run.trigger_source} ·{" "}
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
