import { useNavigate } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { useSummary } from "../hooks/useSummary";
import { useVault } from "../hooks/useVault";
import { formatBytes, formatUptime, relativeTime } from "../lib/format";
import { ServerSwitcher } from "../components/ServerSwitcher";

/**
 * The screen you actually open on the bus: is everything up, and if not, what.
 * Anything broken sorts to the top — a list ordered by project is a fine
 * desktop affordance and a useless one when you have four seconds and a thumb.
 */
export function HomeScreen() {
  const { active } = useVault();
  const navigate = useNavigate();
  const { data, error, loading, refreshing, refresh, fetchedAt } = useSummary(active);

  const services = data?.services ?? [];
  const trouble = services.filter((s) => s.status === "error" || s.status === "crashed");
  const busy = services.filter((s) => ["starting", "building", "deploying"].includes(s.status));

  return (
    <main className="screen">
      <header className="screen-header">
        <ServerSwitcher />
        <button className="icon-button" onClick={refresh} aria-label="Refresh" disabled={refreshing}>
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" className={refreshing ? "spin" : ""}>
            <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      {error && (
        <p className="notice notice-warn" role="alert">
          {error}
          {data && " — showing the last data this phone received."}
        </p>
      )}

      {loading && !data ? (
        <div className="skeleton-stack" aria-busy="true">
          <div className="skeleton" style={{ height: 96 }} />
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      ) : data ? (
        <>
          <section className="card hero">
            <div className="hero-top">
              <div>
                <h2 className="hero-heading">{data.counts.total} services</h2>
                <p className="muted small">
                  {data.server.platform} · up {formatUptime(data.server.uptimeSeconds)}
                </p>
              </div>
              <div className={`health ${trouble.length > 0 ? "health-bad" : "health-ok"}`}>
                {trouble.length > 0 ? `${trouble.length} down` : "All good"}
              </div>
            </div>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-value">{data.counts.running}</span>
                <span className="stat-label">running</span>
              </div>
              <div className="stat">
                <span className="stat-value">{data.counts.stopped}</span>
                <span className="stat-label">stopped</span>
              </div>
              <div className="stat">
                <span className="stat-value">{data.counts.error}</span>
                <span className="stat-label">errored</span>
              </div>
              <div className="stat">
                <span className="stat-value">{data.system.memoryUsedPercent}%</span>
                <span className="stat-label">memory</span>
              </div>
            </div>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, data.system.memoryUsedPercent)}%` }} />
            </div>
            <p className="muted tiny">
              {formatBytes(data.system.totalMemory - data.system.freeMemory)} of{" "}
              {formatBytes(data.system.totalMemory)} used · load {data.system.loadAvg[0]?.toFixed(2) ?? "—"}{" "}
              across {data.system.cpus} CPUs
            </p>
          </section>

          {trouble.length > 0 && (
            <section>
              <h2 className="section-title">Needs attention</h2>
              <ul className="list">
                {trouble.map((service) => (
                  <li key={service.id}>
                    <button className="row-button" onClick={() => navigate(`/services/${service.id}`)}>
                      <div className="row-main">
                        <span className="row-title">{service.name}</span>
                        <span className="muted tiny">{service.projectName ?? "no project"}</span>
                      </div>
                      <StatusPill status={service.status} small />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {busy.length > 0 && (
            <section>
              <h2 className="section-title">In progress</h2>
              <ul className="list">
                {busy.map((service) => (
                  <li key={service.id}>
                    <button className="row-button" onClick={() => navigate(`/services/${service.id}`)}>
                      <div className="row-main">
                        <span className="row-title">{service.name}</span>
                        <span className="muted tiny">{service.projectName ?? "no project"}</span>
                      </div>
                      <StatusPill status={service.status} small />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="section-title">Recent deploys</h2>
            {data.deployments.length === 0 ? (
              <p className="muted small">Nothing deployed yet.</p>
            ) : (
              <ul className="list">
                {data.deployments.slice(0, 5).map((deployment) => (
                  <li key={deployment.id}>
                    <button
                      className="row-button"
                      onClick={() => navigate(`/services/${deployment.serviceId}`)}
                    >
                      <div className="row-main">
                        <span className="row-title">{deployment.serviceName ?? "Deleted service"}</span>
                        <span className="muted tiny">
                          {relativeTime(deployment.createdAt)}
                          {deployment.commitHash ? ` · ${deployment.commitHash.slice(0, 7)}` : ""}
                        </span>
                      </div>
                      <StatusPill status={deployment.status} small />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="muted tiny center footer-note">
            Updated {relativeTime(fetchedAt ? new Date(fetchedAt).toISOString() : null)}
          </p>
        </>
      ) : (
        <p className="muted">No data yet.</p>
      )}
    </main>
  );
}
