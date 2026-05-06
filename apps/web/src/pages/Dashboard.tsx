import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Rocket,
  Activity,
  Cpu,
  Database as DbIcon,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Server
} from "lucide-react";

import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";

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
};

type Deployment = {
  id: string;
  service_id: string;
  status: string;
  commit_hash: string;
  created_at: string;
};

type MetricsMap = Record<string, { cpu: number; memoryMb: number; timestamp: string }>;

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function Sparkline({ values, color = "var(--accent)" }: { values: number[]; color?: string }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - (v / max) * 100}`).join(" ");
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height: "40px", width: "100%", marginTop: "1rem" }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={`M 0 100 L ${pts} L 100 100 Z`} fill={color} fillOpacity="0.1" />
    </svg>
  );
}

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [serviceMetrics, setServiceMetrics] = useState<MetricsMap>({});
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);

  // Mock Sparkline data for visual flair
  const [cpuHistory] = useState(() => Array.from({ length: 20 }, () => Math.random() * 50 + 10));
  const [memHistory] = useState(() => Array.from({ length: 20 }, () => Math.random() * 30 + 40));

  async function load() {
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
      setDeployments(deps.slice(0, 6));
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (
        typeof payload === "object" &&
        payload &&
        ["service_status", "deployment_finished", "metrics_sample", "notification"].includes(
          (payload as any).type
        )
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

  async function quickAction(serviceId: string, kind: "start" | "restart") {
    try {
      await api(`/services/${serviceId}/${kind}`, { method: "POST" });
      toast.success(`${kind} successfully sent`);
      await load();
    } catch {
      /* toasted */
    }
  }

  const runningCount = services.filter((s) => s.status === "running").length;
  const scoreColor = health
    ? health.score >= 80
      ? "var(--success)"
      : health.score >= 50
        ? "var(--warning)"
        : "var(--danger)"
    : "var(--text-muted)";

  if (loading) {
    return (
      <div className="dashboard-page">
        <header className="page-header">
          <Skeleton style={{ height: "3rem", width: "400px" }} />
        </header>
        <div
          className="metric-group"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "1.5rem",
            marginBottom: "3rem"
          }}
        >
          <Skeleton style={{ height: "140px" }} />
          <Skeleton style={{ height: "140px" }} />
          <Skeleton style={{ height: "140px" }} />
          <Skeleton style={{ height: "140px" }} />
        </div>
        <div className="grid">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Node Overview</h2>
          <div className="row muted small">
            <Activity size={14} className="text-accent" />
            <span>Infrastructure Real-time streaming active • {metrics?.platform}</span>
          </div>
        </div>
        <div className="row">
          <Link to="/services" className="button primary">
            <Rocket size={18} /> Deploy New
          </Link>
        </div>
      </header>

      <div
        className="metric-group"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "1.5rem",
          marginBottom: "4rem"
        }}
      >
        <motion.div className="card metric-card" whileHover={{ y: -5 }}>
          <div className="row between">
            <span className="muted font-bold small uppercase">Capacity</span>
            <Server size={14} className="text-muted" />
          </div>
          <div className="metric-value font-bold" style={{ fontSize: "2rem", marginTop: "0.5rem" }}>
            {runningCount}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: "1rem" }}>
              / {services.length}
            </span>
          </div>
          <p className="muted tiny uppercase font-bold" style={{ marginTop: "0.5rem" }}>
            Active Processes
          </p>
          <Sparkline values={cpuHistory} color="var(--accent)" />
        </motion.div>

        <motion.div className="card metric-card" whileHover={{ y: -5 }}>
          <div className="row between">
            <span className="muted font-bold small uppercase">Health Score</span>
            <Activity size={14} className="text-muted" />
          </div>
          <div
            className="metric-value font-bold"
            style={{ fontSize: "2rem", marginTop: "0.5rem", color: scoreColor }}
          >
            {health?.score ?? 100}
            <span className="muted" style={{ fontWeight: 400, fontSize: "1rem" }}>
              %
            </span>
          </div>
          <p className="muted tiny uppercase font-bold" style={{ marginTop: "0.5rem" }}>
            {health?.warnings.length ? `${health.warnings.length} Active Alerts` : "Node Optimal"}
          </p>
          <Sparkline values={Array.from({ length: 20 }, () => Math.random() * 10 + 90)} color={scoreColor} />
        </motion.div>

        <motion.div className="card metric-card" whileHover={{ y: -5 }}>
          <div className="row between">
            <span className="muted font-bold small uppercase">Memory</span>
            <Cpu size={14} className="text-muted" />
          </div>
          <div className="metric-value font-bold" style={{ fontSize: "2rem", marginTop: "0.5rem" }}>
            {health?.memoryUsedPercent ?? 0}
            <span className="muted" style={{ fontWeight: 400, fontSize: "1rem" }}>
              %
            </span>
          </div>
          <p className="muted tiny uppercase font-bold" style={{ marginTop: "0.5rem" }}>
            {metrics ? fmtBytes(metrics.totalMemory - metrics.freeMemory) : "—"} In Use
          </p>
          <Sparkline values={memHistory} color="var(--warning)" />
        </motion.div>

        <motion.div className="card metric-card" whileHover={{ y: -5 }}>
          <div className="row between">
            <span className="muted font-bold small uppercase">Storage</span>
            <DbIcon size={14} className="text-muted" />
          </div>
          <div className="metric-value font-bold" style={{ fontSize: "2rem", marginTop: "0.5rem" }}>
            {health?.disk?.usedPercent ?? 0}
            <span className="muted" style={{ fontWeight: 400, fontSize: "1rem" }}>
              %
            </span>
          </div>
          <p className="muted tiny uppercase font-bold" style={{ marginTop: "0.5rem" }}>
            {health?.disk ? `${fmtBytes(health.disk.freeBytes)} Free` : "N/A"}
          </p>
          <Sparkline values={Array.from({ length: 20 }, () => Math.random() * 5 + 15)} color="var(--info)" />
        </motion.div>
      </div>

      <div className="grid">
        <section className="card glass-card">
          <div className="section-title">
            <h3>Recent Activity</h3>
            <Link to="/deployments" className="link small row">
              View Pipeline <ArrowUpRight size={14} />
            </Link>
          </div>
          {deployments.length === 0 ? (
            <div className="muted italic text-center" style={{ padding: "4rem" }}>
              <Clock size={40} style={{ opacity: 0.2, marginBottom: "1rem" }} />
              <p>No recent synchronization detected</p>
            </div>
          ) : (
            <div className="list">
              {deployments.map((d) => {
                const svc = services.find((s) => s.id === d.service_id);
                return (
                  <div key={d.id} className="list-item row between">
                    <div className="row">
                      <StatusBadge status={d.status} dotOnly />
                      <div>
                        <div className="font-bold small">{svc?.name ?? "Service"}</div>
                        <div className="tiny muted">
                          {new Date(d.created_at).toLocaleTimeString()} • {d.status}
                        </div>
                      </div>
                    </div>
                    <div className="row">
                      <code
                        className="muted small"
                        style={{
                          background: "var(--bg-sunken)",
                          padding: "0.2rem 0.4rem",
                          borderRadius: "4px"
                        }}
                      >
                        {d.commit_hash.slice(0, 7)}
                      </code>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card glass-card">
          <div className="section-title">
            <h3>Service Health</h3>
            <Link to="/services" className="link small row">
              Manage Services <ArrowUpRight size={14} />
            </Link>
          </div>
          {services.length === 0 ? (
            <div className="muted italic text-center" style={{ padding: "4rem" }}>
              <Server size={40} style={{ opacity: 0.2, marginBottom: "1rem" }} />
              <p>Zero services found. Launch your first app.</p>
            </div>
          ) : (
            <div className="list">
              {services.map((service) => {
                const m = serviceMetrics[service.id];
                return (
                  <div key={service.id} className="list-item row between">
                    <div className="row">
                      <StatusBadge status={service.status} dotOnly />
                      <div>
                        <span className="font-bold small">{service.name}</span>
                        {service.domain && <div className="tiny muted">{service.domain}</div>}
                      </div>
                    </div>
                    <div className="row">
                      {m ? (
                        <div className="row tiny font-bold muted">
                          <div className="row" title="CPU Usage">
                            <Cpu size={12} />
                            {m.cpu.toFixed(0)}%
                          </div>
                          <div className="row" title="Memory">
                            <DbIcon size={12} />
                            {Math.round(m.memoryMb)}MB
                          </div>
                        </div>
                      ) : (
                        <span className="muted tiny">&mdash;</span>
                      )}
                      <button className="ghost xsmall" onClick={() => quickAction(service.id, "restart")}>
                        ↻
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {(health?.warnings.length ?? 0) > 0 && (
        <motion.section
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card"
          style={{
            marginTop: "3rem",
            border: "1.5px solid var(--warning)",
            background: "rgba(245,158,11,0.05)"
          }}
        >
          <header className="section-title">
            <div className="row">
              <AlertTriangle className="text-warning" size={24} />
              <h3>Action Required: Maintenance Alerts</h3>
            </div>
            <StatusBadge status="warning" />
          </header>
          <div
            className="alert-grid"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}
          >
            {health?.warnings.map((w, i) => (
              <div
                key={i}
                className="alert-item row"
                style={{
                  padding: "1.25rem",
                  background: "var(--bg-sunken)",
                  borderRadius: "var(--radius-md)",
                  borderLeft: "4px solid var(--warning)"
                }}
              >
                <div className="row" style={{ flex: 1 }}>
                  <span className="small font-bold" style={{ color: "var(--text-primary)" }}>
                    {w}
                  </span>
                </div>
                <button
                  className="ghost tiny uppercase font-bold"
                  onClick={() => toast.info("View logs for resolution steps.")}
                >
                  Resolve <ExternalLink size={12} />
                </button>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {health?.score === 100 && services.length > 0 && (
        <div
          className="row center muted"
          style={{ marginTop: "4rem", opacity: 0.5, justifyContent: "center" }}
        >
          <CheckCircle2 size={16} className="text-success" />
          <span className="tiny font-bold uppercase">
            All systems operational • Cluster in synchronization
          </span>
        </div>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .dashboard-page .list { display: flex; flex-direction: column; gap: 0.5rem; }
        .dashboard-page .list-item { 
          padding: 1rem 0.5rem; 
          border-bottom: 1px solid var(--border-subtle);
          transition: var(--transition-fast);
        }
        .dashboard-page .list-item:hover { background: rgba(255,255,255,0.02); }
        .dashboard-page .list-item:last-child { border-bottom: none; }
        .dashboard-page .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .dashboard-page .font-bold { font-weight: 700; }
        .dashboard-page .tiny { font-size: 0.75rem; }
        .dashboard-page .xsmall { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
        .dashboard-page .glass-card { background: var(--bg-glass); border-color: var(--border-subtle); }
      `
        }}
      />
    </div>
  );
}
