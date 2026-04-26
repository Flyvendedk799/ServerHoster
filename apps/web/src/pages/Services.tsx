import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { ServiceSettingsModal } from "../components/ServiceSettingsModal";
import { GitHubDeployModal } from "../components/GitHubDeployModal";
import { CreateServiceModal } from "../components/CreateServiceModal";
import { TemplateModal } from "../components/TemplateModal";
import { ComposeModal } from "../components/ComposeModal";
import { QuickLaunchModal } from "../components/QuickLaunchModal";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";

type Service = {
  id: string;
  name: string;
  type: string;
  status: string;
  project_id: string;
  domain?: string;
  port?: number;
  command?: string;
  working_dir?: string;
  github_repo_url?: string;
  github_branch?: string;
  github_auto_pull?: number;
  latest_commit_hash?: string;
  ssl_status?: string;
  environment?: string;
  depends_on?: string | null;
  linked_database_id?: string | null;
  tunnel_url?: string | null;
  quick_tunnel_enabled?: number;
};

const ENVIRONMENT_COLORS: Record<string, string> = {
  production: "#ef4444",
  staging: "#f59e0b",
  development: "#3b82f6"
};

type Project = {
  id: string;
  name: string;
};

type LogEntry = {
  id?: string;
  service_id?: string;
  serviceId?: string;
  level?: string;
  message: string;
  timestamp?: string;
};

type EnvRow = { id: string; key: string; value: string; is_secret: number };

export function ServicesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [projectIdInitial, setProjectIdInitial] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [serviceEnv, setServiceEnv] = useState<EnvRow[]>([]);
  const [envForm, setEnvForm] = useState({ key: "", value: "", isSecret: false });
  const [composeContent, setComposeContent] = useState("");
  const [template, setTemplate] = useState("node-api");
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComposeModal, setShowComposeModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [envFilter, setEnvFilter] = useState<"all" | "production" | "staging" | "development">("all");

  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  async function load(): Promise<void> {
    const [projectData, serviceData] = await Promise.all([api<Project[]>("/projects"), api<Service[]>("/services")]);
    setProjects(projectData);
    setServices(serviceData);
    if (!projectIdInitial && projectData.length > 0) {
      setProjectIdInitial(projectData[0].id);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) {
        return;
      }
      const typed = payload as { type?: string; message?: string };
      if (typed.type === "log") {
        setLogs((prev) => [payload as LogEntry, ...prev].slice(0, 300));
      }
      if (typed.type === "service_status" || typed.type === "tunnel_url") {
        void load();
      }
    });
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!selectedServiceId && services.length > 0) {
      setSelectedServiceId(services[0].id);
    }
  }, [services, selectedServiceId]);

  useEffect(() => {
    if (!selectedServiceId) return;
    void api<EnvRow[]>(`/services/${selectedServiceId}/env`).then(setServiceEnv);
  }, [selectedServiceId, services]);



  async function serviceAction(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
    await api(`/services/${serviceId}/${action}`, { method: "POST" });
    await load();
  }





  async function deleteService(service: Service): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete service "${service.name}"?`,
      message: "This will stop the service and remove its data from SURVHub.",
      details: [
        "Stops the running process or container",
        "Removes all deployments, logs, env vars, and proxy routes",
        "Cannot be undone"
      ],
      danger: true,
      confirmLabel: "Delete"
    });
    if (!confirmed) return;
    const purgeDisk = await confirmDialog({
      title: "Also remove the cloned source directory?",
      message: "The service's working directory on disk can be removed or kept for inspection.",
      confirmLabel: "Remove directory",
      cancelLabel: "Keep files"
    });
    try {
      await api(`/services/${service.id}?purgeDisk=${purgeDisk ? "true" : "false"}`, { method: "DELETE" });
      toast.success(`Deleted service "${service.name}"`);
      if (selectedServiceId === service.id) setSelectedServiceId("");
      await load();
    } catch {
      /* toasted */
    }
  }

  async function projectBulkAction(projectId: string, action: "start-all" | "stop-all" | "restart-all" | "deploy-all"): Promise<void> {
    const ok = await confirmDialog({
      title: `${action.replace("-", " ")} for project?`,
      message: "This applies to every service in the project.",
      confirmLabel: "Run",
      danger: action === "stop-all"
    });
    if (!ok) return;
    try {
      await api(`/projects/${projectId}/${action}`, { method: "POST" });
      toast.success(`${action} dispatched`);
      await load();
    } catch {
      /* toasted */
    }
  }

  async function toggleAutoPull(serviceId: string, current: boolean): Promise<void> {
    await api(`/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ githubAutoPull: !current })
    });
    await load();
  }

  return (
    <section>
      <div className="row" style={{ marginBottom: "var(--space-6)", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Services</h2>
        <div className="row">
          <label style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Environment:</label>
          <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value as typeof envFilter)} style={{ width: "auto", padding: "0.4rem 0.6rem" }}>
            <option value="all">All</option>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>
        </div>
      </div>

      <div className="grid" style={{ marginBottom: "var(--space-8)", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {/* GitHub Deploy */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", border: "1px solid var(--accent-soft)", background: "rgba(59, 130, 246, 0.03)" }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            <div style={{ color: "var(--accent)", background: "var(--accent-soft)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>GitHub Deployment</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>Connect & deploy from Git</div>
            </div>
          </div>
          <button className="primary" onClick={() => setShowGithubDeploy(true)} style={{ width: "100%" }}>Create Deployment</button>
        </div>

        {/* Manual Service */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            <div style={{ color: "var(--success)", background: "var(--success-soft)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/></svg>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Manual Service</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>Docker, Binary, or Static</div>
            </div>
          </div>
          <button onClick={() => setShowCreateModal(true)} style={{ width: "100%" }}>Configure Manually</button>
        </div>

        {/* Quick Templates */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            <div style={{ color: "var(--warning)", background: "var(--warning-soft)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Quick Templates</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>Node, Python, Static bases</div>
            </div>
          </div>
          <button onClick={() => setShowTemplateModal(true)} style={{ width: "100%" }}>Browse Templates</button>
        </div>

        {/* Docker Compose */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            <div style={{ color: "var(--info)", background: "var(--info-soft)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Docker Compose</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>Import complex stacks</div>
            </div>
          </div>
          <button onClick={() => setShowComposeModal(true)} style={{ width: "100%" }}>Import Compose</button>
        </div>

        {/* Quick Launch */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", border: "2px solid var(--success-soft)", background: "rgba(34,197,94,0.04)" }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            <div style={{ color: "var(--success)", background: "var(--success-soft)", padding: "0.5rem", borderRadius: "var(--radius-sm)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Quick Launch</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>Deploy + get public URL instantly</div>
            </div>
          </div>
          <button className="primary" onClick={() => setShowQuickLaunch(true)} style={{ width: "100%" }}>Launch App</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: "var(--space-4)", flexWrap: "wrap", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Active Deployments</h3>
        <div className="row">
          {projects.map((project) => (
            <div key={project.id} className="row" style={{ background: "var(--bg-sunken)", padding: "0.25rem 0.5rem", borderRadius: "999px", border: "1px solid var(--border-subtle)" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600, paddingLeft: "0.5rem" }}>{project.name}:</span>
              <button className="ghost" onClick={() => void projectBulkAction(project.id, "restart-all")} style={{ padding: "0.2rem 0.4rem", fontSize: "0.7rem" }} title="Restart all services in this project">↻</button>
            </div>
          ))}
        </div>
      </div>

        {services
          .filter((service) => envFilter === "all" || (service.environment ?? "production") === envFilter)
          .map((service) => (
          <div
            key={service.id}
            className="card elevated"
            style={{ 
              borderTop: `4px solid ${ENVIRONMENT_COLORS[service.environment ?? "production"] ?? "#64748b"}`,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)"
            }}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{ margin: 0 }}>{service.name}</h3>
                <div className="row" style={{ marginTop: "0.2rem", gap: "0.4rem" }}>
                  <span className="chip" style={{ fontSize: "0.65rem", padding: "0.1rem 0.4rem" }}>{service.type}</span>
                  <span
                    className="chip"
                    style={{
                      fontSize: "0.65rem",
                      padding: "0.1rem 0.4rem",
                      background: `${ENVIRONMENT_COLORS[service.environment ?? "production"]}15`,
                      color: ENVIRONMENT_COLORS[service.environment ?? "production"],
                      borderColor: "transparent"
                    }}
                  >
                    {service.environment ?? "production"}
                  </span>
                </div>
              </div>
              <button className="ghost" onClick={() => setEditingService(service)} style={{ padding: "0.4rem", borderRadius: "var(--radius-sm)" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.72V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.17a2 2 0 0 1 1-1.74l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>

            <div className="row" style={{ gap: "0.5rem" }}>
              <StatusBadge status={service.status} />
              {service.ssl_status && service.ssl_status !== "none" && (
                <StatusBadge 
                  status={service.ssl_status} 
                  label={service.ssl_status === "secure" ? "SSL Active" : service.ssl_status === "provisioning" ? "SSL Pending" : "SSL Error"} 
                />
              )}
            </div>
            
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", minHeight: "2.5rem" }}>
              {service.domain ? (
                <div className="row" style={{ gap: "0.4rem" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                  <a href={`http://${service.domain}`} target="_blank" rel="noreferrer" className="link" style={{ fontWeight: 500 }}>{service.domain}</a>
                </div>
              ) : (
                <div style={{ color: "var(--text-dim)", fontStyle: "italic" }}>No domain attached</div>
              )}
            </div>

            {/* Quick tunnel URL display */}
            {service.tunnel_url && (
              <div className="row" style={{ gap: "0.4rem", background: "rgba(34,197,94,0.06)", padding: "0.4rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--success-soft)", flexWrap: "wrap" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <a href={service.tunnel_url} target="_blank" rel="noreferrer" className="link" style={{ fontWeight: 600, fontSize: "0.78rem", color: "var(--success)", flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "calc(100% - 6rem)" }}>
                  {service.tunnel_url}
                </a>
                <button className="ghost" style={{ padding: "0.15rem 0.4rem", fontSize: "0.7rem", marginLeft: "auto" }} onClick={() => { void navigator.clipboard.writeText(service.tunnel_url!); toast.success("URL copied!"); }} title="Copy tunnel URL">Copy</button>
                <button className="ghost" style={{ padding: "0.15rem 0.4rem", fontSize: "0.7rem", color: "var(--danger)" }} onClick={() => void api(`/cloudflare/quick-tunnel/${service.id}`, { method: "DELETE" }).then(() => load())} title="Stop quick tunnel">Stop</button>
              </div>
            )}
            {!service.tunnel_url && service.status === "running" && (
              <button className="ghost" style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", color: "var(--accent)", alignSelf: "flex-start" }} onClick={() => void api(`/cloudflare/quick-tunnel/${service.id}`, { method: "POST" }).then(() => load())}>
                + Get public URL
              </button>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {service.github_repo_url && (
                <div className="row" style={{ gap: "0.5rem", fontSize: "0.78rem" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                  <span style={{ color: "var(--text-muted)" }}>{service.github_repo_url.split("/").slice(-2).join("/")}</span>
                  <span className="chip" style={{ fontSize: "0.65rem", padding: "0 0.3rem" }}>{service.github_branch || "main"}</span>
                </div>
              )}

              {service.latest_commit_hash && (
                <div className="row" style={{ gap: "0.5rem", fontSize: "0.78rem" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v7c0 1.1.9 2 2 2h7M18 15V9"/></svg>
                  <code style={{ fontSize: "0.75rem", color: "var(--accent)" }}>{service.latest_commit_hash.slice(0, 7)}</code>
                  <Link to={`/deployments?serviceId=${service.id}`} className="link" style={{ fontSize: "0.75rem" }}>History</Link>
                </div>
              )}
            </div>

            <div className="row" style={{ marginTop: "var(--space-2)", gap: "0.4rem", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-3)" }}>
              <button className="ghost" style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem" }} onClick={() => void serviceAction(service.id, "start")}>Start</button>
              <button className="ghost" style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem" }} onClick={() => void serviceAction(service.id, "stop")}>Stop</button>
              <button className="ghost" style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem" }} onClick={() => void serviceAction(service.id, "restart")}>↻</button>
              <Link
                to={`/services/${service.id}/logs`}
                className="button ghost"
                style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem", textDecoration: "none" }}
              >
                Logs
              </Link>
              <button
                className="btn-danger"
                onClick={() => void deleteService(service)}
                style={{ marginLeft: "auto", padding: "0.4rem 0.6rem", fontSize: "0.75rem" }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}

      <div className="card">
        <h3>Live logs</h3>
        <div className="logs">
          {logs.map((log, index) => (
            <p key={`${log.timestamp ?? "ts"}-${index}`}>
              [{log.level ?? "info"}] {log.message}
            </p>
          ))}
        </div>
      </div>

      {editingService && (
        <ServiceSettingsModal
          service={editingService}
          onClose={() => setEditingService(null)}
          onUpdated={() => void load()}
        />
      )}

      {showGithubDeploy && (
        <GitHubDeployModal
          projects={projects}
          onClose={() => setShowGithubDeploy(false)}
          onDeployed={() => void load()}
        />
      )}

      {showCreateModal && (
        <CreateServiceModal
          projects={projects}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => void load()}
        />
      )}

      {showTemplateModal && (
        <TemplateModal
          onClose={() => setShowTemplateModal(false)}
          onCreated={() => void load()}
        />
      )}

      {showComposeModal && (
        <ComposeModal
          projects={projects}
          onClose={() => setShowComposeModal(false)}
          onImported={() => void load()}
        />
      )}

      {showQuickLaunch && (
        <QuickLaunchModal
          projects={projects}
          onClose={() => setShowQuickLaunch(false)}
          onLaunched={() => { setShowQuickLaunch(false); void load(); }}
        />
      )}
    </section>
  );
}
