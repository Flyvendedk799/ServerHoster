import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { ServerSwitcher } from "../components/ServerSwitcher";
import { useSummary } from "../hooks/useSummary";
import { useVault } from "../hooks/useVault";

type Filter = "all" | "running" | "stopped" | "trouble";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "stopped", label: "Stopped" },
  { id: "trouble", label: "Problems" }
];

export function ServicesScreen() {
  const { active } = useVault();
  const navigate = useNavigate();
  const { data, error, loading } = useSummary(active);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const services = data?.services ?? [];
    const needle = query.trim().toLowerCase();
    return services.filter((service) => {
      if (needle && !`${service.name} ${service.projectName ?? ""}`.toLowerCase().includes(needle))
        return false;
      switch (filter) {
        case "running":
          return service.status === "running";
        case "stopped":
          return service.status === "stopped";
        case "trouble":
          return service.status === "error" || service.status === "crashed";
        default:
          return true;
      }
    });
  }, [data, filter, query]);

  // Group by project so the list reads the way the dashboard does, but only
  // once a filter has cut it down to something scrollable.
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof visible>();
    for (const service of visible) {
      const key = service.projectName ?? "Ungrouped";
      const bucket = groups.get(key) ?? [];
      bucket.push(service);
      groups.set(key, bucket);
    }
    return [...groups.entries()];
  }, [visible]);

  return (
    <main className="screen">
      <header className="screen-header">
        <ServerSwitcher />
      </header>

      <input
        className="search"
        type="search"
        placeholder="Search services"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search services"
      />

      <div className="chips" role="tablist" aria-label="Filter services">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? "chip active" : "chip"}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <p className="notice notice-warn">{error}</p>}

      {loading && !data ? (
        <div className="skeleton-stack" aria-busy="true">
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 56 }} />
        </div>
      ) : visible.length === 0 ? (
        <p className="muted center empty">Nothing matches.</p>
      ) : (
        grouped.map(([project, items]) => (
          <section key={project}>
            <h2 className="section-title">{project}</h2>
            <ul className="list">
              {items.map((service) => (
                <li key={service.id}>
                  <button className="row-button" onClick={() => navigate(`/services/${service.id}`)}>
                    <div className="row-main">
                      <span className="row-title">{service.name}</span>
                      <span className="muted tiny">
                        {service.type}
                        {service.port ? ` · :${service.port}` : ""}
                      </span>
                    </div>
                    <StatusPill status={service.status} small />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
