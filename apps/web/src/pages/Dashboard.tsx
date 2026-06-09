import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Rocket,
  Activity,
  Cpu,
  Database as DbIcon,
  ArrowUpRight,
  AlertTriangle,
  Clock,
  ExternalLink,
  Server,
  HardDrive,
  ChevronRight,
  Plus
} from "lucide-react";

import { api } from "../lib/api";
import { connectLogs, type LiveStatus } from "../lib/ws";
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
  port?: number;
};

type Deployment = {
  id: string;
  service_id: string;
  status: string;
  commit_hash: string;
  created_at: string;
  branch?: string;
};

type MetricsMap = Record<string, { cpu: number; memoryMb: number; timestamp: string }>;

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusDotClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "success" || s === "secure") return "sdot sdot-green";
  if (s === "failed" || s === "error" || s === "crashed") return "sdot sdot-red";
  if (s === "building" || s === "starting" || s === "stopping" || s === "pending") {
    return "sdot sdot-amber";
  }
  return "sdot";
}

function Progress({ value, color }: { value: number; color?: "blue" | "green" | "amber" | "red" }) {
  const safeValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const c = color ?? (safeValue >= 85 ? "red" : safeValue >= 70 ? "amber" : "blue");
  return (
    <div className="progress">
      <div className={`pb pb-${c}`} style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [serviceMetrics, setServiceMetrics] = useState<MetricsMap>({});
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");

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
    ws.onStatus(setLiveStatus);
    const intv = setInterval(() => void load(), 30000);
    return () => {
      ws.close();
      clearInterval(intv);
    };
  }, []);

  const serviceNames = useMemo(
    () => new Map(services.map((service) => [service.id, service.name])),
    [services]
  );
  const runningCount = services.filter((s) => s.status === "running").length;
  const runningPct = services.length ? (runningCount / services.length) * 100 : 0;
  const score = health?.score ?? 100;
  const scoreColor = score >= 80 ? "var(--green)" : score >= 60 ? "var(--amber)" : "var(--red)";
  const memoryPct = Math.round(health?.memoryUsedPercent ?? 0);
  const diskPct = Math.round(health?.disk?.usedPercent ?? 0);
  const platformLabel = metrics
    ? `${metrics.platform} · ${metrics.cpus} vCPUs · load ${health?.loadAvg1m ?? "-"}`
    : "Waiting for node telemetry";

  if (loading) {
    return (
      <div className="page dashboard-page">
        <div className="page-hd">
          <Skeleton style={{ height: "48px", width: "320px" }} />
        </div>
        <div className="metrics-row">
          <Skeleton style={{ height: "132px" }} />
          <Skeleton style={{ height: "132px" }} />
          <Skeleton style={{ height: "132px" }} />
          <Skeleton style={{ height: "132px" }} />
        </div>
        <div className="grid-2">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="page dashboard-page animate-up">
      <div className="page-hd">
        <div>
          <div className="page-title">Overview</div>
          <div className="page-desc flex items-center gap-2">
            <span className={liveStatus === "open" ? "sdot sdot-green" : "sdot sdot-amber"} />
            <span>
              {liveStatus === "open"
                ? "Real-time streaming active"
                : liveStatus === "connecting"
                  ? "Connecting to live stream…"
                  : "Live stream offline"}{" "}
              · {platformLabel}
            </span>
          </div>
        </div>
        <div className="page-hd-actions">
          <Link to="/deployments" className="btn btn-default">
            <Activity size={14} /> View Deployments
          </Link>
          <Link to="/services" className="btn btn-primary">
            <Rocket size={14} /> Deploy New
          </Link>
        </div>
      </div>

      <div className="metrics-row">
        <div className="card metric-card">
          <div className="metric-lbl">Services Running</div>
          <div className="metric-val">
            {runningCount}
            <span className="unit"> / {services.length}</span>
          </div>
          <div className="metric-sub">{services.length - runningCount} idle or unavailable</div>
          <Progress value={runningPct} color="green" />
        </div>
        <div className="card metric-card">
          <div className="metric-lbl">Health Score</div>
          <div className="metric-val" style={{ color: scoreColor }}>
            {score}
            <span className="unit">%</span>
          </div>
          <div className="metric-sub">
            {health?.warnings.length ? `${health.warnings.length} active alert` : "All systems nominal"}
          </div>
          <Progress value={score} color={score >= 80 ? "green" : score >= 60 ? "amber" : "red"} />
        </div>
        <div className="card metric-card">
          <div className="metric-lbl">Memory Usage</div>
          <div className="metric-val">
            {memoryPct}
            <span className="unit">%</span>
          </div>
          <div className="metric-sub">
            {metrics ? `${fmtBytes(metrics.totalMemory - metrics.freeMemory)} of ${fmtBytes(metrics.totalMemory)}` : "-"}
          </div>
          <Progress value={memoryPct} />
        </div>
        <div className="card metric-card">
          <div className="metric-lbl">Disk Usage</div>
          <div className="metric-val">
            {diskPct}
            <span className="unit">%</span>
          </div>
          <div className="metric-sub">
            {health?.disk ? `${fmtBytes(health.disk.freeBytes)} free on ${health.disk.path}` : "Not reported"}
          </div>
          <Progress value={diskPct} />
        </div>
      </div>

      {(health?.warnings.length ?? 0) > 0 &&
        (() => {
          const warning = health?.warnings[0] ?? "";
          // Resolve the warning to a concrete service so "View Logs" is a real
          // drill-down instead of a no-op toast. Match a service name appearing
          // in the warning text; otherwise fall back to the services list.
          const affected = services.find((service) => warning.toLowerCase().includes(service.name.toLowerCase()));
          return (
            <div className="alert alert-amber">
              <AlertTriangle size={15} style={{ color: "var(--amber)", flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div className="alert-title">Maintenance Alert</div>
                <div className="text-sm muted">{warning}</div>
              </div>
              <Link
                to={affected ? `/services/${affected.id}/logs` : "/services"}
                className="btn btn-sm btn-default"
              >
                View Logs
              </Link>
            </div>
          );
        })()}

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <span className="card-title">Recent Deployments</span>
            <Link to="/deployments" className="card-link">
              View all <ArrowUpRight size={12} />
            </Link>
          </div>
          {deployments.length === 0 ? (
            <div className="empty-state">
              <Clock size={28} />
              <span>No recent deployments</span>
              <div className="empty-actions">
                <Link to="/deployments" className="btn btn-sm btn-primary">
                  <Activity size={14} /> View Deployments
                </Link>
              </div>
            </div>
          ) : (
            deployments.slice(0, 5).map((deployment) => (
              <Link key={deployment.id} to="/deployments" className="list-row row-link">
                <span className={statusDotClass(deployment.status)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw500 truncate" style={{ fontSize: 13 }}>
                    {serviceNames.get(deployment.service_id) ?? "Service"}
                  </div>
                  <div className="text-xs muted truncate" style={{ marginTop: 1 }}>
                    {deployment.status} · {deployment.branch ?? "main"}
                  </div>
                </div>
                <div className="fcol items-end gap-1" style={{ flexShrink: 0 }}>
                  <span className="hash">{deployment.commit_hash.slice(0, 7)}</span>
                  <span className="text-xs dimmed">{relativeTime(deployment.created_at)}</span>
                </div>
                <ChevronRight size={14} className="row-chevron" />
              </Link>
            ))
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Service Health</span>
            <Link to="/services" className="card-link">
              Manage <ArrowUpRight size={12} />
            </Link>
          </div>
          {services.length === 0 ? (
            <div className="empty-state">
              <Server size={28} />
              <span>No services yet</span>
              <div className="empty-actions">
                <Link to="/services" className="btn btn-sm btn-primary">
                  <Plus size={14} /> Create a Service
                </Link>
              </div>
            </div>
          ) : (
            services.map((service) => {
              const m = serviceMetrics[service.id];
              return (
                <Link key={service.id} to={`/services/${service.id}/logs`} className="list-row row-link">
                  <span className={statusDotClass(service.status)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fw500 truncate" style={{ fontSize: 13 }}>
                      {service.name}
                    </div>
                    <div className="text-xs muted truncate" style={{ marginTop: 1 }}>
                      {service.domain || (service.port ? `localhost:${service.port}` : service.type)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs muted" style={{ flexShrink: 0 }}>
                    {m ? (
                      <>
                        <span className="flex items-center gap-1">
                          <Cpu size={11} />
                          <span className="metric-inline">{m.cpu.toFixed(0)}%</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive size={11} />
                          <span className="metric-inline">{Math.round(m.memoryMb)}MB</span>
                        </span>
                      </>
                    ) : (
                      <span>-</span>
                    )}
                  </div>
                  <ChevronRight size={14} className="row-chevron" />
                </Link>
              );
            })
          )}
        </div>
      </div>

      {health?.score === 100 && services.length > 0 && (
        <div className="flex items-center gap-2 muted text-xs" style={{ justifyContent: "center" }}>
          <DbIcon size={13} />
          <span>All systems operational · node synchronized</span>
        </div>
      )}
    </div>
  );
}
