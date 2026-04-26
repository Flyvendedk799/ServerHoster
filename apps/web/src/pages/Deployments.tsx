import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";

type Deployment = {
  id: string;
  service_id: string;
  commit_hash: string;
  status: string;
  build_log: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  branch?: string;
  trigger_source?: string;
};

type Service = { id: string; name: string };

type BuildLogMap = Record<string, Array<{ line: string; stream: "stdout" | "stderr" }>>;
type PhaseMap = Record<string, string>;

const STATUS_COLORS: Record<string, { bg: string; border: string; fg: string }> = {
  success: { bg: "#052e1a", border: "#10b981", fg: "#a7f3d0" },
  running: { bg: "#0a1e2e", border: "#3b82f6", fg: "#bfdbfe" },
  failed: { bg: "#2e0a0a", border: "#ef4444", fg: "#fecaca" }
};

function fmtDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return "—";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

export function DeploymentsPage() {
  const [searchParams] = useSearchParams();
  const filterServiceId = searchParams.get("serviceId");
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [form, setForm] = useState({ serviceId: "", repoUrl: "" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [liveLogs, setLiveLogs] = useState<BuildLogMap>({});
  const [phases, setPhases] = useState<PhaseMap>({});
  const [actionPending, setActionPending] = useState<Set<string>>(new Set());
  const terminalRef = useRef<HTMLDivElement>(null);

  async function load(): Promise<void> {
    const [d, s] = await Promise.all([api<Deployment[]>("/deployments"), api<Service[]>("/services")]);
    const filteredDeploys = filterServiceId ? d.filter((item) => item.service_id === filterServiceId) : d;
    setDeployments(filteredDeploys);
    setServices(s);
    if (!form.serviceId && s.length > 0) {
      setForm((prev) => ({ ...prev, serviceId: filterServiceId || s[0].id }));
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as {
        type?: string;
        deploymentId?: string;
        line?: string;
        stream?: "stdout" | "stderr";
        phase?: string;
        status?: string;
      };
      if (typed.type === "build_log" && typed.deploymentId && typed.line) {
        setLiveLogs((prev) => {
          const existing = prev[typed.deploymentId!] ?? [];
          return {
            ...prev,
            [typed.deploymentId!]: [...existing, { line: typed.line!, stream: typed.stream ?? "stdout" }].slice(-2000)
          };
        });
      } else if (typed.type === "build_progress" && typed.deploymentId && typed.phase) {
        setPhases((prev) => ({ ...prev, [typed.deploymentId!]: typed.phase! }));
      } else if (typed.type === "deployment_started" || typed.type === "deployment_finished") {
        void load();
      }
    });
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterServiceId]);

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deploy(): Promise<void> {
    if (!form.serviceId) return;
    try {
      const deployment = await api<Deployment>("/deployments/from-git", {
        method: "POST",
        body: JSON.stringify(form)
      });
      if (deployment.status === "failed") {
        toast.error("Deployment failed — see build log");
        setExpanded((prev) => new Set(prev).add(deployment.id));
      } else {
        toast.success("Deployment completed");
        setForm((prev) => ({ ...prev, repoUrl: "" }));
      }
      await load();
    } catch {
      /* api() already toasted */
    }
  }

  async function redeploy(serviceId: string): Promise<void> {
    setActionPending((prev) => new Set(prev).add(serviceId));
    try {
      await api(`/services/${serviceId}/redeploy`, { method: "POST" });
      toast.success("Redeploy triggered");
      await load();
    } catch {
      /* toasted */
    } finally {
      setActionPending((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
    }
  }

  async function rollback(deploymentId: string, serviceId: string): Promise<void> {
    try {
      const deployment = await api<Deployment>("/deployments/rollback", {
        method: "POST",
        body: JSON.stringify({ deploymentId, serviceId })
      });
      if (deployment.status === "failed") {
        toast.error("Rollback build failed");
        setExpanded((prev) => new Set(prev).add(deployment.id));
      } else {
        toast.success("Rollback completed");
      }
      await load();
    } catch {
      /* toasted */
    }
  }

  const running = useMemo(() => deployments.filter((d) => d.status === "running"), [deployments]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [liveLogs]);

  function renderPhaseBadge(phase: string | undefined): ReactElement {
    const p = phase ?? "queued";
    const colors: Record<string, string> = {
      cloning: "#3b82f6",
      installing: "#f59e0b",
      building: "#8b5cf6",
      starting: "#10b981",
      done: "#10b981",
      failed: "#ef4444",
      queued: "#64748b"
    };
    return (
      <span className="chip" style={{ background: colors[p] ?? "#64748b", color: "white" }}>
        {p}
      </span>
    );
  }

  return (
    <section>
      <h2>Deployments</h2>

      <div className="card form">
        <h3>Deploy from git</h3>
        <select value={form.serviceId} onChange={(event) => setForm((prev) => ({ ...prev, serviceId: event.target.value }))}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        <input
          value={form.repoUrl}
          onChange={(event) => setForm((prev) => ({ ...prev, repoUrl: event.target.value }))}
          placeholder="https://github.com/org/repo.git (optional if service already has repo)"
        />
        <button onClick={() => void deploy()}>Deploy</button>
      </div>

      {running.length > 0 && (
        <div className="card" style={{ borderColor: "#3b82f6" }}>
          <h3 style={{ marginTop: 0 }}>Live build output</h3>
          {running.map((d) => (
            <div key={d.id} style={{ marginBottom: "1rem" }}>
              <div className="row" style={{ gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                <strong>{services.find((s) => s.id === d.service_id)?.name ?? d.service_id}</strong>
                {renderPhaseBadge(phases[d.id])}
                {d.branch && <span className="chip">{d.branch}</span>}
                {d.trigger_source && <span className="chip">{d.trigger_source}</span>}
              </div>
              <div
                ref={terminalRef}
                style={{
                  background: "#020617",
                  border: "1px solid #1e293b",
                  borderRadius: "4px",
                  padding: "0.5rem 0.75rem",
                  fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
                  fontSize: "0.78rem",
                  height: "260px",
                  overflowY: "auto",
                  lineHeight: 1.35,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}
              >
                {(liveLogs[d.id] ?? []).map((entry, i) => (
                  <span
                    key={i}
                    style={{ color: entry.stream === "stderr" ? "#fca5a5" : "#cbd5e1" }}
                  >
                    {entry.line}
                  </span>
                ))}
                {(liveLogs[d.id] ?? []).length === 0 && (
                  <span style={{ color: "#64748b" }}>Waiting for output…</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid">
        {deployments.map((deployment) => {
          const serviceName = services.find((s) => s.id === deployment.service_id)?.name ?? deployment.service_id;
          const colors = STATUS_COLORS[deployment.status] ?? STATUS_COLORS.failed;
          const isExpanded = expanded.has(deployment.id);
          return (
            <div
              key={deployment.id}
              className="card"
              style={{ borderLeft: `4px solid ${colors.border}` }}
            >
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 style={{ margin: 0 }}>{serviceName}</h3>
                  <div className="row" style={{ gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                    <span
                      className="chip"
                      style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.fg }}
                    >
                      {deployment.status}
                    </span>
                    {deployment.branch && <span className="chip">{deployment.branch}</span>}
                    {deployment.trigger_source && <span className="chip">{deployment.trigger_source}</span>}
                    <span className="chip" title="Duration">
                      ⏱ {fmtDuration(deployment.started_at ?? deployment.created_at, deployment.finished_at)}
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: "0.78rem", color: "#64748b" }}>
                  {new Date(deployment.created_at).toLocaleString()}
                </div>
              </div>
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Commit: <code>{deployment.commit_hash ? deployment.commit_hash.slice(0, 10) : "—"}</code>
              </p>

              <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
                <button onClick={() => toggleExpand(deployment.id)}>
                  {isExpanded ? "Hide build log" : "Show build log"}
                </button>
                <button
                  onClick={() => void redeploy(deployment.service_id)}
                  disabled={actionPending.has(deployment.service_id) || deployment.status === "running"}
                  title="Redeploy current branch HEAD"
                >
                  Redeploy
                </button>
                <button
                  onClick={() => void rollback(deployment.id, deployment.service_id)}
                  disabled={deployment.status !== "success"}
                  style={{ background: "#4c1d95" }}
                >
                  Rollback to this
                </button>
              </div>

              {isExpanded && (
                <pre
                  style={{
                    background: "#020617",
                    border: "1px solid #1e293b",
                    padding: "0.75rem",
                    borderRadius: "4px",
                    marginTop: "0.75rem",
                    maxHeight: "320px",
                    overflow: "auto",
                    fontSize: "0.78rem",
                    lineHeight: 1.4
                  }}
                >
                  {deployment.build_log || "(no build log captured)"}
                </pre>
              )}
            </div>
          );
        })}
        {deployments.length === 0 && <p style={{ color: "#64748b" }}>No deployments yet.</p>}
      </div>
    </section>
  );
}
