import { Fragment, jsx, jsxs } from "react/jsx-runtime";
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
import { PromoteEmbeddedDbModal } from "../components/PromoteEmbeddedDbModal";
import { GoPublicWizard } from "../components/GoPublicWizard";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";
function certBadgeState(service) {
  if (service.ssl_status === "cloudflare") return { color: "neutral", days: null };
  if (!service.cert_expires_at) return null;
  const days = Math.floor((service.cert_expires_at - Date.now()) / 864e5);
  if (days < 7) return { color: "stale", days };
  if (days < 30) return { color: "warn", days };
  return { color: "ok", days };
}
function ServicesPage() {
  const [projects, setProjects] = useState([]);
  const [services, setServices] = useState([]);
  const [databases, setDatabases] = useState([]);
  const [logs, setLogs] = useState([]);
  const [serviceLogs, setServiceLogs] = useState({});
  const [operations, setOperations] = useState({});
  const [loading, setLoading] = useState(true);
  const [editingService, setEditingService] = useState(null);
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComposeModal, setShowComposeModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [databaseDraft, setDatabaseDraft] = useState(null);
  const [promoteTarget, setPromoteTarget] = useState(null);
  const [envFilter, setEnvFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByProject, setGroupByProject] = useState(false);
  const [orphans, setOrphans] = useState(/* @__PURE__ */ new Map());
  const [embeddedDbs, setEmbeddedDbs] = useState(/* @__PURE__ */ new Map());
  const [provisioningId, setProvisioningId] = useState(null);
  const [goPublicId, setGoPublicId] = useState(null);
  async function load() {
    try {
      const [projectData, serviceData, databaseData] = await Promise.all([
        api("/projects", { silent: true }),
        api("/services", { silent: true }),
        api("/databases", { silent: true })
      ]);
      setProjects(projectData);
      setServices(serviceData);
      setDatabases(databaseData);
      api("/databases/orphan-services", { silent: true }).then((rows) => setOrphans(new Map(rows.map((r) => [r.service_id, r])))).catch(() => void 0);
      api("/databases/embedded", { silent: true }).then((rows) => setEmbeddedDbs(new Map(rows.map((r) => [r.service_id, r])))).catch(() => void 0);
      const logPairs = await Promise.all(
        serviceData.slice(0, 20).map(async (service) => {
          const rows = await api(`/services/${service.id}/logs`, { silent: true }).catch(
            () => []
          );
          return [service.id, rows.slice(0, 8)];
        })
      );
      setServiceLogs((prev) => ({ ...prev, ...Object.fromEntries(logPairs) }));
    } catch (err) {
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload;
      if (typed.type === "log" && payload.message) {
        const entry = payload;
        setLogs((prev) => [entry, ...prev].slice(0, 50));
        if (entry.serviceId) {
          setServiceLogs((prev) => ({
            ...prev,
            [entry.serviceId]: [entry, ...prev[entry.serviceId] ?? []].slice(0, 8)
          }));
        }
      }
      if (typed.type === "service_status" || typed.type === "tunnel_url") {
        if (typed.type === "service_status") {
          const event = payload;
          if (event.serviceId && event.status) {
            setOperations((prev) => {
              const status = event.status;
              const current = prev[event.serviceId];
              if (!current) return prev;
              const done = status === "running" || status === "stopped";
              const failed = status === "crashed" || status === "error";
              return {
                ...prev,
                [event.serviceId]: {
                  ...current,
                  stage: status,
                  status: failed ? "error" : done ? "success" : "active",
                  message: failed ? "The service reported an error. Open logs for details." : status === "running" ? "Service is live and accepting traffic." : status === "stopped" ? "Service stopped cleanly." : `Service is ${status}...`
                }
              };
            });
          }
        }
        void load();
      }
      if (typed.type === "service_lifecycle") {
        const event = payload;
        if (!event.serviceId) return;
        setOperations((prev) => {
          const current = prev[event.serviceId] ?? {
            action: event.action ?? "start",
            stage: "queued",
            status: "active",
            message: "Preparing service action...",
            startedAt: Date.now()
          };
          const stage = event.stage ?? current.stage;
          const message = event.message ?? (stage === "queued" ? "Queued on the LocalSURV runtime." : stage === "starting" ? "Starting runtime and preparing environment." : stage === "pulling" ? "Pulling Docker image." : stage === "container" ? event.containerPort && event.port && event.containerPort !== event.port ? `Publishing localhost:${event.port} to container:${event.containerPort}.` : "Creating or reusing Docker container." : stage === "healthcheck" ? `Healthcheck is ${event.status ?? "running"}.` : stage === "live" ? "Service is live and reachable." : stage === "stopping" ? "Stopping runtime and cleaning up listeners." : `Service stage: ${stage}`);
          return {
            ...prev,
            [event.serviceId]: {
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
  async function serviceAction(serviceId, action) {
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
          ...prev[serviceId] ?? { action, startedAt: Date.now() },
          action,
          stage: "error",
          status: "error",
          message: "LocalSURV could not complete the action. Check the latest logs."
        }
      }));
    }
  }
  async function bulkAction(action) {
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
    }
  }
  async function stackAction(stack, action) {
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
    }
  }
  async function quickAddDatabase(service) {
    const confirmed = await confirmDialog({
      title: `Add a managed Postgres for "${service.name}"?`,
      message: "Provisions a Postgres container, links it, injects DATABASE_URL, and restarts the service. If an embedded SQLite is detected, its data is auto-imported.",
      confirmLabel: "Add Postgres"
    });
    if (!confirmed) return;
    setProvisioningId(service.id);
    try {
      const res = await api(`/databases/embedded/${service.id}/promote`, {
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
    } finally {
      setProvisioningId(null);
    }
  }
  function databaseServiceForStack(stack) {
    return stack.services.find((service) => embeddedDbs.has(service.id)) ?? stack.services.find((service) => {
      const orphan = orphans.get(service.id);
      return orphan && orphan.code_signals.length > 0;
    }) ?? stack.services.find((service) => serviceRole(service, stack.services.length) === "API") ?? stack.services[0] ?? null;
  }
  function openDatabaseFlowForStack(stack) {
    const service = databaseServiceForStack(stack);
    if (!service) return;
    const embedded = embeddedDbs.get(service.id);
    if (embedded) {
      setPromoteTarget(embedded);
      return;
    }
    void quickAddDatabase(service);
  }
  function databaseActionLabel(stack) {
    const service = databaseServiceForStack(stack);
    if (!service) return "Add database";
    return embeddedDbs.has(service.id) ? "Promote data" : "Add database";
  }
  async function deleteService(service) {
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
    }
  }
  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      const matchesEnv = envFilter === "all" || (s.environment ?? "production") === envFilter;
      const matchesQuery = s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.type.toLowerCase().includes(searchQuery.toLowerCase());
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
  function serviceUrl(service) {
    if (service.domain) return `http://${service.domain}`;
    if (service.port) return `http://localhost:${service.port}`;
    return null;
  }
  function operationIcon(operation, status) {
    if (operation?.status === "error" || status === "crashed" || status === "error")
      return /* @__PURE__ */ jsx(XCircle, { size: 16, className: "text-danger" });
    if (operation?.status === "success" || status === "running")
      return /* @__PURE__ */ jsx(CheckCircle2, { size: 16, className: "text-success" });
    if (operation || status === "starting" || status === "stopping" || status === "building")
      return /* @__PURE__ */ jsx(Loader2, { size: 16, className: "animate-spin text-warning" });
    return /* @__PURE__ */ jsx(Clock, { size: 16, className: "text-muted" });
  }
  function operationLabel(operation, service) {
    if (operation?.message) return operation.message;
    if (service.status === "running") return "Live. LocalSURV has confirmed the runtime is up.";
    if (service.status === "starting") return "Starting. Runtime events will appear here.";
    if (service.status === "stopping") return "Stopping. Waiting for cleanup to finish.";
    if (service.status === "building") return "Building. Watch deployment logs for progress.";
    if (service.status === "crashed") return "Crashed. Open logs to inspect the failure.";
    return "Idle. Start the service to watch the launch sequence.";
  }
  function normalizeStackName(name) {
    return name.replace(/\s+(api|backend|frontend|front-end|web|server|worker)$/i, "").replace(/[-_]+(api|backend|frontend|front-end|web|server|worker)$/i, "").trim();
  }
  function stackKey(service) {
    return `${service.project_id}:${normalizeStackName(service.name).toLowerCase()}`;
  }
  function serviceRole(service, stackSize = 1) {
    if (/\b(api|backend|server)\b/i.test(service.name)) return "API";
    if (/\b(frontend|front-end|web)\b/i.test(service.name)) return "Frontend";
    if (/\b(worker|queue|jobs)\b/i.test(service.name)) return "Worker";
    if (stackSize > 1 && service.port && service.port >= 7e3 && service.port <= 8999) return "API";
    if (stackSize > 1) return "Frontend";
    return service.type;
  }
  function stackStatus(stack) {
    if (stack.services.some((service) => ["crashed", "error"].includes(service.status))) return "error";
    if (stack.services.some((service) => ["starting", "stopping", "building"].includes(service.status)))
      return "starting";
    if (stack.services.every((service) => service.status === "running")) return "running";
    if (stack.services.some((service) => service.status === "running")) return "partial";
    return "stopped";
  }
  function primaryStackUrl(stack) {
    const frontend = stack.services.find(
      (service) => serviceRole(service, stack.services.length) === "Frontend"
    );
    return serviceUrl(frontend ?? stack.services[0]);
  }
  function ServerNodeIcon({ role }) {
    if (role === "Frontend") return /* @__PURE__ */ jsx(Globe, { size: 16 });
    if (role === "API") return /* @__PURE__ */ jsx(Terminal, { size: 16 });
    if (role === "Worker") return /* @__PURE__ */ jsx(Activity, { size: 16 });
    return /* @__PURE__ */ jsx(Layers, { size: 16 });
  }
  function buildServiceStacks(rows) {
    const map = /* @__PURE__ */ new Map();
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
      const linkedStack = [...map.values()].find(
        (stack) => stack.services.some(
          (service) => service.project_id === db.project_id && service.linked_database_id === db.id
        )
      );
      const namedStack = [...map.values()].find(
        (stack) => stack.services.some((service) => service.project_id === db.project_id) && normalizeStackName(db.name).toLowerCase().startsWith(stack.title.toLowerCase())
      );
      (linkedStack ?? namedStack)?.databases.push(db);
    }
    return [...map.values()].map((stack) => ({
      ...stack,
      services: stack.services.sort((a, b) => {
        const rank = (service) => {
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
    return /* @__PURE__ */ jsxs("div", { className: "services-page", children: [
      /* @__PURE__ */ jsx("header", { className: "page-header", children: /* @__PURE__ */ jsx(Skeleton, { style: { height: "3rem", width: "300px" } }) }),
      /* @__PURE__ */ jsxs("div", { className: "action-grid", children: [
        /* @__PURE__ */ jsx(Skeleton, { style: { height: "180px" } }),
        /* @__PURE__ */ jsx(Skeleton, { style: { height: "180px" } }),
        /* @__PURE__ */ jsx(Skeleton, { style: { height: "180px" } }),
        /* @__PURE__ */ jsx(Skeleton, { style: { height: "180px" } })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "grid", children: [
        /* @__PURE__ */ jsx(CardSkeleton, {}),
        /* @__PURE__ */ jsx(CardSkeleton, {}),
        /* @__PURE__ */ jsx(CardSkeleton, {})
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs("div", { className: "services-page", children: [
    /* @__PURE__ */ jsxs("header", { className: "page-header", children: [
      /* @__PURE__ */ jsxs("div", { className: "title-group", children: [
        /* @__PURE__ */ jsx("h2", { children: "Apps" }),
        /* @__PURE__ */ jsx("p", { className: "muted", children: "Manage each application as a stack of runtime, database, and endpoint resources." })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "row wrap", children: [
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "search-box row",
            style: {
              background: "var(--bg-sunken)",
              padding: "0.25rem 0.75rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-default)"
            },
            children: [
              /* @__PURE__ */ jsx(Search, { size: 16, className: "text-muted" }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  placeholder: "Search resources...",
                  value: searchQuery,
                  onChange: (e) => setSearchQuery(e.target.value),
                  style: { background: "none", border: "none", width: "180px", fontSize: "0.85rem" }
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "row",
            style: { background: "var(--bg-sunken)", padding: "0.25rem", borderRadius: "var(--radius-md)" },
            children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  className: `ghost xsmall ${envFilter === "all" ? "active-filter" : ""}`,
                  onClick: () => setEnvFilter("all"),
                  "aria-label": "Show all environments",
                  "data-tooltip": "Show all environments",
                  children: "All"
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  className: `ghost xsmall ${envFilter === "production" ? "active-filter" : ""}`,
                  onClick: () => setEnvFilter("production"),
                  "aria-label": "Show production services",
                  "data-tooltip": "Show production services",
                  children: "Prod"
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  className: `ghost xsmall ${envFilter === "staging" ? "active-filter" : ""}`,
                  onClick: () => setEnvFilter("staging"),
                  "aria-label": "Show staging services",
                  "data-tooltip": "Show staging services",
                  children: "Stage"
                }
              )
            ]
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "action-grid", children: [
      /* @__PURE__ */ jsxs(
        motion.div,
        {
          whileHover: { y: -5 },
          className: "action-card featured",
          onClick: () => setShowGithubDeploy(true),
          role: "button",
          tabIndex: 0,
          "aria-label": "Deploy from GitHub",
          "data-tooltip": "Connect a repository and deploy from GitHub",
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowGithubDeploy(true);
            }
          },
          children: [
            /* @__PURE__ */ jsx("div", { className: "icon-box", children: /* @__PURE__ */ jsx(GitBranch, { size: 24 }) }),
            /* @__PURE__ */ jsx("h3", { children: "GitHub Deploy" }),
            /* @__PURE__ */ jsx("p", { className: "muted small", children: "CI/CD automation for Git repositories." }),
            /* @__PURE__ */ jsx("button", { className: "primary small", children: "Connect Repo" })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        motion.div,
        {
          whileHover: { y: -5 },
          className: "action-card",
          onClick: () => setShowComposeModal(true),
          role: "button",
          tabIndex: 0,
          "aria-label": "Import a Docker Compose stack",
          "data-tooltip": "Upload a Compose file and provision its services",
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowComposeModal(true);
            }
          },
          children: [
            /* @__PURE__ */ jsx("div", { className: "icon-box", style: { color: "var(--info)" }, children: /* @__PURE__ */ jsx(Layers, { size: 24 }) }),
            /* @__PURE__ */ jsx("h3", { children: "Import Stack" }),
            /* @__PURE__ */ jsx("p", { className: "muted small", children: "Provision via Docker Compose YAML." }),
            /* @__PURE__ */ jsx("button", { className: "small", children: "Upload File" })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        motion.div,
        {
          whileHover: { y: -5 },
          className: "action-card",
          onClick: () => setShowTemplateModal(true),
          role: "button",
          tabIndex: 0,
          "aria-label": "Browse platform presets",
          "data-tooltip": "Start from a tuned service preset",
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowTemplateModal(true);
            }
          },
          children: [
            /* @__PURE__ */ jsx("div", { className: "icon-box", style: { color: "var(--warning)" }, children: /* @__PURE__ */ jsx(Zap, { size: 24 }) }),
            /* @__PURE__ */ jsx("h3", { children: "Platform Presets" }),
            /* @__PURE__ */ jsx("p", { className: "muted small", children: "Optimized ready-to-run configurations." }),
            /* @__PURE__ */ jsx("button", { className: "small", children: "Browse" })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        motion.div,
        {
          whileHover: { y: -5 },
          className: "action-card",
          onClick: () => setShowQuickLaunch(true),
          role: "button",
          tabIndex: 0,
          "aria-label": "Open Lightning Launch",
          "data-tooltip": "Import a folder, pick a dev server, and launch",
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowQuickLaunch(true);
            }
          },
          children: [
            /* @__PURE__ */ jsx("div", { className: "icon-box", style: { background: "var(--accent-gradient)", color: "white" }, children: /* @__PURE__ */ jsx(Play, { size: 24 }) }),
            /* @__PURE__ */ jsx("h3", { children: "Lightning Launch" }),
            /* @__PURE__ */ jsx("p", { className: "muted small", children: "Zero-config instant deployment." }),
            /* @__PURE__ */ jsx("button", { className: "primary small", children: "Fire Up" })
          ]
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "services-section", children: [
      /* @__PURE__ */ jsxs("div", { className: "section-title", children: [
        /* @__PURE__ */ jsxs("div", { className: "row", children: [
          /* @__PURE__ */ jsx("h3", { children: "Application Stacks" }),
          /* @__PURE__ */ jsxs("span", { className: "badge accent", children: [
            filteredServices.length,
            " resources"
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "row", children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost xsmall",
              onClick: () => setGroupByProject(!groupByProject),
              "aria-label": groupByProject ? "Show services in one grid" : "Group services by project",
              "data-tooltip": groupByProject ? "Show services in one grid" : "Group services by project",
              children: [
                /* @__PURE__ */ jsx(Filter, { size: 14 }),
                " ",
                groupByProject ? "Un-group" : "Group by Project"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost xsmall",
              onClick: () => void bulkAction("start"),
              disabled: filteredServices.length === 0,
              "aria-label": `Start ${filteredServices.length} visible services`,
              "data-tooltip": filteredServices.length === 0 ? "No visible runtimes to start" : "Start all visible runtime resources",
              children: [
                /* @__PURE__ */ jsx(Play, { size: 14 }),
                " Start All"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost xsmall",
              onClick: () => void bulkAction("stop"),
              disabled: filteredServices.length === 0,
              "aria-label": `Stop ${filteredServices.length} visible services`,
              "data-tooltip": filteredServices.length === 0 ? "No visible runtimes to stop" : "Stop all visible runtime resources",
              children: [
                /* @__PURE__ */ jsx(Square, { size: 14 }),
                " Stop All"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              className: "ghost xsmall",
              onClick: () => void bulkAction("restart"),
              disabled: filteredServices.length === 0,
              "aria-label": `Restart ${filteredServices.length} visible services`,
              "data-tooltip": filteredServices.length === 0 ? "No visible runtimes to restart" : "Restart all visible runtime resources",
              children: [
                /* @__PURE__ */ jsx(RotateCw, { size: 14 }),
                " Restart All"
              ]
            }
          )
        ] })
      ] }),
      filteredServices.length === 0 ? /* @__PURE__ */ jsxs("div", { className: "card text-center", style: { padding: "6rem 2rem", opacity: 0.8 }, children: [
        /* @__PURE__ */ jsx(Box, { size: 60, className: "text-muted", style: { margin: "0 auto 1.5rem", opacity: 0.2 } }),
        /* @__PURE__ */ jsx("h3", { className: "muted", children: "No app resources detected in this environment." }),
        /* @__PURE__ */ jsx("p", { className: "muted small", style: { maxWidth: "400px", margin: "1rem auto 2rem" }, children: "Start by connecting a repository or importing a stack to create your first application workspace." }),
        /* @__PURE__ */ jsxs("button", { className: "primary", onClick: () => setShowCreateModal(true), children: [
          /* @__PURE__ */ jsx(Plus, { size: 18 }),
          " Create Custom Service"
        ] })
      ] }) : /* @__PURE__ */ jsx("div", { className: "service-groups", children: serviceGroups.map((group) => /* @__PURE__ */ jsxs("section", { className: "service-group", children: [
        groupByProject && /* @__PURE__ */ jsx("h4", { className: "service-group-title", children: group.title }),
        /* @__PURE__ */ jsx("div", { className: "app-stack-list", children: buildServiceStacks(group.services).map((stack) => /* @__PURE__ */ jsxs("section", { className: `app-stack stack-${stackStatus(stack)}`, children: [
          /* @__PURE__ */ jsxs("div", { className: "app-stack-header", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsxs("div", { className: "row", children: [
                /* @__PURE__ */ jsx(Layers, { size: 18, className: "text-accent" }),
                /* @__PURE__ */ jsx("h4", { children: stack.title }),
                /* @__PURE__ */ jsx(StatusBadge, { status: stackStatus(stack), label: stackStatus(stack) })
              ] }),
              /* @__PURE__ */ jsxs("p", { className: "muted tiny", children: [
                stack.services.length === 1 ? "Single runtime service" : `${stack.services.length} linked runtime services from one app`,
                stack.databases.length > 0 ? ` \u2022 ${stack.databases.length} managed database${stack.databases.length === 1 ? "" : "s"}` : ""
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "stack-service-pills", children: [
              primaryStackUrl(stack) && /* @__PURE__ */ jsxs(
                "a",
                {
                  href: primaryStackUrl(stack),
                  target: "_blank",
                  rel: "noreferrer",
                  className: "stack-service-pill stack-open-pill",
                  "data-tooltip": "Open the primary app endpoint",
                  children: [
                    /* @__PURE__ */ jsx(ExternalLink, { size: 12 }),
                    "Open app"
                  ]
                }
              ),
              stack.services.map((service) => /* @__PURE__ */ jsxs("span", { className: "stack-service-pill", children: [
                /* @__PURE__ */ jsx(StatusBadge, { status: service.status, dotOnly: true }),
                serviceRole(service, stack.services.length)
              ] }, service.id)),
              stack.databases.map((db) => /* @__PURE__ */ jsxs(
                Link,
                {
                  to: "/databases",
                  className: "stack-service-pill database-pill",
                  "aria-label": `Open database ${db.name}`,
                  "data-tooltip": `${db.engine} database on port ${db.port}`,
                  children: [
                    /* @__PURE__ */ jsx(StatusBadge, { status: db.container_status?.state ?? "stopped", dotOnly: true }),
                    /* @__PURE__ */ jsx(DatabaseIcon, { size: 12 }),
                    db.engine
                  ]
                },
                db.id
              ))
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "app-stack-actions", children: [
            /* @__PURE__ */ jsxs("button", { className: "ghost xsmall", onClick: () => void stackAction(stack, "start"), children: [
              /* @__PURE__ */ jsx(Play, { size: 14 }),
              " Start stack"
            ] }),
            /* @__PURE__ */ jsxs("button", { className: "ghost xsmall", onClick: () => void stackAction(stack, "restart"), children: [
              /* @__PURE__ */ jsx(RotateCw, { size: 14 }),
              " Restart stack"
            ] }),
            /* @__PURE__ */ jsxs("button", { className: "ghost xsmall", onClick: () => void stackAction(stack, "stop"), children: [
              /* @__PURE__ */ jsx(Square, { size: 14 }),
              " Stop stack"
            ] }),
            /* @__PURE__ */ jsxs(
              "button",
              {
                className: "ghost xsmall",
                disabled: provisioningId === databaseServiceForStack(stack)?.id,
                onClick: () => openDatabaseFlowForStack(stack),
                "data-tooltip": "Create and link a managed database for this app. Existing embedded SQLite data is detected before setup.",
                children: [
                  provisioningId === databaseServiceForStack(stack)?.id ? /* @__PURE__ */ jsx(Loader2, { size: 14, className: "animate-spin" }) : /* @__PURE__ */ jsx(DatabaseIcon, { size: 14 }),
                  databaseActionLabel(stack)
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "stack-resource-map", children: [
            stack.services.map((service) => /* @__PURE__ */ jsxs("div", { className: `resource-node ${service.status}`, children: [
              /* @__PURE__ */ jsx(ServerNodeIcon, { role: serviceRole(service, stack.services.length) }),
              /* @__PURE__ */ jsx("strong", { children: serviceRole(service, stack.services.length) }),
              /* @__PURE__ */ jsx("span", { children: service.status })
            ] }, service.id)),
            stack.databases.map((db) => /* @__PURE__ */ jsxs(
              Link,
              {
                to: "/databases",
                className: `resource-node database ${db.container_status?.state ?? "stopped"}`,
                children: [
                  /* @__PURE__ */ jsx(DatabaseIcon, { size: 16 }),
                  /* @__PURE__ */ jsx("strong", { children: db.engine }),
                  /* @__PURE__ */ jsx("span", { children: db.container_status?.state ?? "stopped" })
                ]
              },
              db.id
            ))
          ] }),
          stack.databases.length > 0 && /* @__PURE__ */ jsx("div", { className: "stack-database-rail", children: stack.databases.map((db) => /* @__PURE__ */ jsxs(Link, { to: "/databases", className: "stack-db-resource", children: [
            /* @__PURE__ */ jsx(DatabaseIcon, { size: 15 }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("strong", { children: db.name }),
              /* @__PURE__ */ jsxs("span", { children: [
                db.engine,
                " \u2022 localhost:",
                db.port,
                " \u2022",
                " ",
                db.container_status?.state ?? "stopped"
              ] })
            ] })
          ] }, db.id)) }),
          /* @__PURE__ */ jsx("div", { className: "grid stack-grid", children: /* @__PURE__ */ jsx(AnimatePresence, { children: stack.services.map(
            (service) => (() => {
              const op = operations[service.id];
              const url = serviceUrl(service);
              const recent = serviceLogs[service.id] ?? [];
              const actionBusy = op?.status === "queued" || op?.status === "active" || service.status === "starting" || service.status === "stopping";
              return /* @__PURE__ */ jsxs(
                motion.div,
                {
                  layout: true,
                  initial: { opacity: 0, scale: 0.9 },
                  animate: { opacity: 1, scale: 1 },
                  exit: { opacity: 0, scale: 0.9 },
                  className: "card service-card",
                  children: [
                    /* @__PURE__ */ jsx("div", { className: "env-tag", children: service.environment ?? "production" }),
                    /* @__PURE__ */ jsxs("div", { className: "service-header", children: [
                      /* @__PURE__ */ jsxs("div", { className: "service-title-group", children: [
                        /* @__PURE__ */ jsxs("div", { className: "row", children: [
                          /* @__PURE__ */ jsx("h3", { children: service.name }),
                          /* @__PURE__ */ jsx(StatusBadge, { status: service.status, dotOnly: true }),
                          (() => {
                            const cert = certBadgeState(service);
                            if (!cert) return null;
                            const tip = cert.color === "neutral" ? "TLS terminated at Cloudflare edge" : `Let's Encrypt cert \xB7 expires in ${cert.days}d`;
                            return /* @__PURE__ */ jsx(
                              "span",
                              {
                                className: `cert-dot ${cert.color}`,
                                title: tip,
                                "aria-label": tip
                              }
                            );
                          })()
                        ] }),
                        /* @__PURE__ */ jsxs("div", { className: "service-meta", style: { marginTop: "0.25rem" }, children: [
                          /* @__PURE__ */ jsx("span", { className: "role-chip", children: serviceRole(service, stack.services.length) }),
                          /* @__PURE__ */ jsx("span", { className: "tiny muted font-bold uppercase", children: service.type }),
                          service.github_repo_url && /* @__PURE__ */ jsxs("span", { className: "tiny muted row", children: [
                            /* @__PURE__ */ jsx(GitBranch, { size: 10 }),
                            " Sync Active"
                          ] })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          className: "ghost icon-only",
                          onClick: () => setEditingService(service),
                          "aria-label": `Open settings for ${service.name}`,
                          "data-tooltip": "Service settings",
                          children: /* @__PURE__ */ jsx(Settings2, { size: 18 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "service-body", children: [
                      url ? /* @__PURE__ */ jsxs("div", { className: "list-link row small", children: [
                        /* @__PURE__ */ jsx(Globe, { size: 14, className: "text-accent" }),
                        /* @__PURE__ */ jsx(
                          "a",
                          {
                            href: url,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "link font-bold",
                            children: service.domain ?? `localhost:${service.port}`
                          }
                        ),
                        /* @__PURE__ */ jsx(ExternalLink, { size: 10, className: "muted" })
                      ] }) : /* @__PURE__ */ jsx("div", { className: "muted tiny italic", children: "No public endpoint attached" }),
                      service.tunnel_url && /* @__PURE__ */ jsxs("div", { className: "tunnel-badge", children: [
                        /* @__PURE__ */ jsx(Zap, { size: 14 }),
                        /* @__PURE__ */ jsx(
                          "a",
                          {
                            href: service.tunnel_url,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "text-truncate",
                            children: service.tunnel_url
                          }
                        )
                      ] }),
                      (() => {
                        const orphan = orphans.get(service.id);
                        const embedded = embeddedDbs.get(service.id);
                        const isFrontend = serviceRole(service, stack.services.length) === "Frontend";
                        const stackHasDatabaseOwner = stack.services.some(
                          (candidate) => candidate.id !== service.id && (embeddedDbs.has(candidate.id) || serviceRole(candidate, stack.services.length) === "API")
                        );
                        if (!embedded && isFrontend && stackHasDatabaseOwner) return null;
                        if (!orphan || !embedded && orphan.code_signals.length === 0)
                          return null;
                        const drivers = orphan.code_signals.map((s) => s.driver);
                        const uniqueDrivers = Array.from(new Set(drivers));
                        const headline = embedded ? "SQLite detected \u2014 promote to Postgres" : "No managed database";
                        const detail = embedded ? `${embedded.file_path} won't survive container recreates.` : `Your code uses ${uniqueDrivers.slice(0, 3).join(", ")}${uniqueDrivers.length > 3 ? "\u2026" : ""}. Add Postgres so data persists.`;
                        return /* @__PURE__ */ jsxs("div", { className: "db-suggest-banner", children: [
                          /* @__PURE__ */ jsx(DatabaseIcon, { size: 14 }),
                          /* @__PURE__ */ jsxs("div", { className: "db-suggest-text", children: [
                            /* @__PURE__ */ jsx("strong", { children: headline }),
                            /* @__PURE__ */ jsx("span", { children: detail })
                          ] }),
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              className: "primary xsmall",
                              disabled: provisioningId === service.id,
                              onClick: () => embedded ? setPromoteTarget(embedded) : void quickAddDatabase(service),
                              children: provisioningId === service.id ? /* @__PURE__ */ jsxs(Fragment, { children: [
                                /* @__PURE__ */ jsx(Loader2, { size: 12, className: "animate-spin" }),
                                " Provisioning\u2026"
                              ] }) : embedded ? "Promote data" : "Add Postgres"
                            }
                          )
                        ] });
                      })(),
                      /* @__PURE__ */ jsxs("div", { className: `launch-panel ${op?.status ?? service.status}`, children: [
                        /* @__PURE__ */ jsxs("div", { className: "launch-panel-head", children: [
                          /* @__PURE__ */ jsxs("div", { className: "row", children: [
                            operationIcon(op, service.status),
                            /* @__PURE__ */ jsx("span", { className: "tiny uppercase font-bold", children: op?.stage ?? service.status })
                          ] }),
                          url && service.status === "running" && /* @__PURE__ */ jsx(
                            "a",
                            {
                              className: "tiny link",
                              href: url,
                              target: "_blank",
                              rel: "noreferrer",
                              children: "Open live app"
                            }
                          )
                        ] }),
                        /* @__PURE__ */ jsx("p", { className: "launch-message", children: operationLabel(op, service) }),
                        /* @__PURE__ */ jsx("div", { className: "launch-steps", children: ["queued", "starting", "healthcheck", "live"].map((stage) => /* @__PURE__ */ jsx(
                          "span",
                          {
                            className: `launch-step ${op?.stage === stage || stage === "live" && service.status === "running" ? "active" : ""} ${service.status === "running" && stage !== "queued" ? "complete" : ""}`
                          },
                          stage
                        )) }),
                        recent.length > 0 && /* @__PURE__ */ jsx("div", { className: "mini-log", children: recent.slice(0, 3).map((log, index) => /* @__PURE__ */ jsxs(
                          "div",
                          {
                            className: `mini-log-line ${log.level ?? "info"}`,
                            children: [
                              /* @__PURE__ */ jsx("span", { children: log.level ?? "info" }),
                              /* @__PURE__ */ jsx("p", { children: log.message })
                            ]
                          },
                          `${log.timestamp ?? index}-${index}`
                        )) })
                      ] })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "service-footer", children: [
                      /* @__PURE__ */ jsxs("div", { className: "row", style: { gap: "0.25rem" }, children: [
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            className: "ghost xsmall",
                            disabled: actionBusy,
                            "aria-label": `Start ${service.name}`,
                            "data-tooltip": "Start service and stream launch progress",
                            onClick: () => serviceAction(service.id, "start"),
                            children: /* @__PURE__ */ jsx(Play, { size: 14 })
                          }
                        ),
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            className: "ghost xsmall",
                            disabled: actionBusy,
                            "aria-label": `Stop ${service.name}`,
                            "data-tooltip": "Stop service and show shutdown progress",
                            onClick: () => serviceAction(service.id, "stop"),
                            children: /* @__PURE__ */ jsx(Square, { size: 14 })
                          }
                        ),
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            className: "ghost xsmall",
                            disabled: actionBusy,
                            "aria-label": `Restart ${service.name}`,
                            "data-tooltip": "Restart service with live progress",
                            onClick: () => serviceAction(service.id, "restart"),
                            children: /* @__PURE__ */ jsx(RotateCw, { size: 14 })
                          }
                        )
                      ] }),
                      /* @__PURE__ */ jsxs(
                        Link,
                        {
                          to: `/services/${service.id}/logs`,
                          className: "button ghost xsmall",
                          "aria-label": `Open logs for ${service.name}`,
                          "data-tooltip": "Open logs",
                          children: [
                            /* @__PURE__ */ jsx(Terminal, { size: 14 }),
                            " Logs"
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsxs(
                        "button",
                        {
                          className: "ghost xsmall",
                          onClick: () => setGoPublicId(service.id),
                          "aria-label": `Go public for ${service.name}`,
                          "data-tooltip": "Expose this service publicly",
                          children: [
                            /* @__PURE__ */ jsx(Sparkles, { size: 14 }),
                            " Go Public"
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          className: "ghost xsmall text-danger",
                          style: { marginLeft: "auto" },
                          onClick: () => deleteService(service),
                          "aria-label": `Delete ${service.name}`,
                          "data-tooltip": "Delete service",
                          "data-tooltip-side": "left",
                          children: /* @__PURE__ */ jsx(Trash2, { size: 14 })
                        }
                      )
                    ] })
                  ]
                },
                service.id
              );
            })()
          ) }) })
        ] }, stack.id)) })
      ] }, group.id)) })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "logs-container", style: { marginTop: "4rem" }, children: [
      /* @__PURE__ */ jsx("div", { className: "section-title", children: /* @__PURE__ */ jsxs("div", { className: "row", children: [
        /* @__PURE__ */ jsx(Terminal, { size: 18 }),
        /* @__PURE__ */ jsx("h3", { children: "System Event Feed" })
      ] }) }),
      /* @__PURE__ */ jsx("div", { className: "logs-viewer", style: { height: "300px" }, children: logs.length === 0 ? /* @__PURE__ */ jsxs("div", { className: "muted italic text-center", style: { padding: "4rem" }, children: [
        /* @__PURE__ */ jsx(Activity, { size: 24, className: "text-muted", style: { marginBottom: "1rem", opacity: 0.2 } }),
        /* @__PURE__ */ jsx("p", { className: "tiny", children: "Awaiting infrastructure events..." })
      ] }) : logs.map((log, index) => /* @__PURE__ */ jsxs("div", { className: "log-line", children: [
        /* @__PURE__ */ jsxs("span", { className: "log-time tiny", children: [
          "[",
          (/* @__PURE__ */ new Date()).toLocaleTimeString(),
          "]"
        ] }),
        /* @__PURE__ */ jsx(
          "span",
          {
            className: "log-level muted small",
            style: { color: log.level === "ERROR" ? "var(--danger)" : "inherit" },
            children: log.level || "INFO"
          }
        ),
        /* @__PURE__ */ jsx("span", { className: "log-msg small", children: log.message })
      ] }, index)) })
    ] }),
    editingService && /* @__PURE__ */ jsx(
      ServiceSettingsModal,
      {
        service: editingService,
        onClose: () => setEditingService(null),
        onUpdated: () => void load()
      }
    ),
    showGithubDeploy && /* @__PURE__ */ jsx(
      GitHubDeployModal,
      {
        projects,
        onClose: () => setShowGithubDeploy(false),
        onDeployed: () => void load()
      }
    ),
    showCreateModal && /* @__PURE__ */ jsx(
      CreateServiceModal,
      {
        projects,
        onClose: () => setShowCreateModal(false),
        onCreated: () => void load()
      }
    ),
    showTemplateModal && /* @__PURE__ */ jsx(
      TemplateModal,
      {
        projects,
        onClose: () => setShowTemplateModal(false),
        onCreated: () => void load()
      }
    ),
    showComposeModal && /* @__PURE__ */ jsx(
      ComposeModal,
      {
        projects,
        onClose: () => setShowComposeModal(false),
        onImported: () => void load()
      }
    ),
    showQuickLaunch && /* @__PURE__ */ jsx(
      QuickLaunchModal,
      {
        projects,
        onClose: () => setShowQuickLaunch(false),
        onLaunched: () => {
          setShowQuickLaunch(false);
          void load();
        }
      }
    ),
    goPublicId && /* @__PURE__ */ jsx(GoPublicWizard, { serviceId: goPublicId, onClose: () => setGoPublicId(null) }),
    promoteTarget && /* @__PURE__ */ jsx(
      PromoteEmbeddedDbModal,
      {
        embedded: promoteTarget,
        onClose: () => setPromoteTarget(null),
        onPromoted: () => void load()
      }
    ),
    databaseDraft && /* @__PURE__ */ jsx(
      CreateDatabaseModal,
      {
        projects,
        initialProjectId: databaseDraft.projectId,
        initialName: databaseDraft.name,
        onClose: () => setDatabaseDraft(null),
        onCreated: () => {
          setDatabaseDraft(null);
          void load();
        }
      }
    ),
    /* @__PURE__ */ jsx(
      "style",
      {
        dangerouslySetInnerHTML: {
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
        }
      }
    )
  ] });
}
export {
  ServicesPage
};
