import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  GitCommit,
  Clock,
  Terminal as TerminalIcon,
  Rocket,
  History,
  Search,
  Copy,
  Maximize2,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Loader2
} from "lucide-react";

import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton } from "../components/ui/Skeleton";

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

type Service = { id: string; name: string; github_repo_url?: string };
type BuildLogMap = Record<string, Array<{ line: string; stream: "stdout" | "stderr" }>>;
type PhaseMap = Record<string, string>;

function fmtDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return "—";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

export function DeploymentsPage() {
  const [searchParams] = useSearchParams();
  const filterServiceId = searchParams.get("serviceId");
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({ serviceId: "", repoUrl: "" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [liveLogs, setLiveLogs] = useState<BuildLogMap>({});
  const [phases, setPhases] = useState<PhaseMap>({});

  const terminalRef = useRef<HTMLDivElement>(null);

  async function load(): Promise<void> {
    try {
      const [d, s] = await Promise.all([
        api<Deployment[]>("/deployments", { silent: true }),
        api<Service[]>("/services", { silent: true })
      ]);
      const filteredDeploys = filterServiceId ? d.filter((item) => item.service_id === filterServiceId) : d;
      setDeployments(filteredDeploys);
      setServices(s);
      if (!form.serviceId && s.length > 0) {
        setForm((prev) => ({ ...prev, serviceId: filterServiceId || s[0].id }));
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as any;
      if (typed.type === "build_log" && typed.deploymentId) {
        setLiveLogs((prev) => {
          const existing = prev[typed.deploymentId!] ?? [];
          return {
            ...prev,
            [typed.deploymentId!]: [
              ...existing,
              { line: typed.line!, stream: typed.stream ?? "stdout" }
            ].slice(-2000)
          };
        });
      } else if (typed.type === "build_progress" && typed.deploymentId) {
        setPhases((prev) => ({ ...prev, [typed.deploymentId!]: typed.phase! }));
      } else if (typed.type === "deployment_started" || typed.type === "deployment_finished") {
        void load();
      }
    });
    return () => ws.close();
  }, [filterServiceId]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [liveLogs]);

  async function deploy(): Promise<void> {
    try {
      await api("/deployments/from-git", { method: "POST", body: JSON.stringify(form) });
      toast.success("Synchronizing pipeline...");
      setForm((prev) => ({ ...prev, repoUrl: "" }));
      await load();
    } catch {
      /* toasted */
    }
  }

  const running = deployments.filter((d) => d.status === "running" || d.status === "pending");

  if (loading) {
    return (
      <div className="deployments-page">
        <header className="page-header">
          <Skeleton style={{ height: "3rem", width: "400px" }} />
        </header>
        <Skeleton style={{ height: "200px", marginBottom: "3rem" }} />
        <div className="grid">
          <Skeleton style={{ height: "300px" }} />
          <Skeleton style={{ height: "300px" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="deployments-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Deployment Pipeline</h2>
          <p className="muted">End-to-end synchronization for GitOps workflows.</p>
        </div>
        <div className="row">
          <button className="ghost small" onClick={() => load()}>
            <History size={14} /> Refresh History
          </button>
        </div>
      </header>

      <section
        className="card featured-form"
        style={{ marginBottom: "4rem", border: "1px solid var(--border-glow)" }}
      >
        <div className="section-title">
          <div className="row">
            <Rocket className="text-accent" size={20} />
            <h3>Manual Trigger</h3>
          </div>
        </div>
        <div className="row wrap" style={{ gap: "2rem", alignItems: "flex-end" }}>
          <div className="field-group" style={{ flex: 1, minWidth: "240px" }}>
            <label className="tiny font-bold uppercase muted">Target Service</label>
            <select
              value={form.serviceId}
              onChange={(e) => setForm((p) => ({ ...p, serviceId: e.target.value }))}
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group" style={{ flex: 2, minWidth: "320px" }}>
            <label className="tiny font-bold uppercase muted">Repository Overlay (URL)</label>
            <div className="row pr-overlap">
              <GitBranch size={18} className="icon-overlay muted" />
              <input
                className="with-icon"
                placeholder="Leave empty for default upstream..."
                value={form.repoUrl}
                onChange={(e) => setForm((p) => ({ ...p, repoUrl: e.target.value }))}
              />
            </div>
          </div>
          <button className="primary" onClick={() => void deploy()} style={{ height: "48px" }}>
            <GitBranch size={18} /> Initiate Sync
          </button>
        </div>
      </section>

      {running.length > 0 && (
        <section
          className="card active-pipeline"
          style={{
            marginBottom: "4rem",
            border: "1px solid var(--accent)",
            background: "rgba(59,130,246,0.05)"
          }}
        >
          <div className="section-title">
            <div className="row">
              <Loader2 className="animate-spin text-accent" size={20} />
              <h3>Active Build Output</h3>
            </div>
            <div className="row">
              <span className="badge accent pulsate">STREAMING</span>
            </div>
          </div>
          <AnimatePresence>
            {running.map((d) => (
              <motion.div
                key={d.id}
                className="build-container"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                style={{ marginTop: "1rem" }}
              >
                <div className="terminal-header row between">
                  <div className="row small">
                    <TerminalIcon size={14} className="muted" />
                    <span className="font-bold">{services.find((s) => s.id === d.service_id)?.name}</span>
                    <span className="muted">•</span>
                    <span className="text-accent uppercase tiny font-bold">
                      {phases[d.id] ?? "Initializing"}
                    </span>
                  </div>
                  <div className="row">
                    <button
                      className="ghost xsmall"
                      onClick={() => toast.info("Full-screen logs coming soon")}
                    >
                      <Maximize2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="logs-viewer terminal" ref={terminalRef}>
                  {(liveLogs[d.id] ?? []).map((entry, i) => (
                    <div key={i} className={`log-line ${entry.stream}`}>
                      <span className="log-time tiny">[{new Date().toLocaleTimeString()}]</span>
                      <span className="log-msg">{entry.line}</span>
                    </div>
                  ))}
                  {(!liveLogs[d.id] || liveLogs[d.id].length === 0) && (
                    <div className="muted small" style={{ padding: "1rem" }}>
                      Awaiting container orchestrator...
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </section>
      )}

      <div className="section-title">
        <div className="row">
          <History size={18} />
          <h3>Historical Deployments</h3>
        </div>
      </div>

      <div className="grid">
        <AnimatePresence>
          {deployments.length === 0 ? (
            <motion.div
              key="empty"
              className="card text-center"
              style={{ gridColumn: "1 / -1", padding: "6rem 2rem", opacity: 0.6 }}
            >
              <History size={60} className="muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
              <p className="muted italic">No synchronization records in the current context.</p>
            </motion.div>
          ) : (
            deployments.map((d) => (
              <motion.div
                key={d.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className={`card deployment-card ${d.status === "failed" ? "border-danger" : ""}`}
              >
                <div className="service-header">
                  <div className="service-title-group">
                    <h3 className="small">
                      {services.find((s) => s.id === d.service_id)?.name ?? "Legacy Resource"}
                    </h3>
                    <div className="row tiny muted" style={{ marginTop: "0.25rem" }}>
                      <Clock size={10} />
                      <span>{new Date(d.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="row">
                    {d.status === "success" ? (
                      <CheckCircle2 size={18} className="text-success" />
                    ) : d.status === "failed" ? (
                      <XCircle size={18} className="text-danger" />
                    ) : (
                      <Loader2 size={18} className="animate-spin text-accent" />
                    )}
                    <StatusBadge status={d.status} />
                  </div>
                </div>

                <div
                  className="service-body"
                  style={{
                    minHeight: "auto",
                    margin: "1.5rem 0",
                    background: "var(--bg-sunken)",
                    padding: "1rem",
                    borderRadius: "var(--radius-md)"
                  }}
                >
                  <div className="row between tiny">
                    <span className="muted font-bold uppercase">Environment</span>
                    <span className="chip xsmall text-accent font-bold">PRODUCTION</span>
                  </div>
                  <div className="row between tiny" style={{ marginTop: "0.75rem" }}>
                    <span className="muted font-bold uppercase">Revision</span>
                    <div className="row">
                      <GitCommit size={12} className="muted" />
                      <code className="text-accent font-bold">{d.commit_hash.slice(0, 7)}</code>
                    </div>
                  </div>
                  <div className="row between tiny" style={{ marginTop: "0.75rem" }}>
                    <span className="muted font-bold uppercase">Duration</span>
                    <span className="font-bold">
                      {fmtDuration(d.started_at ?? d.created_at, d.finished_at)}
                    </span>
                  </div>
                </div>

                <AnimatePresence>
                  {expanded.has(d.id) && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="logs-viewer small-viewer"
                      style={{ marginTop: "1rem", height: "320px", overflowY: "auto", overflowX: "hidden" }}
                    >
                      {d.build_log ? (
                        d.build_log.split("\n").map((line, i) => (
                          <div key={i} className="log-line">
                            <span className="log-msg tiny" style={{ wordBreak: "break-all" }}>
                              {line}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="muted tiny italic p-2">Binary footprint only (No raw build logs)</div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="service-footer" style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <button
                    className="ghost xsmall"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(d.id)) next.delete(d.id);
                        else next.add(d.id);
                        return next;
                      })
                    }
                  >
                    {expanded.has(d.id) ? "Minimize Logs" : "Inspect Logs"}
                  </button>
                  <button
                    className="ghost xsmall"
                    onClick={() => {
                      navigator.clipboard.writeText(d.build_log);
                      toast.success("Logs buffered to clipboard");
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  {d.status === "failed" && (
                    <button className="ghost xsmall text-danger" style={{ marginLeft: "auto" }}>
                      Retry Build
                    </button>
                  )}
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .deployments-page .active-pipeline { box-shadow: 0 0 40px rgba(59,130,246,0.15); }
        .deployments-page .terminal { height: 400px; }
        .deployments-page .terminal-header { padding: 0.75rem 1rem; background: #111; border-top-left-radius: var(--radius-md); border-top-right-radius: var(--radius-md); border-bottom: 1px solid #333; }
        .deployments-page .log-line.stderr { color: var(--danger); }
        .deployments-page .pulsate { animation: pulse 2s infinite; }
        .deployments-page .animate-spin { animation: spin 2s linear infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .deployments-page .deployment-card.border-danger { border-color: rgba(239, 68, 68, 0.4); }
        .with-icon { padding-left: 2.5rem !important; }
        .pr-overlap { position: relative; width: 100%; }
        .icon-overlay { position: absolute; left: 0.75rem; top: 12px; pointer-events: none; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .tiny { font-size: 0.7rem; }
      `
        }}
      />
    </div>
  );
}
