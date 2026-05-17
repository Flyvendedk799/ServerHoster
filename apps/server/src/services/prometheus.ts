import os from "node:os";
import type { AppContext } from "../types.js";
import { snapshotDeployKpis } from "./metrics.js";

/**
 * Minimal Prometheus text-format endpoint. We don't pull in `prom-client`
 * because the metrics we surface are already collected elsewhere — this is
 * just a translator. Disabled by default; flip the `prometheus.enabled`
 * setting (or set `LOCALSURV_PROMETHEUS=1`) to expose `/metrics/prometheus`.
 */

export function isPrometheusEnabled(ctx: AppContext): boolean {
  if (process.env.LOCALSURV_PROMETHEUS === "1") return true;
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'prometheus.enabled'").get() as
    | { value?: string }
    | undefined;
  return row?.value === "1";
}

function quote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderPrometheusText(ctx: AppContext): string {
  const lines: string[] = [];

  // process metrics
  const mem = process.memoryUsage();
  lines.push(`# HELP localsurv_process_resident_bytes Resident set size of the LocalSURV server process.`);
  lines.push(`# TYPE localsurv_process_resident_bytes gauge`);
  lines.push(`localsurv_process_resident_bytes ${mem.rss}`);
  lines.push(`localsurv_process_heap_used_bytes ${mem.heapUsed}`);
  lines.push(`localsurv_process_heap_total_bytes ${mem.heapTotal}`);

  lines.push(`# HELP localsurv_process_uptime_seconds Seconds since the LocalSURV process started.`);
  lines.push(`# TYPE localsurv_process_uptime_seconds counter`);
  lines.push(`localsurv_process_uptime_seconds ${Math.floor(process.uptime())}`);

  // host
  lines.push(`# HELP localsurv_host_load_average 1m load average of the host.`);
  lines.push(`# TYPE localsurv_host_load_average gauge`);
  lines.push(`localsurv_host_load_average ${os.loadavg()[0] ?? 0}`);

  // service counts
  const services = ctx.db
    .prepare("SELECT status, COUNT(*) AS count FROM services GROUP BY status")
    .all() as Array<{
    status: string;
    count: number;
  }>;
  lines.push(`# HELP localsurv_services_total Service count by status.`);
  lines.push(`# TYPE localsurv_services_total gauge`);
  for (const row of services) {
    lines.push(`localsurv_services_total{status="${quote(row.status)}"} ${row.count}`);
  }

  // deployment counts (last hour)
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const deployments = ctx.db
    .prepare("SELECT status, COUNT(*) AS count FROM deployments WHERE created_at >= ? GROUP BY status")
    .all(since) as Array<{ status: string; count: number }>;
  lines.push(`# HELP localsurv_deployments_last_hour_total Deployments in the last hour, by status.`);
  lines.push(`# TYPE localsurv_deployments_last_hour_total counter`);
  for (const row of deployments) {
    lines.push(`localsurv_deployments_last_hour_total{status="${quote(row.status)}"} ${row.count}`);
  }

  // Sequence 4 — deploy KPIs
  const kpi = snapshotDeployKpis();
  lines.push(`# HELP localsurv_deploy_total Total deploys observed since process start.`);
  lines.push(`# TYPE localsurv_deploy_total counter`);
  lines.push(`localsurv_deploy_total ${kpi.totalDeployments}`);
  lines.push(`# HELP localsurv_deploy_failed_total Failed deploys observed since process start.`);
  lines.push(`# TYPE localsurv_deploy_failed_total counter`);
  lines.push(`localsurv_deploy_failed_total ${kpi.failedDeployments}`);
  lines.push(`# HELP localsurv_deploy_failure_stage_total Deploy failures by canonical stage.`);
  lines.push(`# TYPE localsurv_deploy_failure_stage_total counter`);
  for (const [stage, count] of Object.entries(kpi.failureByStage)) {
    lines.push(`localsurv_deploy_failure_stage_total{stage="${quote(stage)}"} ${count}`);
  }
  if (kpi.durationP50Ms !== null) {
    lines.push(`# HELP localsurv_deploy_duration_ms p50/p95 deploy durations (in-process histogram).`);
    lines.push(`# TYPE localsurv_deploy_duration_ms gauge`);
    lines.push(`localsurv_deploy_duration_ms{quantile="0.5"} ${kpi.durationP50Ms}`);
    if (kpi.durationP95Ms !== null) {
      lines.push(`localsurv_deploy_duration_ms{quantile="0.95"} ${kpi.durationP95Ms}`);
    }
  }

  // certificates expiry (days remaining)
  const certs = ctx.db.prepare("SELECT domain, expires_at FROM certificates").all() as Array<{
    domain: string;
    expires_at: number;
  }>;
  if (certs.length > 0) {
    lines.push(`# HELP localsurv_certificate_days_remaining Days until each managed certificate expires.`);
    lines.push(`# TYPE localsurv_certificate_days_remaining gauge`);
    for (const cert of certs) {
      const days = Math.max(0, Math.floor((cert.expires_at - Date.now()) / 86400000));
      lines.push(`localsurv_certificate_days_remaining{domain="${quote(cert.domain)}"} ${days}`);
    }
  }

  return lines.join("\n") + "\n";
}
