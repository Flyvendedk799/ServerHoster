import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";

type Metrics = {
  uptime: number;
  totalMemory: number;
  freeMemory: number;
  cpus: number;
  platform: string;
};

type SystemHealth = {
  disk: { path: string; totalBytes: number; freeBytes: number; usedPercent: number } | null;
  dockerOk: boolean;
  dockerError: string | null;
  memoryUsedPercent: number;
  loadAvg1m: number;
  score: number;
  warnings: string[];
};

type ServiceRow = {
  id: string;
  name: string;
  status: string;
  type: string;
  domain?: string;
  port?: number;
  ssl_status?: string;
  last_started_at?: string;
};

type Deployment = {
  id: string;
  service_id: string;
  status: string;
  branch?: string;
  trigger_source?: string;
  commit_hash: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
};

type MetricsMap = Record<string, { cpu: number; memoryMb: number; timestamp: string }>;

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function fmtDurationSec(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}



export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [serviceMetrics, setServiceMetrics] = useState<MetricsMap>({});
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  async function load(): Promise<void> {
    try {
      const [m, h, svcs, mts, deps] = await Promise.all([
        api<Metrics>("/metrics/system", { silent: true }),
        api<SystemHealth>("/health/system", { silent: true }),
        api<ServiceRow[]>("/services", { silent: true }),
        api<MetricsMap>("/metrics/services", { silent: true }),
        api<Deployment[]>("/deployments", { silent: true })
      ]);
      setMetrics(m);
      setHealth(h);
      setServices(svcs);
      setServiceMetrics(mts);
      setDeployments(deps.slice(0, 5));
    } catch {
      /* silent */
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (
        typed.type === "service_status" ||
        typed.type === "deployment_finished" ||
        typed.type === "metrics_sample" ||
        typed.type === "notification"
      ) {
        void load();
      }
    });
    const intv = setInterval(() => void load(), 30000);
    return () => {
      ws.close();
      clearInterval(intv);
    };
  }, []);

  async function action(serviceId: string, kind: "start" | "stop" | "restart"): Promise<void> {
    try {
      await api(`/services/${serviceId}/${kind}`, { method: "POST" });
      toast.success(`${kind} sent`);
      await load();
    } catch {
      /* toasted */
    }
  }

  const runningCount = useMemo(() => services.filter((s) => s.status === "running").length, [services]);
  const crashedCount = useMemo(() => services.filter((s) => s.status === "crashed").length, [services]);

  const scoreColor = health
    ? health.score >= 80 ? "#10b981" : health.score >= 50 ? "#f59e0b" : "#ef4444"
    : "#64748b";

  return (
    <section>
      <div className="row" style={{ marginBottom: "var(--space-6)", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Command Center</h2>
        <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>
          Auto-refreshing every 30s
        </div>
      </div>

      <div className="metric-group">
        <div className="card metric-card">
          <div className="metric-label">Services</div>
          <div className="metric-value">
            {runningCount} <span style={{ fontSize: "1.1rem", color: "var(--text-muted)", fontWeight: 400 }}>/ {services.length}</span>
          </div>
          <div className="metric-sub">
            {crashedCount > 0 ? (
              <span style={{ color: "var(--danger)" }}>{crashedCount} crashed</span>
            ) : (
              "All active services healthy"
            )}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">System Score</div>
          <div className="metric-value" style={{ color: scoreColor }}>
            {health ? `${health.score}` : "—"}<span style={{ fontSize: "1.1rem", color: "var(--text-muted)", fontWeight: 400 }}>/100</span>
          </div>
          <div className="metric-sub">
            {health?.warnings.length ? (
              <span style={{ color: "var(--warning)" }}>{health.warnings.length} warning(s)</span>
            ) : (
              "System is optimal"
            )}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Disk Usage</div>
          <div className="metric-value">
            {health?.disk ? `${health.disk.usedPercent}` : "—"}<span style={{ fontSize: "1.1rem", color: "var(--text-muted)", fontWeight: 400 }}>%</span>
          </div>
          <div className="metric-sub">
            {health?.disk ? `${fmtBytes(health.disk.freeBytes)} free` : "unknown"}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Memory</div>
          <div className="metric-value">
            {health ? `${health.memoryUsedPercent}` : "—"}<span style={{ fontSize: "1.1rem", color: "var(--text-muted)", fontWeight: 400 }}>%</span>
          </div>
          <div className="metric-sub">
            {metrics ? `${fmtBytes(metrics.totalMemory - metrics.freeMemory)} used` : "—"}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Docker Engine</div>
          <div className="metric-value" style={{ color: health?.dockerOk ? "var(--success)" : "var(--danger)" }}>
            {health?.dockerOk ? "ACTIVE" : "DOWN"}
          </div>
          <div className="metric-sub text-truncate">
            {health?.dockerError ?? "Daemon reachable"}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Node Uptime</div>
          <div className="metric-value" style={{ fontSize: "1.5rem" }}>
            {metrics ? fmtDurationSec(metrics.uptime) : "—"}
          </div>
          <div className="metric-sub">
            {metrics?.platform ?? "Linux"} • {metrics?.cpus ?? 0} vCPUs
          </div>
        </div>
      </div>

      {health && health.warnings.length > 0 && (
        <div className="card" style={{ borderLeft: "4px solid var(--warning)", background: "var(--warning-soft)", marginBottom: "var(--space-6)" }}>
          <div className="metric-label" style={{ color: "var(--warning)", marginBottom: "var(--space-2)" }}>System Warnings</div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.9rem" }}>
            {health.warnings.map((w, i) => (
              <li key={i} style={{ color: "var(--text-primary)" }}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" style={{ marginBottom: "var(--space-6)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h3 style={{ margin: 0 }}>Active Services</h3>
          <Link to="/services" className="button ghost" style={{ fontSize: "0.8rem" }}>Manage Services →</Link>
        </div>
        {services.length === 0 && <p style={{ color: "var(--text-dim)", textAlign: "center", padding: "var(--space-6)" }}>No services deployed yet.</p>}
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {services.map((service) => {
            const m = serviceMetrics[service.id];
            return (
              <div
                key={service.id}
                className="row"
                style={{
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border-subtle)",
                  padding: "0.75rem 1rem",
                  borderRadius: "var(--radius-sm)",
                  gap: "1rem",
                  alignItems: "center"
                }}
              >
                <StatusBadge status={service.status} dotOnly />
                <div style={{ flex: 1, minWidth: "160px" }}>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{service.name}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", display: "flex", gap: "0.5rem" }}>
                    <span>{service.type}</span>
                    {service.domain && <span style={{ color: "var(--accent)" }}>• {service.domain}</span>}
                    {service.port && <span>• :{service.port}</span>}
                  </div>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", minWidth: "140px", fontFamily: "var(--font-mono)" }}>
                  {m ? (
                    <>
                      <span style={{ color: m.cpu > 50 ? "var(--warning)" : "inherit" }}>CPU {m.cpu.toFixed(1)}%</span>
                      <span style={{ margin: "0 0.4rem", opacity: 0.3 }}>|</span>
                      <span>{Math.round(m.memoryMb)} MB</span>
                    </>
                  ) : "—"}
                </div>
                <div className="row" style={{ gap: "0.4rem" }}>
                  <button className="ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }} onClick={() => void action(service.id, "start")}>Start</button>
                  <button className="ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }} onClick={() => void action(service.id, "stop")}>Stop</button>
                  <button className="ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }} onClick={() => void action(service.id, "restart")}>↻</button>
                  <Link
                    to={`/services/${service.id}/logs`}
                    className="button"
                    style={{
                      padding: "0.3rem 0.6rem",
                      fontSize: "0.72rem",
                      background: "var(--bg-elevated)",
                      textDecoration: "none"
                    }}
                  >
                    Logs
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h3 style={{ margin: 0 }}>Recent Deployments</h3>
          <Link to="/deployments" className="button ghost" style={{ fontSize: "0.8rem" }}>History →</Link>
        </div>
        {deployments.length === 0 && <p style={{ color: "var(--text-dim)", textAlign: "center", padding: "var(--space-4)" }}>No deployment records found.</p>}
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {deployments.map((d) => {
            const svc = services.find((s) => s.id === d.service_id);
            return (
              <div
                key={d.id}
                className="row"
                style={{
                  gap: "1rem",
                  fontSize: "0.85rem",
                  alignItems: "center",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--border-subtle)"
                }}
              >
                <StatusBadge status={d.status} dotOnly />
                <span style={{ minWidth: "140px", fontWeight: 500, color: "var(--text-primary)" }}>{svc?.name ?? d.service_id}</span>
                <StatusBadge status={d.status} />
                {d.branch && <span className="chip">{d.branch}</span>}
                <span style={{ color: "var(--text-dim)", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                  {d.commit_hash ? d.commit_hash.slice(0, 7) : "—"}
                </span>
                <span style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginLeft: "auto" }}>
                  {new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {new Date(d.created_at).toLocaleDateString()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
