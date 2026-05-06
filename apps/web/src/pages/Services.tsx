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
  Activity,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  Sparkles,
  Database as DatabaseIcon
} from "lucide-react";

import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { ServiceSettingsModal } from "../components/ServiceSettingsModal";
import { GitHubDeployModal } from "../components/GitHubDeployModal";
import { CreateServiceModal } from "../components/CreateServiceModal";
import { TemplateModal } from "../components/TemplateModal";
import { ComposeModal } from "../components/ComposeModal";
import { QuickLaunchModal } from "../components/QuickLaunchModal";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";
import { GoPublicWizard } from "../components/GoPublicWizard";
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
  linked_database_id?: string | null;
  cert_expires_at?: number | null;
};

function certBadgeState(
  service: Service
): { color: "ok" | "warn" | "stale" | "neutral"; days: number | null } | null {
  if (service.ssl_status === "cloudflare") return { color: "neutral", days: null };
  if (!service.cert_expires_at) return null;
  const days = Math.floor((service.cert_expires_at - Date.now()) / 86400000);
  if (days < 7) return { color: "stale", days };
  if (days < 30) return { color: "warn", days };
  return { color: "ok", days };
}

type Project = {
  id: string;
  name: string;
};

type DatabaseResource = {
  id: string;
  project_id: string;
  name: string;
  engine: string;
  port: number;
  container_status?: { state?: string; health?: string | null };
};

type OrphanInfo = {
  service_id: string;
  service_name: string;
  code_signals: Array<{ driver: string; ecosystem: string; source_file: string }>;
};

type EmbeddedInfo = {
  service_id: string;
  file_path: string;
  persistent: boolean;
};

type LogEntry = {
  serviceId?: string;
  level?: string;
  message: string;
  timestamp?: string;
};

type ServiceOperation = {
  action: "start" | "stop" | "restart";
  stage: string;
  status: "queued" | "active" | "success" | "error";
  message: string;
  startedAt: number;
};

type ServiceStack = {
  id: string;
  title: string;
  services: Service[];
  databases: DatabaseResource[];
};

export function ServicesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [databases, setDatabases] = useState<DatabaseResource[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [serviceLogs, setServiceLogs] = useState<Record<string, LogEntry[]>>({});
  const [operations, setOperations] = useState<Record<string, ServiceOperation>>({});
  const [loading, setLoading] = useState(true);

  const [editingService, setEditingService] = useState<Service | null>(null);
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComposeModal, setShowComposeModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [databaseDraft, setDatabaseDraft] = useState<{ projectId: string; name: string } | null>(null);

  const [envFilter, setEnvFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByProject, setGroupByProject] = useState(false);
  const [orphans, setOrphans] = useState<Map<string, OrphanInfo>>(new Map());
  const [embeddedDbs, setEmbeddedDbs] = useState<Map<string, EmbeddedInfo>>(new Map());
  const [provisioningId, setProvisioningId] = useState<string | null>(null);
  const [goPublicId, setGoPublicId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [projectData, serviceData, databaseData] = await Promise.all([
        api<Project[]>("/projects", { silent: true }),
        api<Service[]>("/services", { silent: true }),
        api<DatabaseResource[]>("/databases", { silent: true })
      ]);
      setProjects(projectData);
      setServices(serviceData);
      setDatabases(databaseData);
      // Best-effort — never break the page if these fail.
      api<OrphanInfo[]>("/databases/orphan-services", { silent: true })
        .then((rows) => setOrphans(new Map(rows.map((r) => [r.service_id, r]))))
        .catch(() => undefined);
      api<EmbeddedInfo[]>("/databases/embedded", { silent: true })
        .then((rows) => setEmbeddedDbs(new Map(rows.map((r) => [r.service_id, r]))))
        .catch(() => undefined);
      const logPairs = await Promise.all(
        serviceData.slice(0, 20).map(async (service) => {
          const rows = await api<LogEntry[]>(`/services/${service.id}/logs`, { silent: true }).catch(
            () => []
          );
          return [service.id, rows.slice(0, 8)] as const;
        })
      );
      setServiceLogs((prev) => ({ ...prev, ...Object.fromEntries(logPairs) }));
    } catch (err) {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "log" && (payload as LogEntry).message) {
        const entry = payload as LogEntry;
        setLogs((prev) => [entry, ...prev].slice(0, 50));
        if (entry.serviceId) {
          setServiceLogs((prev) => ({
            ...prev,
            [entry.serviceId!]: [entry, ...(prev[entry.serviceId!] ?? [])].slice(0, 8)
          }));
        }
      }
      if (typed.type === "service_status" || typed.type === "tunnel_url") {
        if (typed.type === "service_status") {
          const event = payload as { serviceId?: string; status?: string };
          if (event.serviceId && event.status) {
            setOperations((prev) => {
              const status = event.status!;
              const current = prev[event.serviceId!];
              if (!current) return prev;
              const done = status === "running" || status === "stopped";
              const failed = status === "crashed" || status === "error";
              return {
                ...prev,
                [event.serviceId!]: {
                  ...current,
                  stage: status,
                  status: failed ? "error" : done ? "success" : "active",
                  message: failed
                    ? "The service reported an error. Open logs for details."
                    : status === "running"
                      ? "Service is live and accepting traffic."
                      : status === "stopped"
                        ? "Service stopped cleanly."
                        : `Service is ${status}...`
                }
              };
            });
          }
        }
        void load();
      }
      if (typed.type === "service_lifecycle") {
        const event = payload as {
          serviceId?: string;
          stage?: string;
          action?: ServiceOperation["action"];
          message?: string;
          status?: string;
          port?: number;
          containerPort?: number;
        };
        if (!event.serviceId) return;
        setOperations((prev) => {
          const current = prev[event.serviceId!] ?? {
            action: event.action ?? "start",
            stage: "queued",
            status: "active" as const,
            message: "Preparing service action...",
            startedAt: Date.now()
          };
          const stage = event.stage ?? current.stage;
          const message =
            event.message ??
            (stage === "queued"
              ? "Queued on the LocalSURV runtime."
              : stage === "starting"
                ? "Starting runtime and preparing environment."
                : stage === "pulling"
                  ? "Pulling Docker image."
                  : stage === "container"
                    ? event.containerPort && event.port && event.containerPort !== event.port
                      ? `Publishing localhost:${event.port} to container:${event.containerPort}.`
                      : "Creating or reusing Docker container."
                    : stage === "healthcheck"
                      ? `Healthcheck is ${event.status ?? "running"}.`
                      : stage === "live"
                        ? "Service is live and reachable."
                        : stage === "stopping"
                          ? "Stopping runtime and cleaning up listeners."
                          : `Service stage: ${stage}`);
          return {
            ...prev,
            [event.serviceId!]: {
              ...current,
              action: event.action ?? current.action,
              stage,
              status: stage === "live" ? "success" : "active",
              message
            }
          };
        });
      }
    });
    return () => ws.close();
  }, []);

  async function serviceAction(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
    setOperations((prev) => ({
      ...prev,
      [serviceId]: {
        action,
        stage: "queued",
        status: "queued",
        message: `${action[0].toUpperCase()}${action.slice(1)} request sent to LocalSURV...`,
        startedAt: Date.now()
      }
    }));
    try {
      await api(`/services/${serviceId}/${action}`, { method: "POST" });
      await load();
      toast.success(`Service ${action} sequence completed`);
    } catch {
      setOperations((prev) => ({
        ...prev,
        [serviceId]: {
          ...(prev[serviceId] ?? { action, startedAt: Date.now() }),
          action,
          stage: "error",
          status: "error",
          message: "LocalSURV could not complete the action. Check the latest logs."
        }
      }));
    }
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
      await Promise.all(
        filteredServices.map((service) => api(`/services/${service.id}/${action}`, { method: "POST" }))
      );
      toast.success(`Bulk ${action} sent to ${filteredServices.length} services`);
      await load();
    } catch {
      /* toasted */
    }
  }

  async function stackAction(stack: ServiceStack, action: "start" | "stop" | "restart"): Promise<void> {
    const serviceTargets = stack.services.filter(
      (service) => action !== "start" || service.status !== "running"
    );
    if (serviceTargets.length === 0) return;
    try {
      await Promise.all(serviceTargets.map((service) => serviceAction(service.id, action)));
      toast.success(
        `${stack.title} ${action} sent to ${serviceTargets.length} runtime${serviceTargets.length === 1 ? "" : "s"}`
      );
    } catch {
      /* serviceAction handles toast/state */
    }
  }

  /** One-click "Add Postgres" for a service that has no DATABASE_URL. */
  async function quickAddDatabase(service: Service): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Add a managed Postgres for "${service.name}"?`,
      message:
        "Provisions a Postgres container, links it, injects DATABASE_URL, and restarts the service. If an embedded SQLite is detected, its data is auto-imported.",
      confirmLabel: "Add Postgres"
    });
    if (!confirmed) return;
    setProvisioningId(service.id);
    try {
      const res = await api<{ importError?: string | null }>(`/databases/embedded/${service.id}/promote`, {
        method: "POST",
        body: JSON.stringify({
          mode: "managed",
          autoImportEmbedded: true,
          restart: true
        })
      });
      if (res.importError) {
        toast.error(`Database provisioned, but data import failed: ${res.importError}`);
      } else {
        toast.success(`Database linked to ${service.name}`);
      }
      await load();
    } catch {
      /* toasted */
    } finally {
      setProvisioningId(null);
    }
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
    } catch {
      /* toasted */
    }
  }

  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      const matchesEnv = envFilter === "all" || (s.environment ?? "production") === envFilter;
      const matchesQuery =
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.type.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesEnv && matchesQuery;
    });
  }, [services, envFilter, searchQuery]);

  const serviceGroups = useMemo(() => {
    if (!groupByProject) return [{ id: "all", title: "All Services", services: filteredServices }];
    return projects
      .map((project) => ({
        id: project.id,
        title: project.name,
        services: filteredServices.filter((service) => service.project_id === project.id)
      }))
      .filter((group) => group.services.length > 0);
  }, [filteredServices, groupByProject, projects]);

  function serviceUrl(service: Service): string | null {
    if (service.domain) return `http://${service.domain}`;
    if (service.port) return `http://localhost:${service.port}`;
    return null;
  }

  function operationIcon(operation: ServiceOperation | undefined, status: string) {
    if (operation?.status === "error" || status === "crashed" || status === "error")
      return <XCircle size={16} className="text-danger" />;
    if (operation?.status === "success" || status === "running")
      return <CheckCircle2 size={16} className="text-success" />;
    if (operation || status === "starting" || status === "stopping" || status === "building")
      return <Loader2 size={16} className="animate-spin text-warning" />;
    return <Clock size={16} className="text-muted" />;
  }

  function operationLabel(operation: ServiceOperation | undefined, service: Service): string {
    if (operation?.message) return operation.message;
    if (service.status === "running") return "Live. LocalSURV has confirmed the runtime is up.";
    if (service.status === "starting") return "Starting. Runtime events will appear here.";
    if (service.status === "stopping") return "Stopping. Waiting for cleanup to finish.";
    if (service.status === "building") return "Building. Watch deployment logs for progress.";
    if (service.status === "crashed") return "Crashed. Open logs to inspect the failure.";
    return "Idle. Start the service to watch the launch sequence.";
  }

  function normalizeStackName(name: string): string {
    return name
      .replace(/\s+(api|backend|frontend|front-end|web|server|worker)$/i, "")
      .replace(/[-_]+(api|backend|frontend|front-end|web|server|worker)$/i, "")
      .trim();
  }

  function stackKey(service: Service): string {
    return `${service.project_id}:${normalizeStackName(service.name).toLowerCase()}`;
  }

  function serviceRole(service: Service, stackSize = 1): string {
    if (/\b(api|backend|server)\b/i.test(service.name)) return "API";
    if (/\b(frontend|front-end|web)\b/i.test(service.name)) return "Frontend";
    if (/\b(worker|queue|jobs)\b/i.test(service.name)) return "Worker";
    if (stackSize > 1 && service.port && service.port >= 7000 && service.port <= 8999) return "API";
    if (stackSize > 1) return "Frontend";
    return service.type;
  }

  function stackStatus(stack: ServiceStack): string {
    if (stack.services.some((service) => ["crashed", "error"].includes(service.status))) return "error";
    if (stack.services.some((service) => ["starting", "stopping", "building"].includes(service.status)))
      return "starting";
    if (stack.services.every((service) => service.status === "running")) return "running";
    if (stack.services.some((service) => service.status === "running")) return "partial";
    return "stopped";
  }

  function primaryStackUrl(stack: ServiceStack): string | null {
    const frontend = stack.services.find(
      (service) => serviceRole(service, stack.services.length) === "Frontend"
    );
    return serviceUrl(frontend ?? stack.services[0]);
  }

  function ServerNodeIcon({ role }: { role: string }) {
    if (role === "Frontend") return <Globe size={16} />;
    if (role === "API") return <Terminal size={16} />;
    if (role === "Worker") return <Activity size={16} />;
    return <Layers size={16} />;
  }

  function buildServiceStacks(rows: Service[]): ServiceStack[] {
    const map = new Map<string, ServiceStack>();
    for (const service of rows) {
      const key = stackKey(service);
      const title = normalizeStackName(service.name) || service.name;
      const existing = map.get(key);
      if (existing) {
        existing.services.push(service);
      } else {
        map.set(key, { id: key, title, services: [service], databases: [] });
      }
    }
    for (const db of databases) {
      const linkedStack = [...map.values()].find((stack) =>
        stack.services.some(
          (service) => service.project_id === db.project_id && service.linked_database_id === db.id
        )
      );
      const namedStack = [...map.values()].find(
        (stack) =>
          stack.services.some((service) => service.project_id === db.project_id) &&
          normalizeStackName(db.name).toLowerCase().startsWith(stack.title.toLowerCase())
      );
      (linkedStack ?? namedStack)?.databases.push(db);
    }
    return [...map.values()].map((stack) => ({
      ...stack,
      services: stack.services.sort((a, b) => {
        const rank = (service: Service) => {
          const role = serviceRole(service, stack.services.length);
          if (role === "Frontend") return 0;
          if (role === "API") return 1;
          if (role === "Worker") return 2;
          return 3;
        };
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }),
      databases: stack.databases.sort((a, b) => a.name.localeCompare(b.name))
    }));
  }

  if (loading) {
    return (
      <div className="services-page">
        <header className="page-header">
          <Skeleton style={{ height: "3rem", width: "300px" }} />
        </header>
        <div className="action-grid">
          <Skeleton style={{ height: "180px" }} />
          <Skeleton style={{ height: "180px" }} />
          <Skeleton style={{ height: "180px" }} />
          <Skeleton style={{ height: "180px" }} />
        </div>
        <div className="grid">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="services-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Apps</h2>
          <p className="muted">
            Manage each application as a stack of runtime, database, and endpoint resources.
          </p>
        </div>
        <div className="row wrap">
          <div
            className="search-box row"
            style={{
              background: "var(--bg-sunken)",
              padding: "0.25rem 0.75rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-default)"
            }}
          >
            <Search size={16} className="text-muted" />
            <input
              placeholder="Search resources..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ background: "none", border: "none", width: "180px", fontSize: "0.85rem" }}
            />
          </div>

          <div
            className="row"
            style={{ background: "var(--bg-sunken)", padding: "0.25rem", borderRadius: "var(--radius-md)" }}
          >
            <button
              className={`ghost xsmall ${envFilter === "all" ? "active-filter" : ""}`}
              onClick={() => setEnvFilter("all")}
              aria-label="Show all environments"
              data-tooltip="Show all environments"
            >
              All
            </button>
            <button
              className={`ghost xsmall ${envFilter === "production" ? "active-filter" : ""}`}
              onClick={() => setEnvFilter("production")}
              aria-label="Show production services"
              data-tooltip="Show production services"
            >
              Prod
            </button>
            <button
              className={`ghost xsmall ${envFilter === "staging" ? "active-filter" : ""}`}
              onClick={() => setEnvFilter("staging")}
              aria-label="Show staging services"
              data-tooltip="Show staging services"
            >
              Stage
            </button>
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
          <div className="icon-box">
            <GitBranch size={24} />
          </div>
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
          <div className="icon-box" style={{ color: "var(--info)" }}>
            <Layers size={24} />
          </div>
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
          <div className="icon-box" style={{ color: "var(--warning)" }}>
            <Zap size={24} />
          </div>
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
          <div className="icon-box" style={{ background: "var(--accent-gradient)", color: "white" }}>
            <Play size={24} />
          </div>
          <h3>Lightning Launch</h3>
          <p className="muted small">Zero-config instant deployment.</p>
          <button className="primary small">Fire Up</button>
        </motion.div>
      </section>

      <section className="services-section">
        <div className="section-title">
          <div className="row">
            <h3>Application Stacks</h3>
            <span className="badge accent">{filteredServices.length} resources</span>
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
              data-tooltip={
                filteredServices.length === 0
                  ? "No visible runtimes to start"
                  : "Start all visible runtime resources"
              }
            >
              <Play size={14} /> Start All
            </button>
            <button
              className="ghost xsmall"
              onClick={() => void bulkAction("stop")}
              disabled={filteredServices.length === 0}
              aria-label={`Stop ${filteredServices.length} visible services`}
              data-tooltip={
                filteredServices.length === 0
                  ? "No visible runtimes to stop"
                  : "Stop all visible runtime resources"
              }
            >
              <Square size={14} /> Stop All
            </button>
            <button
              className="ghost xsmall"
              onClick={() => void bulkAction("restart")}
              disabled={filteredServices.length === 0}
              aria-label={`Restart ${filteredServices.length} visible services`}
              data-tooltip={
                filteredServices.length === 0
                  ? "No visible runtimes to restart"
                  : "Restart all visible runtime resources"
              }
            >
              <RotateCw size={14} /> Restart All
            </button>
          </div>
        </div>

        {filteredServices.length === 0 ? (
          <div className="card text-center" style={{ padding: "6rem 2rem", opacity: 0.8 }}>
            <Box size={60} className="text-muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
            <h3 className="muted">No app resources detected in this environment.</h3>
            <p className="muted small" style={{ maxWidth: "400px", margin: "1rem auto 2rem" }}>
              Start by connecting a repository or importing a stack to create your first application
              workspace.
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
                <div className="app-stack-list">
                  {buildServiceStacks(group.services).map((stack) => (
                    <section key={stack.id} className={`app-stack stack-${stackStatus(stack)}`}>
                      <div className="app-stack-header">
                        <div>
                          <div className="row">
                            <Layers size={18} className="text-accent" />
                            <h4>{stack.title}</h4>
                            <StatusBadge status={stackStatus(stack)} label={stackStatus(stack)} />
                          </div>
                          <p className="muted tiny">
                            {stack.services.length === 1
                              ? "Single runtime service"
                              : `${stack.services.length} linked runtime services from one app`}
                            {stack.databases.length > 0
                              ? ` • ${stack.databases.length} managed database${stack.databases.length === 1 ? "" : "s"}`
                              : ""}
                          </p>
                        </div>
                        <div className="stack-service-pills">
                          {primaryStackUrl(stack) && (
                            <a
                              href={primaryStackUrl(stack)!}
                              target="_blank"
                              rel="noreferrer"
                              className="stack-service-pill stack-open-pill"
                              data-tooltip="Open the primary app endpoint"
                            >
                              <ExternalLink size={12} />
                              Open app
                            </a>
                          )}
                          {stack.services.map((service) => (
                            <span key={service.id} className="stack-service-pill">
                              <StatusBadge status={service.status} dotOnly />
                              {serviceRole(service, stack.services.length)}
                            </span>
                          ))}
                          {stack.databases.map((db) => (
                            <Link
                              key={db.id}
                              to="/databases"
                              className="stack-service-pill database-pill"
                              aria-label={`Open database ${db.name}`}
                              data-tooltip={`${db.engine} database on port ${db.port}`}
                            >
                              <StatusBadge status={db.container_status?.state ?? "stopped"} dotOnly />
                              <DatabaseIcon size={12} />
                              {db.engine}
                            </Link>
                          ))}
                        </div>
                      </div>
                      <div className="app-stack-actions">
                        <button className="ghost xsmall" onClick={() => void stackAction(stack, "start")}>
                          <Play size={14} /> Start stack
                        </button>
                        <button className="ghost xsmall" onClick={() => void stackAction(stack, "restart")}>
                          <RotateCw size={14} /> Restart stack
                        </button>
                        <button className="ghost xsmall" onClick={() => void stackAction(stack, "stop")}>
                          <Square size={14} /> Stop stack
                        </button>
                        <button
                          className="ghost xsmall"
                          onClick={() =>
                            setDatabaseDraft({
                              projectId: stack.services[0]?.project_id ?? projects[0]?.id ?? "",
                              name: `${stack.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-db`
                            })
                          }
                          data-tooltip="Create a managed database in this app's project"
                        >
                          <DatabaseIcon size={14} /> Add database
                        </button>
                      </div>
                      <div className="stack-resource-map">
                        {stack.services.map((service) => (
                          <div key={service.id} className={`resource-node ${service.status}`}>
                            <ServerNodeIcon role={serviceRole(service, stack.services.length)} />
                            <strong>{serviceRole(service, stack.services.length)}</strong>
                            <span>{service.status}</span>
                          </div>
                        ))}
                        {stack.databases.map((db) => (
                          <Link
                            key={db.id}
                            to="/databases"
                            className={`resource-node database ${db.container_status?.state ?? "stopped"}`}
                          >
                            <DatabaseIcon size={16} />
                            <strong>{db.engine}</strong>
                            <span>{db.container_status?.state ?? "stopped"}</span>
                          </Link>
                        ))}
                      </div>
                      {stack.databases.length > 0 && (
                        <div className="stack-database-rail">
                          {stack.databases.map((db) => (
                            <Link key={db.id} to="/databases" className="stack-db-resource">
                              <DatabaseIcon size={15} />
                              <div>
                                <strong>{db.name}</strong>
                                <span>
                                  {db.engine} • localhost:{db.port} •{" "}
                                  {db.container_status?.state ?? "stopped"}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}
                      <div className="grid stack-grid">
                        <AnimatePresence>
                          {stack.services.map((service) =>
                            (() => {
                              const op = operations[service.id];
                              const url = serviceUrl(service);
                              const recent = serviceLogs[service.id] ?? [];
                              const actionBusy =
                                op?.status === "queued" ||
                                op?.status === "active" ||
                                service.status === "starting" ||
                                service.status === "stopping";
                              return (
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
                                        {(() => {
                                          const cert = certBadgeState(service);
                                          if (!cert) return null;
                                          const tip =
                                            cert.color === "neutral"
                                              ? "TLS terminated at Cloudflare edge"
                                              : `Let's Encrypt cert · expires in ${cert.days}d`;
                                          return (
                                            <span
                                              className={`cert-dot ${cert.color}`}
                                              title={tip}
                                              aria-label={tip}
                                            />
                                          );
                                        })()}
                                      </div>
                                      <div className="service-meta" style={{ marginTop: "0.25rem" }}>
                                        <span className="role-chip">
                                          {serviceRole(service, stack.services.length)}
                                        </span>
                                        <span className="tiny muted font-bold uppercase">{service.type}</span>
                                        {service.github_repo_url && (
                                          <span className="tiny muted row">
                                            <GitBranch size={10} /> Sync Active
                                          </span>
                                        )}
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
                                    {url ? (
                                      <div className="list-link row small">
                                        <Globe size={14} className="text-accent" />
                                        <a
                                          href={url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="link font-bold"
                                        >
                                          {service.domain ?? `localhost:${service.port}`}
                                        </a>
                                        <ExternalLink size={10} className="muted" />
                                      </div>
                                    ) : (
                                      <div className="muted tiny italic">No public endpoint attached</div>
                                    )}

                                    {service.tunnel_url && (
                                      <div className="tunnel-badge">
                                        <Zap size={14} />
                                        <a
                                          href={service.tunnel_url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-truncate"
                                        >
                                          {service.tunnel_url}
                                        </a>
                                      </div>
                                    )}

                                    {(() => {
                                      const orphan = orphans.get(service.id);
                                      const embedded = embeddedDbs.get(service.id);
                                      // Only nag when we have a real reason: detected SQLite or
                                      // a code-level driver. Silent for orphans that legitimately
                                      // don't need a DB (static frontends, etc.).
                                      if (!orphan || (!embedded && orphan.code_signals.length === 0))
                                        return null;
                                      const drivers = orphan.code_signals.map((s) => s.driver);
                                      const uniqueDrivers = Array.from(new Set(drivers));
                                      const headline = embedded
                                        ? "SQLite detected — promote to Postgres"
                                        : "No managed database";
                                      const detail = embedded
                                        ? `${embedded.file_path} won't survive container recreates.`
                                        : `Your code uses ${uniqueDrivers.slice(0, 3).join(", ")}${uniqueDrivers.length > 3 ? "…" : ""}. Add Postgres so data persists.`;
                                      return (
                                        <div className="db-suggest-banner">
                                          <DatabaseIcon size={14} />
                                          <div className="db-suggest-text">
                                            <strong>{headline}</strong>
                                            <span>{detail}</span>
                                          </div>
                                          <button
                                            className="primary xsmall"
                                            disabled={provisioningId === service.id}
                                            onClick={() => void quickAddDatabase(service)}
                                          >
                                            {provisioningId === service.id ? (
                                              <>
                                                <Loader2 size={12} className="animate-spin" /> Provisioning…
                                              </>
                                            ) : (
                                              "Add Postgres"
                                            )}
                                          </button>
                                        </div>
                                      );
                                    })()}

                                    <div className={`launch-panel ${op?.status ?? service.status}`}>
                                      <div className="launch-panel-head">
                                        <div className="row">
                                          {operationIcon(op, service.status)}
                                          <span className="tiny uppercase font-bold">
                                            {op?.stage ?? service.status}
                                          </span>
                                        </div>
                                        {url && service.status === "running" && (
                                          <a
                                            className="tiny link"
                                            href={url}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Open live app
                                          </a>
                                        )}
                                      </div>
                                      <p className="launch-message">{operationLabel(op, service)}</p>
                                      <div className="launch-steps">
                                        {["queued", "starting", "healthcheck", "live"].map((stage) => (
                                          <span
                                            key={stage}
                                            className={`launch-step ${op?.stage === stage || (stage === "live" && service.status === "running") ? "active" : ""} ${service.status === "running" && stage !== "queued" ? "complete" : ""}`}
                                          />
                                        ))}
                                      </div>
                                      {recent.length > 0 && (
                                        <div className="mini-log">
                                          {recent.slice(0, 3).map((log, index) => (
                                            <div
                                              key={`${log.timestamp ?? index}-${index}`}
                                              className={`mini-log-line ${log.level ?? "info"}`}
                                            >
                                              <span>{log.level ?? "info"}</span>
                                              <p>{log.message}</p>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  <div className="service-footer">
                                    <div className="row" style={{ gap: "0.25rem" }}>
                                      <button
                                        className="ghost xsmall"
                                        disabled={actionBusy}
                                        aria-label={`Start ${service.name}`}
                                        data-tooltip="Start service and stream launch progress"
                                        onClick={() => serviceAction(service.id, "start")}
                                      >
                                        <Play size={14} />
                                      </button>
                                      <button
                                        className="ghost xsmall"
                                        disabled={actionBusy}
                                        aria-label={`Stop ${service.name}`}
                                        data-tooltip="Stop service and show shutdown progress"
                                        onClick={() => serviceAction(service.id, "stop")}
                                      >
                                        <Square size={14} />
                                      </button>
                                      <button
                                        className="ghost xsmall"
                                        disabled={actionBusy}
                                        aria-label={`Restart ${service.name}`}
                                        data-tooltip="Restart service with live progress"
                                        onClick={() => serviceAction(service.id, "restart")}
                                      >
                                        <RotateCw size={14} />
                                      </button>
                                    </div>

                                    <Link
                                      to={`/services/${service.id}/logs`}
                                      className="button ghost xsmall"
                                      aria-label={`Open logs for ${service.name}`}
                                      data-tooltip="Open logs"
                                    >
                                      <Terminal size={14} /> Logs
                                    </Link>

                                    <button
                                      className="ghost xsmall"
                                      onClick={() => setGoPublicId(service.id)}
                                      aria-label={`Go public for ${service.name}`}
                                      data-tooltip="Expose this service publicly"
                                    >
                                      <Sparkles size={14} /> Go Public
                                    </button>

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
                              );
                            })()
                          )}
                        </AnimatePresence>
                      </div>
                    </section>
                  ))}
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
                <span
                  className="log-level muted small"
                  style={{ color: log.level === "ERROR" ? "var(--danger)" : "inherit" }}
                >
                  {log.level || "INFO"}
                </span>
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
          onLaunched={() => {
            setShowQuickLaunch(false);
            void load();
          }}
        />
      )}
      {goPublicId && <GoPublicWizard serviceId={goPublicId} onClose={() => setGoPublicId(null)} />}
      {databaseDraft && (
        <CreateDatabaseModal
          projects={projects}
          initialProjectId={databaseDraft.projectId}
          initialName={databaseDraft.name}
          onClose={() => setDatabaseDraft(null)}
          onCreated={() => {
            setDatabaseDraft(null);
            void load();
          }}
        />
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .active-filter { background: var(--accent) !important; color: white !important; }
        .text-danger { color: var(--danger) !important; }
        .text-danger:hover { background: var(--danger-soft) !important; }
        .list-link { padding: 0.5rem; background: var(--bg-sunken); border-radius: var(--radius-md); transition: var(--transition-fast); }
        .list-link:hover { border-color: var(--accent); background: var(--accent-soft); }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .tiny { font-size: 0.7rem; }
        .db-suggest-banner {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          margin: 0.5rem 0;
          padding: 0.55rem 0.75rem;
          border: 1px dashed color-mix(in srgb, var(--accent, #3b82f6) 50%, transparent);
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--accent, #3b82f6) 8%, var(--bg-sunken));
          color: var(--text-primary);
        }
        .db-suggest-banner svg { color: var(--accent, #3b82f6); flex-shrink: 0; }
        .db-suggest-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.25; }
        .db-suggest-text strong { font-size: 0.78rem; }
        .db-suggest-text span { font-size: 0.7rem; color: var(--text-muted); }
        .db-suggest-banner button.primary { white-space: nowrap; }
        .animate-spin { animation: dbspin 1s linear infinite; }
        @keyframes dbspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .cert-dot {
          display: inline-block;
          width: 8px; height: 8px; border-radius: 50%;
          margin-left: 0.25rem;
          background: var(--text-muted);
        }
        .cert-dot.ok { background: var(--success, #10b981); box-shadow: 0 0 0 2px color-mix(in srgb, var(--success, #10b981) 20%, transparent); }
        .cert-dot.warn { background: var(--warn, #d97706); }
        .cert-dot.stale { background: var(--danger, #ef4444); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger, #ef4444) 25%, transparent); }
        .cert-dot.neutral { background: var(--accent, #3b82f6); opacity: 0.7; }
      `
        }}
      />
    </div>
  );
}
