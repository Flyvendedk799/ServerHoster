import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Metrics = {
  uptime: number;
  totalMemory: number;
  freeMemory: number;
  cpus: number;
  platform: string;
};

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [onboarding, setOnboarding] = useState<{ hasProjects: boolean; authEnabled: boolean } | null>(null);

  useEffect(() => {
    void api<Metrics>("/metrics/system").then(setMetrics);
    void api<{ hasProjects: boolean; authEnabled: boolean }>("/onboarding").then(setOnboarding);
  }, []);

  return (
    <section>
      <h2>Overview</h2>
      {!onboarding?.hasProjects && <p className="card">No projects yet. Start by creating a project and service.</p>}
      <div className="grid">
        <div className="card">Platform: {metrics?.platform ?? "-"}</div>
        <div className="card">CPUs: {metrics?.cpus ?? "-"}</div>
        <div className="card">Uptime: {metrics ? `${Math.floor(metrics.uptime)}s` : "-"}</div>
        <div className="card">
          Memory:{" "}
          {metrics
            ? `${Math.round((metrics.totalMemory - metrics.freeMemory) / 1024 / 1024)}MB used`
            : "-"}
        </div>
        <div className="card">Auth: {onboarding?.authEnabled ? "enabled" : "disabled"}</div>
      </div>
    </section>
  );
}
