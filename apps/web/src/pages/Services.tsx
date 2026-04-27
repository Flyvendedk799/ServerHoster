import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  GitBranch,
  Box,
  Zap,
  Trash2,
  Play,
  Square,
  RotateCw,
  Terminal,
  Globe,
  Settings2,
  Layers,
  Filter,
  Search,
  ExternalLink,
  Activity
} from "lucide-react";

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
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";

type Service = {
  id: string;
  name: string;
  type: string;
  status: string;
  project_id: string;
  domain?: string;
  port?: number;
  github_repo_url?: string;
  github_branch?: string;
  latest_commit_hash?: string;
  ssl_status?: string;
  environment?: string;
  tunnel_url?: string | null;
};

type Project = {
  id: string;
  name: string;
};

type LogEntry = {
  level?: string;
  message: string;
  timestamp?: string;
};

export function ServicesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingService, setEditingService] = useState<Service | null>(null);
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComposeModal, setShowComposeModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);

  const [envFilter, setEnvFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByProject, setGroupByProject] = useState(false);

  async function load(): Promise<void> {
    try {
      const [projectData, serviceData] = await Promise.all([
        api<Project[]>("/projects", { silent: true }),
        api<Service[]>("/services", { silent: true })
      ]);
      setProjects(projectData);
      setServices(serviceData);
    } catch (err) { /* silent */ } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "log" && (payload as LogEntry).message) {
         setLogs((prev) => [payload as LogEntry, ...prev].slice(0, 50));
      }
      if (typed.type === "service_status" || typed.type === "tunnel_url") {
        void load();
      }
    });
    return () => ws.close();
  }, []);

  async function serviceAction(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
    try {
      await api(`/services/${serviceId}/${action}`, { method: "POST" });
      await load();
      toast.success(`Deployment ${action} sequence initiated`);
    } catch { /* toasted */ }
  }

  async function bulkAction(action: "start" | "stop" | "restart"): Promise<void> {
    if (filteredServices.length === 0) return;
    const ok = await confirmDialog({
      title: `${action[0].toUpperCase()}${action.slice(1)} ${filteredServices.length} services?`,
      message: `This will send a ${action} command to every service currently visible in the grid.`,
      danger: action === "stop",
      confirmLabel: `${action[0].toUpperCase()}${action.slice(1)} All`
    });
    if (!ok) return;
    try {
      await Promise.all(filteredServices.map((service) => api(`/services/${service.id}/${action}`, { method: "POST" })));
      toast.success(`Bulk ${action} sent to ${filteredServices.length} services`);
      await load();
    } catch { /* toasted */ }
  }

  async function deleteService(service: Service): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Purge service "${service.name}"?`,
      message: "This will terminate the container and remove all metadata. This action is irreversible.",
      danger: true,
      confirmLabel: "Purge Now"
    });
    if (!confirmed) return;

    const purgeDisk = await confirmDialog({
      title: "Clear Volume Data?",
      message: "Would you like to delete the associated directory on the host machine?",
      confirmLabel: "Clear Assets",
      cancelLabel: "Keep Data"
    });

    try {
      await api(`/services/${service.id}?purgeDisk=${purgeDisk}`, { method: "DELETE" });
      toast.success(`Service purged successfully`);
      await load();
    } catch { /* toasted */ }
  }

  const filteredServices = useMemo(() => {
    return services.filter(s => {
      const matchesEnv = envFilter === "all" || (s.environment ?? "production") === envFilter;
      const matchesQuery = s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           s.type.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesEnv && matchesQuery;
    });
  }, [services, envFilter, searchQuery]);

  const serviceGroups = useMemo(() => {
    if (!groupByProject) return [{ id: "all", title: "All Services", services: filteredServices }];
    return projects.map((project) => ({
      id: project.id,
      title: project.name,
      services: filteredServices.filter((service) => service.project_id === project.id)
    })).filter((group) => group.services.length > 0);
  }, [filteredServices, groupByProject, projects]);

  if (loading) {
    return (
      <div className="services-page">
         <header className="page-header"><Skeleton style={{ height: "3rem", width: "300px" }} /></header>
         <div className="action-grid">
            <Skeleton style={{ height: "180px" }} />
            <Skeleton style={{ height: "180px" }} />
            <Skeleton style={{ height: "180px" }} />
            <Skeleton style={{ height: "180px" }} />
         </div>
         <div className="grid">
            <CardSkeleton /><CardSkeleton /><CardSkeleton />
         </div>
      </div>
    );
  }

  return (
    <div className="services-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Services</h2>
          <p className="muted">Manage and monitor your decentralized applications.</p>
        </div>
        <div className="row wrap">
           <div className="search-box row" style={{ background: "var(--bg-sunken)", padding: "0.25rem 0.75rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)" }}>
              <Search size={16} className="text-muted" />
              <input
                placeholder="Search resources..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ background: "none", border: "none", width: "180px", fontSize: "0.85rem" }}
              />
           </div>

           <div className="row" style={{ background: "var(--bg-sunken)", padding: "0.25rem", borderRadius: "var(--radius-md)" }}>
              <button
                className={`ghost xsmall ${envFilter === "all" ? "active-filter" : ""}`}
                onClick={() => setEnvFilter("all")}
                aria-label="Show all environments"
                data-tooltip="Show all environments"
              >All</button>
              <button
                className={`ghost xsmall ${envFilter === "production" ? "active-filter" : ""}`}
                onClick={() => setEnvFilter("production")}
                aria-label="Show production services"
                data-tooltip="Show production services"
              >Prod</button>
              <button
                className={`ghost xsmall ${envFilter === "staging" ? "active-filter" : ""}`}
                onClick={() => setEnvFilter("staging")}
                aria-label="Show staging services"
                data-tooltip="Show staging services"
              >Stage</button>
           </div>
        </div>
      </header>

      <section className="action-grid">
        <motion.div
          whileHover={{ y: -5 }}
          className="action-card featured"
          onClick={() => setShowGithubDeploy(true)}
          role="button"
          tabIndex={0}
          aria-label="Deploy from GitHub"
          data-tooltip="Connect a repository and deploy from GitHub"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowGithubDeploy(true);
            }
          }}
        >
          <div className="icon-box"><GitBranch size={24} /></div>
          <h3>GitHub Deploy</h3>
          <p className="muted small">CI/CD automation for Git repositories.</p>
          <button className="primary small">Connect Repo</button>
        </motion.div>

        <motion.div
          whileHover={{ y: -5 }}
          className="action-card"
          onClick={() => setShowComposeModal(true)}
          role="button"
          tabIndex={0}
          aria-label="Import a Docker Compose stack"
          data-tooltip="Upload a Compose file and provision its services"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowComposeModal(true);
            }
          }}
        >
          <div className="icon-box" style={{ color: "var(--info)" }}><Layers size={24} /></div>
          <h3>Import Stack</h3>
          <p className="muted small">Provision via Docker Compose YAML.</p>
          <button className="small">Upload File</button>
        </motion.div>

        <motion.div
          whileHover={{ y: -5 }}
          className="action-card"
          onClick={() => setShowTemplateModal(true)}
          role="button"
          tabIndex={0}
          aria-label="Browse platform presets"
          data-tooltip="Start from a tuned service preset"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowTemplateModal(true);
            }
          }}
        >
          <div className="icon-box" style={{ color: "var(--warning)" }}><Zap size={24} /></div>
          <h3>Platform Presets</h3>
          <p className="muted small">Optimized ready-to-run configurations.</p>
          <button className="small">Browse</button>
        </motion.div>

        <motion.div
          whileHover={{ y: -5 }}
          className="action-card"
          onClick={() => setShowQuickLaunch(true)}
          role="button"
          tabIndex={0}
          aria-label="Open Lightning Launch"
          data-tooltip="Import a folder, pick a dev server, and launch"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowQuickLaunch(true);
            }
          }}
        >
          <div className="icon-box" style={{ background: "var(--accent-gradient)", color: "white" }}><Play size={24} /></div>
          <h3>Lightning Launch</h3>
          <p className="muted small">Zero-config instant deployment.</p>
          <button className="primary small">Fire Up</button>
        </motion.div>
      </section>

      <section className="services-section">
        <div className="section-title">
          <div className="row">
             <h3>Active Services</h3>
             <span className="badge accent">{filteredServices.length}</span>
          </div>
          <div className="row">
             <button
               className="ghost xsmall"
               onClick={() => setGroupByProject(!groupByProject)}
               aria-label={groupByProject ? "Show services in one grid" : "Group services by project"}
               data-tooltip={groupByProject ? "Show services in one grid" : "Group services by project"}
             >
                <Filter size={14} /> {groupByProject ? "Un-group" : "Group by Project"}
             </button>
             <button
               className="ghost xsmall"
               onClick={() => void bulkAction("start")}
               disabled={filteredServices.length === 0}
               aria-label={`Start ${filteredServices.length} visible services`}
               data-tooltip={filteredServices.length === 0 ? "No visible services to start" : "Start all visible services"}
             ><Play size={14} /> Start All</button>
             <button
               className="ghost xsmall"
               onClick={() => void bulkAction("stop")}
               disabled={filteredServices.length === 0}
               aria-label={`Stop ${filteredServices.length} visible services`}
               data-tooltip={filteredServices.length === 0 ? "No visible services to stop" : "Stop all visible services"}
             ><Square size={14} /> Stop All</button>
             <button
               className="ghost xsmall"
               onClick={() => void bulkAction("restart")}
               disabled={filteredServices.length === 0}
               aria-label={`Restart ${filteredServices.length} visible services`}
               data-tooltip={filteredServices.length === 0 ? "No visible services to restart" : "Restart all visible services"}
             ><RotateCw size={14} /> Restart All</button>
          </div>
        </div>

        {filteredServices.length === 0 ? (
          <div className="card text-center" style={{ padding: "6rem 2rem", opacity: 0.8 }}>
             <Box size={60} className="text-muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
             <h3 className="muted">No services detected in this environment.</h3>
             <p className="muted small" style={{ maxWidth: "400px", margin: "1rem auto 2rem" }}>
                Start by connecting a repository or using one of our platform templates to get your first node running.
             </p>
             <button className="primary" onClick={() => setShowCreateModal(true)}>
                <Plus size={18} /> Create Custom Service
             </button>
          </div>
        ) : (
          <div className="service-groups">
            {serviceGroups.map((group) => (
              <section key={group.id} className="service-group">
                {groupByProject && <h4 className="service-group-title">{group.title}</h4>}
                <div className="grid">
            <AnimatePresence>
              {group.services.map(service => (
                <motion.div
                  key={service.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="card service-card"
                >
                  <div className="env-tag">{service.environment ?? "production"}</div>

                  <div className="service-header">
                    <div className="service-title-group">
                      <div className="row">
                         <h3>{service.name}</h3>
                         <StatusBadge status={service.status} dotOnly />
                      </div>
                      <div className="service-meta" style={{ marginTop: "0.25rem" }}>
                        <span className="tiny muted font-bold uppercase">{service.type}</span>
                        {service.github_repo_url && <span className="tiny muted row"><GitBranch size={10} /> Sync Active</span>}
                      </div>
                    </div>
                    <button
                      className="ghost icon-only"
                      onClick={() => setEditingService(service)}
                      aria-label={`Open settings for ${service.name}`}
                      data-tooltip="Service settings"
                    >
                      <Settings2 size={18} />
                    </button>
                  </div>

                  <div className="service-body">
                    {service.domain ? (
                      <div className="list-link row small">
                        <Globe size={14} className="text-accent" />
                        <a href={`http://${service.domain}`} target="_blank" rel="noreferrer" className="link font-bold">{service.domain}</a>
                        <ExternalLink size={10} className="muted" />
                      </div>
                    ) : <div className="muted tiny italic">No public endpoint attached</div>}

                    {service.tunnel_url && (
                      <div className="tunnel-badge">
                        <Zap size={14} />
                        <a href={service.tunnel_url} target="_blank" rel="noreferrer" className="text-truncate">{service.tunnel_url}</a>
                      </div>
                    )}
                  </div>

                  <div className="service-footer">
                    <div className="row" style={{ gap: "0.25rem" }}>
                       <button className="ghost xsmall" aria-label={`Start ${service.name}`} data-tooltip="Start service" onClick={() => serviceAction(service.id, "start")}><Play size={14}/></button>
                       <button className="ghost xsmall" aria-label={`Stop ${service.name}`} data-tooltip="Stop service" onClick={() => serviceAction(service.id, "stop")}><Square size={14}/></button>
                       <button className="ghost xsmall" aria-label={`Restart ${service.name}`} data-tooltip="Restart service" onClick={() => serviceAction(service.id, "restart")}><RotateCw size={14}/></button>
                    </div>

                    <Link to={`/services/${service.id}/logs`} className="button ghost xsmall" aria-label={`Open logs for ${service.name}`} data-tooltip="Open logs">
                       <Terminal size={14} /> Logs
                    </Link>

                    <button
                      className="ghost xsmall text-danger"
                      style={{ marginLeft: "auto" }}
                      onClick={() => deleteService(service)}
                      aria-label={`Delete ${service.name}`}
                      data-tooltip="Delete service"
                      data-tooltip-side="left"
                    >
                       <Trash2 size={14} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="logs-container" style={{ marginTop: "4rem" }}>
        <div className="section-title">
          <div className="row">
             <Terminal size={18} />
             <h3>System Event Feed</h3>
          </div>
        </div>
        <div className="logs-viewer" style={{ height: "300px" }}>
          {logs.length === 0 ? (
            <div className="muted italic text-center" style={{ padding: "4rem" }}>
               <Activity size={24} className="text-muted" style={{ marginBottom: "1rem", opacity: 0.2 }} />
               <p className="tiny">Awaiting infrastructure events...</p>
            </div>
          ) : (
            logs.map((log, index) => (
              <div key={index} className="log-line">
                <span className="log-time tiny">[{new Date().toLocaleTimeString()}]</span>
                <span className="log-level muted small" style={{ color: log.level === "ERROR" ? "var(--danger)" : "inherit" }}>{log.level || "INFO"}</span>
                <span className="log-msg small">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Modals */}
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
          projects={projects}
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

      <style dangerouslySetInnerHTML={{ __html: `
        .active-filter { background: var(--accent) !important; color: white !important; }
        .text-danger { color: var(--danger) !important; }
        .text-danger:hover { background: var(--danger-soft) !important; }
        .list-link { padding: 0.5rem; background: var(--bg-sunken); border-radius: var(--radius-md); transition: var(--transition-fast); }
        .list-link:hover { border-color: var(--accent); background: var(--accent-soft); }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .tiny { font-size: 0.7rem; }
      `}} />
    </div>
  );
}
