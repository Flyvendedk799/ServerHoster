import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  Power,
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
  Database as DatabaseIcon,
  KeyRound,
  Bot,
  AlertTriangle
} from "lucide-react";

import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import {
  listResourceRecognitions,
  listResources,
  runResourceRecognition,
  setResourceRecognitionPreference,
  type DatabaseRecognition,
  type ManagedResourceDetail,
  type ResourceProfileId
} from "../lib/resources";
import { ResourceProvisionModal } from "../components/ResourceProvisionModal";
import { ServiceSettingsModal } from "../components/ServiceSettingsModal";
import { GitHubDeployModal } from "../components/GitHubDeployModal";
import { CreateServiceModal } from "../components/CreateServiceModal";
import { TemplateModal } from "../components/TemplateModal";
import { ComposeModal } from "../components/ComposeModal";
import { QuickLaunchModal } from "../components/QuickLaunchModal";
import { CreateDatabaseModal } from "../components/CreateDatabaseModal";
import { PromoteEmbeddedDbModal, type EmbeddedDb } from "../components/PromoteEmbeddedDbModal";
import { GoPublicWizard } from "../components/GoPublicWizard";
import { StatusBadge } from "../components/StatusBadge";
import { openServiceTerminal } from "../components/TerminalDock";
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
  github_auto_pull?: number;
  latest_commit_hash?: string;
  latest_git_commit_hash?: string | null;
  latest_git_updated_at?: string | null;
  latest_git_trigger_source?: string | null;
  latest_git_branch?: string | null;
  ssl_status?: string;
  environment?: string;
  auto_restart?: number;
  max_restarts?: number;
  start_mode?: string | null;
  stop_with_hoster?: number | null;
  tunnel_url?: string | null;
  linked_database_id?: string | null;
  cert_expires_at?: number | null;
  /** Host path of the persistent, redeploy-safe data dir (injected as DATA_DIR). */
  data_dir?: string | null;
  /** Container-side mount of data_dir for docker services ("/data"). */
  data_dir_container?: string | null;
  /** Effective upload dirs backed by the data volume so they survive redeploys. */
  persisted_paths?: string[] | null;
  /** Raw persisted-uploads config JSON (auto/paths/exclude). */
  persisted_paths_config?: string | null;
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

function gitSourceLabel(source: string | null | undefined): string {
  if (source === "gitops-poller") return "Git poller";
  if (source === "webhook") return "GitHub webhook";
  if (source === "manual") return "manual Git redeploy";
  return "Git";
}

/** Pull a concise, human reason out of a failed deployment's build log so a
 * toast can say WHY (the deploy pipeline writes "Deploy failed: <msg>"). */
function extractDeployError(buildLog?: string): string | null {
  if (!buildLog) return null;
  const m = buildLog.match(/Deploy failed:\s*(.+)/);
  const line = (
    m
      ? m[1]
      : (buildLog
          .trim()
          .split("\n")
          .filter((l) => l.trim())
          .pop() ?? "")
  ).trim();
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const absMs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000]
  ];
  if (absMs < 60000) return diffMs >= 0 ? "just now" : "soon";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (absMs >= ms) return formatter.format(Math.round(-diffMs / ms), unit);
  }
  return new Date(iso).toLocaleString();
}

type DetectedDatabaseOffer = {
  profile: Extract<ResourceProfileId, "postgres" | "redis" | "mysql" | "mongo">;
  label: string;
  actionLabel: string;
  headline: string;
  detail: (drivers: string[]) => string;
};

function profileForDriver(driver: string): DetectedDatabaseOffer["profile"] | null {
  if (/^Redis\b/i.test(driver)) return "redis";
  if (driver === "PostgreSQL" || driver === "Prisma" || driver === "Drizzle ORM") return "postgres";
  if (driver === "MySQL") return "mysql";
  if (driver === "MongoDB") return "mongo";
  return null;
}

const DATABASE_OFFERS: Record<DetectedDatabaseOffer["profile"], DetectedDatabaseOffer> = {
  postgres: {
    profile: "postgres",
    label: "Postgres",
    actionLabel: "Add Postgres",
    headline: "No managed database",
    detail: (drivers) =>
      `Your code uses ${drivers.slice(0, 3).join(", ")}${drivers.length > 3 ? "..." : ""}. Add Postgres so data persists.`
  },
  redis: {
    profile: "redis",
    label: "Redis",
    actionLabel: "Add Redis",
    headline: "Redis cache detected",
    detail: (drivers) =>
      `Your code uses ${drivers.slice(0, 3).join(", ")}${drivers.length > 3 ? "..." : ""}. Add a managed Redis cache and inject REDIS_URL.`
  },
  mysql: {
    profile: "mysql",
    label: "MySQL",
    actionLabel: "Add MySQL",
    headline: "No managed MySQL database",
    detail: (drivers) =>
      `Your code uses ${drivers.slice(0, 3).join(", ")}${drivers.length > 3 ? "..." : ""}. Add MySQL so data persists.`
  },
  mongo: {
    profile: "mongo",
    label: "MongoDB",
    actionLabel: "Add MongoDB",
    headline: "No managed MongoDB database",
    detail: (drivers) =>
      `Your code uses ${drivers.slice(0, 3).join(", ")}${drivers.length > 3 ? "..." : ""}. Add MongoDB so data persists.`
  }
};

function detectedDatabaseOffer(drivers: string[]): DetectedDatabaseOffer | null {
  const counts = new Map<DetectedDatabaseOffer["profile"], { count: number; firstIndex: number }>();
  drivers.forEach((driver, index) => {
    const profile = profileForDriver(driver);
    if (!profile) return;
    const current = counts.get(profile);
    counts.set(profile, {
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index
    });
  });
  const [profile] =
    Array.from(counts.entries()).sort(
      (a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex
    )[0] ?? [];
  return profile ? DATABASE_OFFERS[profile] : null;
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

type EnvRequirement = {
  key: string;
  source_file: string;
  reason: "required-check" | "production-config" | "integration-secret" | "infrastructure-url";
  status: "missing" | "present";
  provided_by?: "service" | "project" | "linked-database";
  value_preview?: string;
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

type GitUpdateInfo = {
  serviceName: string;
  commitHash: string;
  updatedAt: string;
  triggerSource: string | null;
  branch: string | null;
};

type GithubSyncStatus = {
  serviceId: string;
  branch: string;
  autoPull: boolean;
  latestCommitHash: string | null;
  remoteHash: string | null;
  updateAvailable: boolean;
  requiresRestart?: boolean;
  canCheck: boolean;
  reason: string | null;
};

type GitSummary = {
  text: string;
  title: string;
  empty: boolean;
  pending: boolean;
  commitHash?: string;
  remoteHash?: string;
  serviceId?: string;
};

type ServiceStack = {
  id: string;
  title: string;
  services: Service[];
  databases: DatabaseResource[];
};

type OperatorServiceGroup = {
  id: string;
  name: string;
  description?: string | null;
  service_ids: string[];
  services: Service[];
  created_at: string;
  updated_at: string;
};

export function ServicesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [operatorGroups, setOperatorGroups] = useState<OperatorServiceGroup[]>([]);
  const [databases, setDatabases] = useState<DatabaseResource[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [serviceLogs, setServiceLogs] = useState<Record<string, LogEntry[]>>({});
  const [operations, setOperations] = useState<Record<string, ServiceOperation>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [editingService, setEditingService] = useState<Service | null>(null);
  const [editingOperatorGroup, setEditingOperatorGroup] = useState<OperatorServiceGroup | "new" | null>(
    null
  );
  const [operatorGroupActionKey, setOperatorGroupActionKey] = useState<string | null>(null);
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComposeModal, setShowComposeModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [databaseDraft, setDatabaseDraft] = useState<{ projectId: string; name: string } | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<EmbeddedDb | null>(null);

  const [envFilter, setEnvFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByProject, setGroupByProject] = useState(false);
  const [orphans, setOrphans] = useState<Map<string, OrphanInfo>>(new Map());
  const [embeddedDbs, setEmbeddedDbs] = useState<Map<string, EmbeddedDb>>(new Map());
  const [envRequirements, setEnvRequirements] = useState<Map<string, EnvRequirement[]>>(new Map());
  const [provisioningId, setProvisioningId] = useState<string | null>(null);
  const [goPublicId, setGoPublicId] = useState<string | null>(null);
  const [githubSyncStatuses, setGithubSyncStatuses] = useState<Record<string, GithubSyncStatus>>({});
  const [redeployingGitId, setRedeployingGitId] = useState<string | null>(null);
  const [forceRestartingId, setForceRestartingId] = useState<string | null>(null);
  const [alwaysOnBusyId, setAlwaysOnBusyId] = useState<string | null>(null);
  const [recognitions, setRecognitions] = useState<Map<string, DatabaseRecognition>>(new Map());
  const [resources, setResources] = useState<ManagedResourceDetail[]>([]);
  const [provisionTarget, setProvisionTarget] = useState<{
    service: Service;
    profile?: ResourceProfileId;
  } | null>(null);
  const [rescanningId, setRescanningId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [projectData, serviceData, databaseData, groupData] = await Promise.all([
        api<Project[]>("/projects", { silent: true }),
        api<Service[]>("/services", { silent: true }),
        api<DatabaseResource[]>("/databases", { silent: true }),
        api<OperatorServiceGroup[]>("/service-groups", { silent: true }).catch(() => [])
      ]);
      setProjects(projectData);
      setServices(serviceData);
      setDatabases(databaseData);
      setOperatorGroups(groupData);
      setLoadError(false);
      void loadGithubSyncStatuses(serviceData);
      // Best-effort — never break the page if these fail.
      api<OrphanInfo[]>("/databases/orphan-services", { silent: true })
        .then((rows) => setOrphans(new Map(rows.map((r) => [r.service_id, r]))))
        .catch(() => undefined);
      api<EmbeddedDb[]>("/databases/embedded", { silent: true })
        .then((rows) => setEmbeddedDbs(new Map(rows.map((r) => [r.service_id, r]))))
        .catch(() => undefined);
      api<Array<{ service_id: string; requirements: EnvRequirement[] }>>("/services/env-requirements", {
        silent: true
      })
        .then((rows) => setEnvRequirements(new Map(rows.map((r) => [r.service_id, r.requirements]))))
        .catch(() => undefined);
      listResourceRecognitions({ silent: true })
        .then((rows) => {
          setRecognitions(new Map(rows.map((recognition) => [recognition.service_id, recognition])));
        })
        .catch(() => undefined);
      listResources({ silent: true })
        .then(setResources)
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
      // Core resource fetch failed — distinguish this from an empty account so
      // the grid can offer a Retry instead of a misleading "create first service".
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadGithubSyncStatuses(rows: Service[]): Promise<void> {
    const serviceIds = rows
      .filter((service) => Boolean(service.github_repo_url))
      .map((service) => service.id)
      .slice(0, 50);
    if (serviceIds.length === 0) {
      setGithubSyncStatuses({});
      return;
    }
    try {
      const result = await api<{ items: GithubSyncStatus[] }>("/services/github-sync-statuses", {
        method: "POST",
        silent: true,
        body: JSON.stringify({ serviceIds })
      });
      setGithubSyncStatuses(Object.fromEntries(result.items.map((item) => [item.serviceId, item])));
    } catch {
      setGithubSyncStatuses({});
    }
  }

  /** The active supabase resource linked to a service, when one exists. */
  function serviceSupabaseResource(serviceId: string): ManagedResourceDetail | null {
    return (
      resources.find(
        (resource) =>
          resource.profile === "supabase" &&
          resource.links.some((link) => link.service_id === serviceId && link.active)
      ) ?? null
    );
  }

  function recognitionFor(serviceId: string): DatabaseRecognition | null {
    return recognitions.get(serviceId) ?? null;
  }

  function actionableRecognition(serviceId: string): DatabaseRecognition | null {
    const recognition = recognitionFor(serviceId);
    if (!recognition) return null;
    if (recognition.detected.profile === "manual" && recognition.current_provider.kind === "none") return null;
    if (recognition.state === "satisfied" || recognition.preference.mode === "ignore") return null;
    return recognition;
  }

  function profileLabel(profile: ResourceProfileId): string {
    if (profile === "supabase") return "Local Supabase";
    if (profile === "postgres") return "Postgres";
    if (profile === "mysql") return "MySQL";
    if (profile === "mongo") return "MongoDB";
    if (profile === "redis") return "Redis";
    return "database";
  }

  function providerProfileLabel(profile: ResourceProfileId): string {
    return profile === "supabase" ? "Supabase" : profileLabel(profile);
  }

  function primaryRecognitionAction(
    recognition: DatabaseRecognition
  ): DatabaseRecognition["actions"][number] | null {
    const priority = [
      "fix-env",
      "open-settings",
      "link-existing",
      "adopt-legacy",
      "promote-sqlite",
      "provision",
      "use-hosted",
      "use-local",
      "ignore",
      "rescan"
    ];
    return (
      priority
        .map((id) => recognition.actions.find((action) => action.id === id && action.preferred && !action.disabled))
        .find(Boolean) ??
      priority
        .map((id) => recognition.actions.find((action) => action.id === id && !action.disabled))
        .find(Boolean) ??
      null
    );
  }

  async function rescanService(service: Service): Promise<void> {
    setRescanningId(service.id);
    try {
      const result = await runResourceRecognition(service.id, { silent: true });
      setRecognitions((prev) => new Map(prev).set(service.id, result));
      toast.success(
        result.detected.profile !== "manual"
          ? `Detected ${result.detected.profile} (${result.detected.confidence} confidence)`
          : "No backend dependency detected"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dependency scan failed");
    } finally {
      setRescanningId(null);
    }
  }

  async function chooseHostedProvider(service: Service): Promise<void> {
    try {
      const recognition = await setResourceRecognitionPreference(service.id, {
        mode: "hosted",
        note: "Operator chose hosted/manual database env from the service card."
      });
      setRecognitions((prev) => new Map(prev).set(service.id, recognition));
      toast.info(`${service.name} keeps its hosted/manual database env.`);
    } catch {
      /* toasted */
    }
  }

  async function preferLocalProvider(service: Service): Promise<void> {
    try {
      const recognition = await setResourceRecognitionPreference(service.id, {
        mode: "local",
        note: "Operator chose the local managed database/resource from the service card."
      });
      setRecognitions((prev) => new Map(prev).set(service.id, recognition));
      if (recognition.issues.some((issue) => issue.code === "env-override")) {
        toast.info("Local preference saved. Remove the overriding service env to actually use it.");
      } else {
        toast.success(`${service.name} now prefers its local managed database/resource.`);
      }
    } catch {
      /* toasted */
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
      if (typed.type === "resource_status") {
        // A resource finished provisioning / changed state / was removed —
        // refresh cards so prompts and status chips stay honest.
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

  async function toggleAlwaysOn(service: Service): Promise<void> {
    const next = !serviceAlwaysOn(service);
    setAlwaysOnBusyId(service.id);
    try {
      await api(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({ alwaysOn: next })
      });
      toast.success(next ? `${service.name} is now always on` : `${service.name} returned to manual mode`);
      await load();
    } catch {
      /* api handles toast */
    } finally {
      setAlwaysOnBusyId(null);
    }
  }

  /**
   * Hard power-cycle for a wedged service. Breaks any stuck action lock and
   * SIGKILLs the runtime before starting again — the escape hatch for a service
   * pinned at "stopping"/"starting" that the normal restart can't touch. Stays
   * enabled even while the card looks busy, since that's exactly when it's needed.
   */
  async function forceRestart(service: Service): Promise<void> {
    const ok = await confirmDialog({
      title: `Force restart "${service.name}"?`,
      message:
        'Immediately kills the runtime with no graceful shutdown, then starts it again. Use this to recover a service stuck at "stopping" or "starting". Any in-flight requests will be dropped.',
      danger: true,
      confirmLabel: "Force Restart"
    });
    if (!ok) return;
    setForceRestartingId(service.id);
    setOperations((prev) => ({
      ...prev,
      [service.id]: {
        action: "restart",
        stage: "queued",
        status: "queued",
        message: "Force restart request sent to LocalSURV...",
        startedAt: Date.now()
      }
    }));
    try {
      await api(`/services/${service.id}/force-restart`, { method: "POST" });
      await load();
      toast.success(`Force restarted ${service.name}`);
    } catch {
      setOperations((prev) => ({
        ...prev,
        [service.id]: {
          ...(prev[service.id] ?? { action: "restart", startedAt: Date.now() }),
          action: "restart",
          stage: "error",
          status: "error",
          message: "LocalSURV could not force restart the service. Check the latest logs."
        }
      }));
    } finally {
      setForceRestartingId(null);
    }
  }

  async function deployLatestFromGit(service: Service): Promise<void> {
    setRedeployingGitId(service.id);
    try {
      // /redeploy clones+builds+restarts and returns the deployment — which may
      // be status:"failed" with a 200, so we must inspect it rather than assume
      // success (a failed clone/build was previously toasted as a win).
      const dep = await api<{ status: string; build_log?: string; commit_hash?: string }>(
        `/services/${service.id}/redeploy`,
        { method: "POST", silent: true }
      );
      if (dep.status === "success") {
        const sha = dep.commit_hash ? ` (${dep.commit_hash.slice(0, 7)})` : "";
        toast.success(`${service.name} deployed${sha} and restarted on the latest code`);
      } else {
        const reason = extractDeployError(dep.build_log);
        toast.error(
          `Deploy failed for ${service.name}${reason ? `: ${reason}` : ""} — open the deployment logs for details.`
        );
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Deploy failed for ${service.name}`);
    } finally {
      setRedeployingGitId(null);
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

  async function operatorGroupAction(
    group: OperatorServiceGroup,
    action: "start" | "stop" | "restart"
  ): Promise<void> {
    if (group.services.length === 0) return;
    const titleAction = `${action[0].toUpperCase()}${action.slice(1)}`;
    const ok = await confirmDialog({
      title: `${titleAction} "${group.name}"?`,
      message: `This will ${action} ${group.services.length} selected service${
        group.services.length === 1 ? "" : "s"
      } in this group.`,
      danger: action === "stop",
      confirmLabel: `${titleAction} All`
    });
    if (!ok) return;
    const key = `${group.id}:${action}`;
    setOperatorGroupActionKey(key);
    try {
      const result = await api<{ results: Array<{ serviceId: string; ok: boolean; error?: string }> }>(
        `/service-groups/${group.id}/${action}-all`,
        { method: "POST" }
      );
      const failures = result.results.filter((item) => !item.ok);
      if (failures.length > 0) {
        toast.error(`${failures.length} service${failures.length === 1 ? "" : "s"} could not ${action}`);
      } else {
        toast.success(`${titleAction} sent to ${result.results.length} service${result.results.length === 1 ? "" : "s"}`);
      }
      await load();
    } catch {
      /* api handles toast */
    } finally {
      setOperatorGroupActionKey(null);
    }
  }

  async function deleteOperatorGroup(group: OperatorServiceGroup): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete "${group.name}"?`,
      message: "The services themselves stay intact. Only this operator group is removed.",
      danger: true,
      confirmLabel: "Delete Group"
    });
    if (!ok) return;
    try {
      await api(`/service-groups/${group.id}`, { method: "DELETE" });
      toast.success(`Deleted ${group.name}`);
      await load();
    } catch {
      /* api handles toast */
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

  async function provisionDetectedResource(service: Service, offer: DetectedDatabaseOffer): Promise<void> {
    if (offer.profile === "postgres") {
      await quickAddDatabase(service);
      return;
    }
    setProvisioningId(service.id);
    try {
      await api("/resources/provision", {
        method: "POST",
        body: JSON.stringify({
          serviceId: service.id,
          profile: offer.profile,
          restart: true
        })
      });
      toast.success(`${offer.label} linked to ${service.name}`);
      await load();
    } catch {
      /* toasted */
    } finally {
      setProvisioningId(null);
    }
  }

  async function runRecognitionPrimaryAction(service: Service, recognition: DatabaseRecognition): Promise<void> {
    const preferred = primaryRecognitionAction(recognition);
    if (!preferred) {
      setEditingService(service);
      return;
    }
    if (preferred.id === "fix-env" || preferred.id === "open-settings") {
      setEditingService(service);
      return;
    }
    if (preferred.id === "use-hosted") {
      await chooseHostedProvider(service);
      return;
    }
    if (preferred.id === "use-local") {
      await preferLocalProvider(service);
      return;
    }
    if (preferred.id === "ignore") {
      try {
        const updated = await setResourceRecognitionPreference(service.id, {
          mode: "ignore",
          note: "Operator marked database recognition as not needed from the service card."
        });
        setRecognitions((prev) => new Map(prev).set(service.id, updated));
        toast.info(`${service.name} database recognition is ignored.`);
      } catch {
        /* toasted */
      }
      return;
    }
    if (preferred.id === "rescan") {
      await rescanService(service);
      return;
    }
    if (preferred.id === "link-existing" && preferred.resource_id) {
      try {
        await api(`/resources/${preferred.resource_id}/link`, {
          method: "POST",
          body: JSON.stringify({ serviceId: service.id })
        });
        toast.success(`Linked ${preferred.label.replace(/^Link existing /, "")} to ${service.name}`);
        await load();
      } catch {
        /* toasted */
      }
      return;
    }
    if (preferred.id === "adopt-legacy" && preferred.database_id) {
      try {
        await api("/resources/adopt-database", {
          method: "POST",
          body: JSON.stringify({ databaseId: preferred.database_id, serviceId: service.id })
        });
        toast.success(`Adopted database for ${service.name}`);
        await load();
      } catch {
        /* toasted */
      }
      return;
    }
    if (preferred.id === "promote-sqlite") {
      const embedded = embeddedDbs.get(service.id);
      if (embedded) setPromoteTarget(embedded);
      else await quickAddDatabase(service);
      return;
    }
    const profile = preferred.profile ?? recognition.detected.profile;
    if (profile === "supabase") {
      setProvisionTarget({ service, profile: "supabase" });
      return;
    }
    if (profile === "postgres") {
      await quickAddDatabase(service);
      return;
    }
    setProvisioningId(service.id);
    try {
      await api("/resources/provision", {
        method: "POST",
        body: JSON.stringify({
          serviceId: service.id,
          profile,
          restart: true
        })
      });
      toast.success(`${profileLabel(profile)} linked to ${service.name}`);
      await load();
    } catch {
      /* toasted */
    } finally {
      setProvisioningId(null);
    }
  }

  function databaseServiceForStack(stack: ServiceStack): Service | null {
    return (
      stack.services.find((service) => actionableRecognition(service.id)?.detected.profile === "supabase") ??
      stack.services.find((service) => actionableRecognition(service.id)?.detected.profile !== "manual") ??
      stack.services.find((service) => embeddedDbs.has(service.id)) ??
      stack.services.find((service) => {
        const orphan = orphans.get(service.id);
        return orphan && orphan.code_signals.length > 0;
      }) ??
      stack.services.find((service) => serviceRole(service, stack.services.length) === "API") ??
      stack.services[0] ??
      null
    );
  }

  function openDatabaseFlowForStack(stack: ServiceStack): void {
    const service = databaseServiceForStack(stack);
    if (!service) return;
    const recognition = actionableRecognition(service.id);
    if (recognition) {
      void runRecognitionPrimaryAction(service, recognition);
      return;
    }
    const embedded = embeddedDbs.get(service.id);
    if (embedded) {
      setPromoteTarget(embedded);
      return;
    }
    const orphan = orphans.get(service.id);
    const offer = orphan ? detectedDatabaseOffer(orphan.code_signals.map((signal) => signal.driver)) : null;
    if (offer) {
      void provisionDetectedResource(service, offer);
      return;
    }
    void quickAddDatabase(service);
  }

  function databaseActionLabel(stack: ServiceStack): string {
    const service = databaseServiceForStack(stack);
    if (!service) return "Add database";
    const recognition = actionableRecognition(service.id);
    if (recognition) {
      const preferred = primaryRecognitionAction(recognition);
      if (preferred?.id === "link-existing") return "Link existing";
      if (preferred?.id === "adopt-legacy") return "Adopt database";
      if (preferred?.id === "fix-env") return "Fix env";
      if (preferred?.id === "open-settings") return "Review settings";
      if (preferred?.id === "use-hosted") return "Use hosted env";
      if (preferred?.id === "use-local") return "Prefer local";
      if (preferred?.id === "ignore") return "Ignore";
      if (preferred?.id === "rescan") return "Rescan";
      if (recognition.current_provider.kind === "embedded-sqlite") return "Promote data";
      return `Add ${profileLabel(recognition.detected.profile)}`;
    }
    if (embeddedDbs.has(service.id)) return "Promote data";
    const orphan = orphans.get(service.id);
    const offer = orphan ? detectedDatabaseOffer(orphan.code_signals.map((signal) => signal.driver)) : null;
    return offer?.actionLabel ?? "Add database";
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
    const query = searchQuery.trim().toLowerCase();
    return services.filter((s) => {
      const matchesEnv = envFilter === "all" || (s.environment ?? "production") === envFilter;
      if (!query) return matchesEnv;
      const haystack = [
        s.name,
        s.type,
        s.domain,
        s.port != null ? String(s.port) : null,
        s.github_repo_url,
        s.github_branch ?? s.latest_git_branch
      ]
        .filter((field): field is string => Boolean(field))
        .join(" ")
        .toLowerCase();
      return matchesEnv && haystack.includes(query);
    });
  }, [services, envFilter, searchQuery]);

  /** True when an active search/filter — not an empty account — hid every service. */
  const filterHidEverything = services.length > 0 && filteredServices.length === 0;

  function clearFilters(): void {
    setEnvFilter("all");
    setSearchQuery("");
  }

  const visibleServiceGroups = useMemo(() => {
    if (!groupByProject) return [{ id: "all", title: "All Services", services: filteredServices }];
    return projects
      .map((project) => ({
        id: project.id,
        title: project.name,
        services: filteredServices.filter((service) => service.project_id === project.id)
      }))
      .filter((group) => group.services.length > 0);
  }, [filteredServices, groupByProject, projects]);

  function operatorGroupStatus(group: OperatorServiceGroup): string {
    if (group.services.length === 0) return "none";
    if (group.services.some((service) => service.status === "crashed" || service.status === "error"))
      return "error";
    if (group.services.some((service) => ["starting", "stopping", "building"].includes(service.status)))
      return "starting";
    if (group.services.every((service) => service.status === "running")) return "running";
    if (group.services.some((service) => service.status === "running")) return "partial";
    return "stopped";
  }

  function operatorGroupDisabledReason(
    group: OperatorServiceGroup,
    action: "start" | "stop" | "restart"
  ): string | null {
    if (group.services.length === 0) return "Add services to this group first";
    const actionable = group.services.some(
      (service) => lifecycleDisabledReason(service.status, action) === null
    );
    if (actionable) return null;
    if (action === "start") return "Every service is already running or starting";
    if (action === "stop") return "No running service to stop";
    return "No running service to restart";
  }

  function operatorGroupActionInFlight(
    group: OperatorServiceGroup,
    action: "start" | "stop" | "restart"
  ): boolean {
    if (operatorGroupActionKey === `${group.id}:${action}`) return true;
    return group.services.some((service) => {
      const op = operations[service.id];
      return op?.action === action && (op.status === "queued" || op.status === "active");
    });
  }

  function serviceUrl(service: Service): string | null {
    if (service.domain) return `http://${service.domain}`;
    if (service.port) return `http://localhost:${service.port}`;
    return null;
  }

  function serviceAlwaysOn(service: Service): boolean {
    return service.start_mode === "auto" && service.auto_restart !== 0 && service.stop_with_hoster === 0;
  }

  /**
   * Why (if any) a lifecycle action is a no-op for the given status. Returns a
   * human reason string when the action should be disabled, otherwise null.
   * Force restart is intentionally never gated — it's the stuck-service escape
   * hatch. Grounded in the status strings this page actually emits:
   * running / starting / stopping / stopped / crashed / building / error.
   */
  function lifecycleDisabledReason(status: string, action: "start" | "stop" | "restart"): string | null {
    if (action === "start") {
      if (status === "running") return "Already running";
      if (status === "starting") return "Already starting";
    }
    if (action === "stop") {
      if (status === "stopped") return "Already stopped";
      if (status === "crashed") return "Not running — nothing to stop";
      if (status === "stopping") return "Already stopping";
    }
    if (action === "restart") {
      if (status === "stopped") return "Stopped — start it instead";
      if (status === "crashed") return "Crashed — start it instead";
    }
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

  /** Ordered launch stages shown as progress bars in each service card. */
  const LAUNCH_STAGES = ["queued", "starting", "healthcheck", "live"] as const;

  /**
   * Resolve the real launch-panel state from the in-flight op + service status.
   * Maps the many runtime stage names (pulling/container/running/...) onto the
   * four displayed steps, and reports a single in-flight `activeIndex` plus a
   * `failed` flag so the panel can turn its bars red. Completed steps are every
   * step before the active one; the active step is never also "complete".
   */
  function launchPanelState(
    operation: ServiceOperation | undefined,
    status: string
  ): { activeIndex: number; failed: boolean } {
    const failed = operation?.status === "error" || status === "crashed" || status === "error";
    // A finished, healthy runtime: every step settled, nothing in-flight.
    if (operation?.status === "success" || status === "running") {
      return { activeIndex: LAUNCH_STAGES.length, failed };
    }
    if (status === "stopped" && !operation) {
      return { activeIndex: -1, failed };
    }
    // Translate the granular runtime stage into one of the four shown steps.
    const stage = operation?.stage ?? status;
    const stageToIndex: Record<string, number> = {
      queued: 0,
      starting: 1,
      pulling: 1,
      container: 1,
      building: 1,
      healthcheck: 2,
      live: 3,
      running: 3
    };
    const activeIndex = stageToIndex[stage] ?? (operation ? 0 : -1);
    return { activeIndex, failed };
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

  /**
   * Stack-level mirror of lifecycleDisabledReason: a stack action is a no-op
   * only when *every* member service would individually be a no-op for it.
   * Returns a reason string to disable + explain, or null when at least one
   * service can act.
   */
  function stackLifecycleDisabledReason(
    stack: ServiceStack,
    action: "start" | "stop" | "restart"
  ): string | null {
    const actionable = stack.services.some(
      (service) => lifecycleDisabledReason(service.status, action) === null
    );
    if (actionable) return null;
    if (action === "start") return "Every service is already running or starting";
    if (action === "stop") return "No running service to stop";
    return "No running service to restart";
  }

  /** True while any service in the stack has an in-flight op for this action. */
  function stackActionInFlight(stack: ServiceStack, action: "start" | "stop" | "restart"): boolean {
    return stack.services.some((service) => {
      const op = operations[service.id];
      return op?.action === action && (op.status === "queued" || op.status === "active");
    });
  }

  function primaryStackUrl(stack: ServiceStack): string | null {
    const frontend = stack.services.find(
      (service) => serviceRole(service, stack.services.length) === "Frontend"
    );
    return serviceUrl(frontend ?? stack.services[0]);
  }

  function serviceGitUpdate(service: Service): GitUpdateInfo | null {
    if (!service.latest_git_commit_hash || !service.latest_git_updated_at) return null;
    return {
      serviceName: service.name,
      commitHash: service.latest_git_commit_hash,
      updatedAt: service.latest_git_updated_at,
      triggerSource: service.latest_git_trigger_source ?? null,
      branch: service.latest_git_branch ?? service.github_branch ?? null
    };
  }

  function gitShort(hash: string | null | undefined): string {
    return hash ? hash.slice(0, 7) : "none";
  }

  function servicePendingGitUpdate(service: Service): GithubSyncStatus | null {
    const status = githubSyncStatuses[service.id];
    if (!status?.updateAvailable || !status.remoteHash) return null;
    return status;
  }

  function pendingGitTitle(service: Service, status: GithubSyncStatus): string {
    const local = status.latestCommitHash ?? service.latest_git_commit_hash ?? null;
    const branch = status.branch || service.github_branch || "main";
    const action =
      service.status === "running"
        ? "deploy latest to restart it with the new code"
        : "deploy latest before starting it";
    const automation = status.autoPull
      ? "Auto-deploy is enabled; this should clear after the next successful Git deployment."
      : "Auto-deploy is off; this needs a manual Git deploy.";
    return `${service.name} has a pending Git update on ${branch}: remote ${gitShort(
      status.remoteHash
    )}, deployed ${gitShort(local)}. ${action}. ${automation}`;
  }

  function stackGitUpdate(stack: ServiceStack): GitUpdateInfo | null {
    return stack.services.reduce<GitUpdateInfo | null>((latest, service) => {
      const current = serviceGitUpdate(service);
      if (!current) return latest;
      if (!latest) return current;
      return Date.parse(current.updatedAt) > Date.parse(latest.updatedAt) ? current : latest;
    }, null);
  }

  function gitUpdateTitle(info: GitUpdateInfo): string {
    const date = new Date(info.updatedAt).toLocaleString();
    const branch = info.branch ? ` on ${info.branch}` : "";
    return `${info.serviceName} pulled ${info.commitHash.slice(0, 7)}${branch} via ${gitSourceLabel(
      info.triggerSource
    )} at ${date}`;
  }

  function serviceGitSummary(service: Service): GitSummary | null {
    const pending = servicePendingGitUpdate(service);
    const info = serviceGitUpdate(service);
    if (pending) {
      const local = pending.latestCommitHash ?? info?.commitHash ?? null;
      return {
        text:
          service.status === "running"
            ? "Pending Git update: deploy latest to refresh live service"
            : "Pending Git update: deploy latest before start",
        title: pendingGitTitle(service, pending),
        empty: false,
        pending: true,
        commitHash: local ?? undefined,
        remoteHash: pending.remoteHash ?? undefined,
        serviceId: service.id
      };
    }
    if (info) {
      return {
        text: `Last updated by Git ${relativeTime(info.updatedAt)} via ${gitSourceLabel(info.triggerSource)}`,
        title: gitUpdateTitle(info),
        empty: false,
        pending: false,
        commitHash: info.commitHash
      };
    }
    if (!service.github_repo_url) return null;
    return {
      text:
        service.github_auto_pull === 0
          ? "Last updated by Git: never (auto off)"
          : "Last updated by Git: never pulled",
      title: "Git repository linked, but no successful Git pull/deployment is recorded yet",
      empty: true,
      pending: false
    };
  }

  function stackGitSummary(stack: ServiceStack): GitSummary | null {
    const pendingUpdates = stack.services
      .map((service) => ({ service, status: servicePendingGitUpdate(service) }))
      .filter((item): item is { service: Service; status: GithubSyncStatus } => Boolean(item.status));
    const pending = pendingUpdates.find((item) => item.service.status === "running") ?? pendingUpdates[0];
    if (pending) {
      const local = pending.status.latestCommitHash ?? pending.service.latest_git_commit_hash ?? null;
      return {
        text:
          pending.service.status === "running"
            ? `Pending Git update: ${pending.service.name} is live on older code`
            : `Pending Git update: ${pending.service.name} has newer remote code`,
        title: pendingGitTitle(pending.service, pending.status),
        empty: false,
        pending: true,
        commitHash: local ?? undefined,
        remoteHash: pending.status.remoteHash ?? undefined,
        serviceId: pending.service.id
      };
    }
    const latest = stackGitUpdate(stack);
    if (latest) {
      return {
        text: `Last updated by Git ${relativeTime(latest.updatedAt)} via ${gitSourceLabel(latest.triggerSource)}`,
        title: gitUpdateTitle(latest),
        empty: false,
        pending: false,
        commitHash: latest.commitHash
      };
    }
    if (!stack.services.some((service) => Boolean(service.github_repo_url))) return null;
    return {
      text: "Last updated by Git: never pulled",
      title: "At least one service is linked to Git, but no successful Git pull/deployment is recorded yet",
      empty: true,
      pending: false
    };
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
          <h2>Services</h2>
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

      <section className="action-grid feature-grid">
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
          aria-label="Open Quick Launch"
          data-tooltip="Import a folder, pick a dev server, and launch"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowQuickLaunch(true);
            }
          }}
        >
          <div className="icon-box" style={{ background: "var(--blue)", color: "white" }}>
            <Play size={24} />
          </div>
          <h3>Quick Launch</h3>
          <p className="muted small">Zero-config instant deployment.</p>
          <button className="primary small">Fire Up</button>
        </motion.div>

        <motion.div
          whileHover={{ y: -5 }}
          className="action-card"
          onClick={() => setShowCreateModal(true)}
          role="button"
          tabIndex={0}
          aria-label="Create a custom service"
          data-tooltip="Manually configure a process, Docker image, or static web folder"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowCreateModal(true);
            }
          }}
        >
          <div className="icon-box" style={{ color: "var(--green)" }}>
            <Plus size={24} />
          </div>
          <h3>Custom Service</h3>
          <p className="muted small">Create a process, Docker image, or static site.</p>
          <button className="small">Configure</button>
        </motion.div>
      </section>

      <section className="operator-groups-section">
        <div className="section-title">
          <div className="row">
            <Layers size={18} />
            <h3>Service Groups</h3>
            <span className="badge accent">{operatorGroups.length} groups</span>
          </div>
          <button className="ghost xsmall" onClick={() => setEditingOperatorGroup("new")}>
            <Plus size={14} /> New Group
          </button>
        </div>

        {operatorGroups.length === 0 ? (
          <div className="operator-groups-empty">
            <span>No service groups yet.</span>
            <button className="primary xsmall" onClick={() => setEditingOperatorGroup("new")}>
              <Plus size={14} /> Create Group
            </button>
          </div>
        ) : (
          <div className="operator-group-list">
            {operatorGroups.map((group) => {
              const status = operatorGroupStatus(group);
              const running = group.services.filter((service) => service.status === "running").length;
              const startReason = operatorGroupDisabledReason(group, "start");
              const restartReason = operatorGroupDisabledReason(group, "restart");
              const stopReason = operatorGroupDisabledReason(group, "stop");
              return (
                <section key={group.id} className={`operator-group operator-group-${status}`}>
                  <div className="operator-group-main">
                    <div className="operator-group-title">
                      <div className="row">
                        <h4>{group.name}</h4>
                        <StatusBadge status={status} label={status} />
                      </div>
                      {group.description && <p className="muted small">{group.description}</p>}
                    </div>
                    <div className="operator-group-stats">
                      <span>
                        {running}/{group.services.length} running
                      </span>
                      <span>{group.services.length} selected</span>
                    </div>
                  </div>

                  <div className="operator-group-members">
                    {group.services.length === 0 ? (
                      <span className="operator-group-member muted">No services selected</span>
                    ) : (
                      group.services.map((service) => {
                        const url = serviceUrl(service);
                        return url ? (
                          <a
                            key={service.id}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="operator-group-member"
                            data-tooltip="Open service endpoint"
                          >
                            <StatusBadge status={service.status} dotOnly />
                            <span>{service.name}</span>
                            {service.port && <code>{service.port}</code>}
                          </a>
                        ) : (
                          <span key={service.id} className="operator-group-member">
                            <StatusBadge status={service.status} dotOnly />
                            <span>{service.name}</span>
                            {service.port && <code>{service.port}</code>}
                          </span>
                        );
                      })
                    )}
                  </div>

                  <div className="operator-group-actions">
                    <button
                      className="ghost xsmall"
                      disabled={Boolean(startReason)}
                      data-tooltip={startReason ?? "Start every service in this group"}
                      title={startReason ?? undefined}
                      onClick={() => void operatorGroupAction(group, "start")}
                    >
                      {operatorGroupActionInFlight(group, "start") ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      Start all
                    </button>
                    <button
                      className="ghost xsmall"
                      disabled={Boolean(restartReason)}
                      data-tooltip={restartReason ?? "Restart every service in this group"}
                      title={restartReason ?? undefined}
                      onClick={() => void operatorGroupAction(group, "restart")}
                    >
                      {operatorGroupActionInFlight(group, "restart") ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RotateCw size={14} />
                      )}
                      Restart all
                    </button>
                    <button
                      className="ghost xsmall"
                      disabled={Boolean(stopReason)}
                      data-tooltip={stopReason ?? "Stop every service in this group"}
                      title={stopReason ?? undefined}
                      onClick={() => void operatorGroupAction(group, "stop")}
                    >
                      {operatorGroupActionInFlight(group, "stop") ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Square size={14} />
                      )}
                      Stop all
                    </button>
                    <button
                      className="ghost xsmall"
                      onClick={() => setEditingOperatorGroup(group)}
                      aria-label={`Edit ${group.name}`}
                      data-tooltip="Edit group"
                    >
                      <Settings2 size={14} /> Edit
                    </button>
                    <button
                      className="ghost xsmall text-danger"
                      onClick={() => void deleteOperatorGroup(group)}
                      aria-label={`Delete ${group.name}`}
                      data-tooltip="Delete group"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
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

        {filteredServices.length === 0 && loadError && services.length === 0 ? (
          <div className="empty-state is-error">
            <AlertTriangle size={48} />
            <h3>Couldn't load your services</h3>
            <p>
              We couldn't reach the LocalSURV runtime to fetch your services. Check that it's running, then
              try again.
            </p>
            <button className="primary" onClick={() => void load()}>
              <RotateCw size={16} /> Retry
            </button>
          </div>
        ) : filterHidEverything ? (
          <div className="filter-empty">
            <Search size={40} className="text-muted" />
            <h3>No services match</h3>
            <p className="muted small">
              No services match your current search or environment filter. Try a different query or clear the
              filters to see everything.
            </p>
            <button className="ghost" onClick={clearFilters}>
              <XCircle size={16} /> Clear filters
            </button>
          </div>
        ) : filteredServices.length === 0 ? (
          <div className="card text-center empty-state-card">
            <Box size={60} className="text-muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
            <h3 className="muted">No app resources detected in this environment.</h3>
            <p className="muted small" style={{ maxWidth: "400px", margin: "0.75rem auto 1rem" }}>
              Start by connecting a repository or importing a stack to create your first application
              workspace.
            </p>
            <button className="primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} /> Create Custom Service
            </button>
          </div>
        ) : (
          <div className="service-groups">
            {visibleServiceGroups.map((group) => (
              <section key={group.id} className="service-group">
                {groupByProject && <h4 className="service-group-title">{group.title}</h4>}
                <div className="app-stack-list">
                  {buildServiceStacks(group.services).map((stack) => {
                    const stackGit = stackGitSummary(stack);
                    const stackGitService = stackGit?.serviceId
                      ? stack.services.find((service) => service.id === stackGit.serviceId)
                      : null;
                    return (
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
                            {stackGit && (
                              <div
                                className={`stack-git-update ${stackGit.empty ? "empty" : ""} ${stackGit.pending ? "pending" : ""}`}
                                title={stackGit.title}
                              >
                                {stackGit.pending ? <AlertTriangle size={13} /> : <GitBranch size={13} />}
                                <span>{stackGit.text}</span>
                                {stackGit.commitHash && <code>{stackGit.commitHash.slice(0, 7)}</code>}
                                {stackGit.remoteHash && <code>remote {stackGit.remoteHash.slice(0, 7)}</code>}
                              </div>
                            )}
                          </div>
                          <div className="stack-service-pills">
                            {stackGit && (
                              <span
                                className={`stack-service-pill git-update-pill ${stackGit.empty ? "empty" : ""} ${stackGit.pending ? "pending" : ""}`}
                                title={stackGit.title}
                              >
                                {stackGit.pending ? <AlertTriangle size={12} /> : <GitBranch size={12} />}
                                {stackGit.text}
                              </span>
                            )}
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
                          {(() => {
                            const startReason = stackLifecycleDisabledReason(stack, "start");
                            return (
                              <button
                                className="ghost xsmall"
                                disabled={Boolean(startReason)}
                                data-tooltip={startReason ?? "Start every runtime in this stack"}
                                title={startReason ?? undefined}
                                onClick={() => void stackAction(stack, "start")}
                              >
                                {stackActionInFlight(stack, "start") ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Play size={14} />
                                )}{" "}
                                Start stack
                              </button>
                            );
                          })()}
                          {(() => {
                            const restartReason = stackLifecycleDisabledReason(stack, "restart");
                            return (
                              <button
                                className="ghost xsmall"
                                disabled={Boolean(restartReason)}
                                data-tooltip={restartReason ?? "Restart every runtime in this stack"}
                                title={restartReason ?? undefined}
                                onClick={() => void stackAction(stack, "restart")}
                              >
                                {stackActionInFlight(stack, "restart") ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <RotateCw size={14} />
                                )}{" "}
                                Restart stack
                              </button>
                            );
                          })()}
                          {stackGit?.pending && stackGitService && (
                            <button
                              className="ghost xsmall git-pending-action"
                              disabled={redeployingGitId === stackGitService.id}
                              onClick={() => void deployLatestFromGit(stackGitService)}
                            >
                              {redeployingGitId === stackGitService.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <GitBranch size={14} />
                              )}
                              Deploy latest
                            </button>
                          )}
                          {(() => {
                            const stopReason = stackLifecycleDisabledReason(stack, "stop");
                            return (
                              <button
                                className="ghost xsmall"
                                disabled={Boolean(stopReason)}
                                data-tooltip={stopReason ?? "Stop every runtime in this stack"}
                                title={stopReason ?? undefined}
                                onClick={() => void stackAction(stack, "stop")}
                              >
                                {stackActionInFlight(stack, "stop") ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Square size={14} />
                                )}{" "}
                                Stop stack
                              </button>
                            );
                          })()}
                          <button
                            className="ghost xsmall"
                            disabled={provisioningId === databaseServiceForStack(stack)?.id}
                            onClick={() => openDatabaseFlowForStack(stack)}
                            data-tooltip="Create and link a managed database for this app. Existing embedded SQLite data is detected before setup."
                          >
                            {provisioningId === databaseServiceForStack(stack)?.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <DatabaseIcon size={14} />
                            )}
                            {databaseActionLabel(stack)}
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
                          {stack.services
                            .map((service) => serviceSupabaseResource(service.id))
                            .filter(
                              (resource, index, list): resource is ManagedResourceDetail =>
                                resource !== null && list.indexOf(resource) === index
                            )
                            .map((resource) => (
                              <Link
                                key={resource.id}
                                to="/databases"
                                className={`resource-node database ${resource.status}`}
                                data-tooltip="Local Supabase stack — manage it on the Databases page"
                              >
                                <Zap size={16} />
                                <strong>Supabase</strong>
                                <span>{resource.status}</span>
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
                                const gitSummary = serviceGitSummary(service);
                                const pendingGit = servicePendingGitUpdate(service);
                                const actionBusy =
                                  op?.status === "queued" ||
                                  op?.status === "active" ||
                                  service.status === "starting" ||
                                  service.status === "stopping";
                                const alwaysOn = serviceAlwaysOn(service);
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
                                          <span className="tiny muted font-bold uppercase">
                                            {service.type}
                                          </span>
                                          <button
                                            type="button"
                                            className={`always-on-toggle${alwaysOn ? " active" : ""}`}
                                            disabled={alwaysOnBusyId === service.id}
                                            aria-pressed={alwaysOn}
                                            aria-label={
                                              alwaysOn
                                                ? `Disable always on for ${service.name}`
                                                : `Enable always on for ${service.name}`
                                            }
                                            data-tooltip={
                                              alwaysOn
                                                ? "24/7: auto-starts, restarts on crash, and survives ServerHoster restarts"
                                                : "Enable 24/7 mode for this service"
                                            }
                                            onClick={() => void toggleAlwaysOn(service)}
                                          >
                                            {alwaysOnBusyId === service.id ? (
                                              <Loader2 size={11} className="animate-spin" />
                                            ) : (
                                              <Clock size={11} />
                                            )}
                                            24/7
                                          </button>
                                          {gitSummary && (
                                            <span
                                              className={`tiny row service-git-chip ${gitSummary.empty ? "empty" : ""} ${gitSummary.pending ? "pending" : ""}`}
                                              title={gitSummary.title}
                                            >
                                              {gitSummary.pending ? (
                                                <AlertTriangle size={10} />
                                              ) : (
                                                <GitBranch size={10} />
                                              )}
                                              {gitSummary.text}
                                              {gitSummary.commitHash && (
                                                <code>{gitSummary.commitHash.slice(0, 7)}</code>
                                              )}
                                              {gitSummary.remoteHash && (
                                                <code>remote {gitSummary.remoteHash.slice(0, 7)}</code>
                                              )}
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

                                      {pendingGit && (
                                        <div
                                          className="git-pending-alert"
                                          title={pendingGitTitle(service, pendingGit)}
                                        >
                                          <AlertTriangle size={16} />
                                          <div>
                                            <strong>Pending Git update</strong>
                                            <span>
                                              Remote {gitShort(pendingGit.remoteHash)} is newer than deployed{" "}
                                              {gitShort(
                                                pendingGit.latestCommitHash ?? service.latest_git_commit_hash
                                              )}
                                              .{" "}
                                              {service.status === "running"
                                                ? "Deploy latest to restart this live service with the new code."
                                                : "Deploy latest before starting this service."}
                                            </span>
                                          </div>
                                          <button
                                            className="ghost xsmall git-pending-action"
                                            disabled={redeployingGitId === service.id}
                                            onClick={() => void deployLatestFromGit(service)}
                                          >
                                            {redeployingGitId === service.id ? (
                                              <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                              <GitBranch size={14} />
                                            )}
                                            Deploy latest
                                          </button>
                                        </div>
                                      )}

                                      {(() => {
                                        // Dependency-aware prompt: one backend recognition report decides
                                        // satisfied/missing/conflict across resources, legacy DBs, env, and SQLite.
                                        const recognition = recognitionFor(service.id);
                                        const actionable = actionableRecognition(service.id);
                                        if (actionable) {
                                          const profile = actionable.detected.profile;
                                          const topIssue = actionable.issues[0];
                                          const isSupabase = profile === "supabase";
                                          const headline =
                                            actionable.state === "conflict"
                                              ? `${profileLabel(profile)} configuration conflict`
                                              : actionable.current_provider.kind === "embedded-sqlite"
                                                ? "SQLite detected — review persistence"
                                                : `${profileLabel(profile)} ${actionable.state === "missing" ? "needed" : "needs attention"}`;
                                          const detail =
                                            topIssue?.message ??
                                            `ServerHoster detected ${profileLabel(profile)} signals and needs a provider check.`;
                                          return (
                                            <div className={isSupabase ? "res-supabase-banner" : "db-suggest-banner"}>
                                              <DatabaseIcon size={14} />
                                              <div className={isSupabase ? "res-supabase-text" : "db-suggest-text"}>
                                                <strong>{headline}</strong>
                                                <span>{detail}</span>
                                                <span className="muted tiny">
                                                  Current: {actionable.current_provider.label}
                                                  {actionable.current_provider.env_key
                                                    ? ` via ${actionable.current_provider.env_key}`
                                                    : ""}
                                                </span>
                                                {actionable.issues.slice(1, 3).map((issue) => (
                                                  <span key={`${issue.code}-${issue.message}`} className="res-hosted-note">
                                                    <AlertTriangle size={11} /> {issue.message}
                                                  </span>
                                                ))}
                                                <span className="res-supabase-actions">
                                                  {isSupabase && (
                                                    <button
                                                      className="ghost tiny"
                                                      onClick={() =>
                                                        setProvisionTarget({ service, profile: "supabase" })
                                                      }
                                                    >
                                                      Review requirements
                                                    </button>
                                                  )}
                                                  {actionable.providers.some((p) => p.kind === "hosted-env") && (
                                                    <button
                                                      className="ghost tiny"
                                                      onClick={() => void chooseHostedProvider(service)}
                                                    >
                                                      Use hosted/manual env
                                                    </button>
                                                  )}
                                                  {isSupabase && (
                                                    <button
                                                      className="ghost tiny"
                                                      onClick={() => void quickAddDatabase(service)}
                                                    >
                                                      Use plain Postgres anyway
                                                    </button>
                                                  )}
                                                  <button
                                                    className="ghost tiny"
                                                    disabled={rescanningId === service.id}
                                                    onClick={() => void rescanService(service)}
                                                  >
                                                    {rescanningId === service.id ? (
                                                      <Loader2 size={11} className="animate-spin" />
                                                    ) : (
                                                      "Rescan"
                                                    )}
                                                  </button>
                                                </span>
                                              </div>
                                              <button
                                                className="primary xsmall"
                                                disabled={provisioningId === service.id}
                                                onClick={() => void runRecognitionPrimaryAction(service, actionable)}
                                              >
                                                {provisioningId === service.id ? (
                                                  <>
                                                    <Loader2 size={12} className="animate-spin" /> Working…
                                                  </>
                                                ) : (
                                                  databaseActionLabel({
                                                    id: stack.id,
                                                    title: stack.title,
                                                    services: [service],
                                                    databases: []
                                                  })
                                                )}
                                              </button>
                                            </div>
                                          );
                                        }
                                        const linkedSupabase = serviceSupabaseResource(service.id);
                                        if (linkedSupabase) {
                                          return (
                                            <div className="res-linked-chip-row">
                                              <Link
                                                to="/databases"
                                                className={`res-linked-chip ${linkedSupabase.status}`}
                                                data-tooltip="Open the stack console on the Databases page"
                                              >
                                                <DatabaseIcon size={12} />
                                                Local Supabase · {linkedSupabase.status}
                                              </Link>
                                            </div>
                                          );
                                        }
                                        if (
                                          recognition?.state === "satisfied" &&
                                          recognition.current_provider.kind !== "none" &&
                                          recognition.detected.profile !== "manual"
                                        ) {
                                          return (
                                            <div className="res-linked-chip-row">
                                              <Link
                                                to="/databases"
                                                className={`res-linked-chip ${recognition.current_provider.kind === "hosted-env" ? "hosted" : "running"}`}
                                                data-tooltip={recognition.current_provider.details ?? "Open database recognition on the Databases page"}
                                              >
                                                <DatabaseIcon size={12} />
                                                {recognition.current_provider.kind === "hosted-env"
                                                  ? `Hosted ${providerProfileLabel(recognition.detected.profile)}`
                                                  : `${profileLabel(recognition.detected.profile)} · ${recognition.current_provider.label}`}
                                              </Link>
                                            </div>
                                          );
                                        }
                                        const orphan = orphans.get(service.id);
                                        const embedded = embeddedDbs.get(service.id);
                                        const isFrontend =
                                          serviceRole(service, stack.services.length) === "Frontend";
                                        const stackHasDatabaseOwner = stack.services.some(
                                          (candidate) =>
                                            candidate.id !== service.id &&
                                            (embeddedDbs.has(candidate.id) ||
                                              serviceRole(candidate, stack.services.length) === "API")
                                        );
                                        // Only nag when we have a real reason: detected SQLite or
                                        // a code-level driver. Silent for orphans that legitimately
                                        // don't need a DB (static frontends, etc.). In multi-service
                                        // apps, the API owns the DB; the frontend should call the API.
                                        if (!embedded && isFrontend && stackHasDatabaseOwner) return null;
                                        if (!orphan || (!embedded && orphan.code_signals.length === 0))
                                          return null;
                                        const drivers = orphan.code_signals.map((s) => s.driver);
                                        const uniqueDrivers = Array.from(new Set(drivers));
                                        const offer = detectedDatabaseOffer(drivers);
                                        const headline = embedded
                                          ? "SQLite detected — promote to Postgres"
                                          : offer?.headline ?? "No managed database";
                                        const detail = embedded
                                          ? `${embedded.file_path} won't survive container recreates.`
                                          : (offer?.detail(uniqueDrivers) ??
                                            `Your code uses ${uniqueDrivers.slice(0, 3).join(", ")}${uniqueDrivers.length > 3 ? "..." : ""}. Add a managed dependency for this service.`);
                                        const dataDir = service.data_dir_container ?? service.data_dir;
                                        return (
                                          <div className="db-suggest-banner">
                                            <DatabaseIcon size={14} />
                                            <div className="db-suggest-text">
                                              <strong>{headline}</strong>
                                              <span>{detail}</span>
                                              {dataDir && (
                                                <span className="muted tiny">
                                                  Or keep files in{" "}
                                                  <code
                                                    className="copyable"
                                                    data-tooltip="Copy path — injected as $DATA_DIR, survives redeploys"
                                                    onClick={() => {
                                                      void navigator.clipboard
                                                        .writeText(dataDir)
                                                        .then(() => toast.success("DATA_DIR path copied"))
                                                        .catch(() => toast.error("Clipboard failed"));
                                                    }}
                                                  >
                                                    $DATA_DIR
                                                  </code>{" "}
                                                  — a persistent dir that survives redeploys.
                                                </span>
                                              )}
                                            </div>
                                            <button
                                              className="primary xsmall"
                                              disabled={provisioningId === service.id}
                                              onClick={() =>
                                                embedded
                                                  ? setPromoteTarget(embedded)
                                                  : offer
                                                    ? void provisionDetectedResource(service, offer)
                                                    : void quickAddDatabase(service)
                                              }
                                            >
                                              {provisioningId === service.id ? (
                                                <>
                                                  <Loader2 size={12} className="animate-spin" /> Provisioning…
                                                </>
                                              ) : embedded ? (
                                                "Promote data"
                                              ) : offer ? (
                                                offer.actionLabel
                                              ) : (
                                                "Add Postgres"
                                              )}
                                            </button>
                                          </div>
                                        );
                                      })()}

                                      {(() => {
                                        // Persistent uploads: dirs symlinked into the data
                                        // volume so admin/runtime uploads survive the git
                                        // hard-reset every deploy does. Editing custom paths
                                        // takes effect on the next deploy/restart.
                                        const persisted = service.persisted_paths ?? [];
                                        let cfg: { auto?: boolean; paths?: string[]; exclude?: string[] } = {};
                                        try {
                                          cfg = service.persisted_paths_config
                                            ? JSON.parse(service.persisted_paths_config)
                                            : {};
                                        } catch {
                                          cfg = {};
                                        }
                                        const autoOn = cfg.auto !== false;
                                        const isDocker = service.type === "docker";
                                        const editPaths = async (): Promise<void> => {
                                          const current = (cfg.paths ?? []).join(", ");
                                          const input = window.prompt(
                                            isDocker
                                              ? "Container paths to keep across deploys (comma-separated, absolute — e.g. /app/static/images). Bind-mounted from the persistent volume."
                                              : "Upload directories to keep across deploys (comma-separated, repo-relative — e.g. app/static/images). Symlinked into the persistent volume so a git update can't revert admin uploads.",
                                            current
                                          );
                                          if (input === null) return;
                                          const paths = input
                                            .split(",")
                                            .map((s) => s.trim())
                                            .filter(Boolean);
                                          try {
                                            await api(`/services/${service.id}`, {
                                              method: "PATCH",
                                              body: JSON.stringify({
                                                persistedPathsConfig: { auto: autoOn, paths, exclude: cfg.exclude ?? [] }
                                              })
                                            });
                                            toast.success("Persistent uploads saved — redeploy or restart to apply");
                                            void load();
                                          } catch {
                                            toast.error("Could not update persistent uploads");
                                          }
                                        };
                                        return (
                                          <div className="persisted-uploads-row muted tiny">
                                            <DatabaseIcon size={12} />
                                            <span>
                                              Persistent uploads:{" "}
                                              {persisted.length ? (
                                                persisted.map((p, i) => (
                                                  <span key={p}>
                                                    {i > 0 ? " " : ""}
                                                    <code>{p}</code>
                                                  </span>
                                                ))
                                              ) : (
                                                <em>none detected</em>
                                              )}
                                              {!isDocker && (autoOn ? " · auto-detect on" : " · auto-detect off")}
                                            </span>
                                            <button className="link xsmall" onClick={() => void editPaths()}>
                                              Edit
                                            </button>
                                          </div>
                                        );
                                      })()}

                                      {(() => {
                                        const missing = (envRequirements.get(service.id) ?? []).filter(
                                          (item) => item.status === "missing"
                                        );
                                        if (missing.length === 0) return null;
                                        const preview = missing.slice(0, 5).map((item) => item.key);
                                        const extra = missing.length - preview.length;
                                        return (
                                          <div className="env-missing-banner">
                                            <KeyRound size={14} />
                                            <div className="env-missing-text">
                                              <strong>Missing required env</strong>
                                              <span>
                                                {preview.join(", ")}
                                                {extra > 0 ? ` +${extra} more` : ""}
                                              </span>
                                            </div>
                                            <button
                                              className="ghost xsmall"
                                              onClick={() => setEditingService(service)}
                                              data-tooltip="Add service or project environment variables"
                                              aria-label={`Open environment settings for ${service.name}`}
                                            >
                                              Add env
                                            </button>
                                          </div>
                                        );
                                      })()}

                                      {(() => {
                                        const launch = launchPanelState(op, service.status);
                                        return (
                                          <div
                                            className={`launch-panel ${op?.status ?? service.status}${
                                              launch.failed ? " error crashed" : ""
                                            }`}
                                          >
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
                                              {LAUNCH_STAGES.map((stage, index) => {
                                                const complete = index < launch.activeIndex;
                                                const active = index === launch.activeIndex;
                                                return (
                                                  <span
                                                    key={stage}
                                                    className={`launch-step${complete ? " complete" : ""}${
                                                      active ? " active" : ""
                                                    }`}
                                                  />
                                                );
                                              })}
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
                                        );
                                      })()}
                                    </div>

                                    <div className="service-footer">
                                      <div className="row" style={{ gap: "0.25rem" }}>
                                        {(() => {
                                          const startReason = lifecycleDisabledReason(
                                            service.status,
                                            "start"
                                          );
                                          const stopReason = lifecycleDisabledReason(service.status, "stop");
                                          const restartReason = lifecycleDisabledReason(
                                            service.status,
                                            "restart"
                                          );
                                          const inFlight = (action: ServiceOperation["action"]) =>
                                            actionBusy && op?.action === action;
                                          return (
                                            <>
                                              <button
                                                className="ghost xsmall"
                                                disabled={actionBusy || Boolean(startReason)}
                                                aria-label={`Start ${service.name}`}
                                                data-tooltip={
                                                  startReason ?? "Start service and stream launch progress"
                                                }
                                                title={startReason ?? undefined}
                                                onClick={() => serviceAction(service.id, "start")}
                                              >
                                                {inFlight("start") ? (
                                                  <Loader2 size={14} className="animate-spin" />
                                                ) : (
                                                  <Play size={14} />
                                                )}
                                              </button>
                                              <button
                                                className="ghost xsmall"
                                                disabled={actionBusy || Boolean(stopReason)}
                                                aria-label={`Stop ${service.name}`}
                                                data-tooltip={
                                                  stopReason ?? "Stop service and show shutdown progress"
                                                }
                                                title={stopReason ?? undefined}
                                                onClick={() => serviceAction(service.id, "stop")}
                                              >
                                                {inFlight("stop") ? (
                                                  <Loader2 size={14} className="animate-spin" />
                                                ) : (
                                                  <Square size={14} />
                                                )}
                                              </button>
                                              <button
                                                className="ghost xsmall"
                                                disabled={actionBusy || Boolean(restartReason)}
                                                aria-label={`Restart ${service.name}`}
                                                data-tooltip={
                                                  restartReason ?? "Restart service with live progress"
                                                }
                                                title={restartReason ?? undefined}
                                                onClick={() => serviceAction(service.id, "restart")}
                                              >
                                                {inFlight("restart") ? (
                                                  <Loader2 size={14} className="animate-spin" />
                                                ) : (
                                                  <RotateCw size={14} />
                                                )}
                                              </button>
                                            </>
                                          );
                                        })()}
                                        <button
                                          className="ghost xsmall text-warning"
                                          disabled={forceRestartingId === service.id}
                                          aria-label={`Force restart ${service.name}`}
                                          data-tooltip="Force restart — hard-kills a stuck service and starts it again"
                                          onClick={() => void forceRestart(service)}
                                        >
                                          {forceRestartingId === service.id ? (
                                            <Loader2 size={14} className="animate-spin" />
                                          ) : (
                                            <Power size={14} />
                                          )}
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
                                        onClick={() => openServiceTerminal(service, "shell")}
                                        aria-label={`Open console for ${service.name}`}
                                        data-tooltip="Open interactive console"
                                      >
                                        <Terminal size={14} /> Console
                                      </button>

                                      <button
                                        className="ghost xsmall"
                                        onClick={() => openServiceTerminal(service, "agents")}
                                        aria-label={`Open agents for ${service.name}`}
                                        data-tooltip="Install, authenticate, and run AI agents"
                                      >
                                        <Bot size={14} /> Agents
                                      </button>

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
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="logs-container">
        <div className="section-title">
          <div className="row">
            <Terminal size={18} />
            <h3>System Event Feed</h3>
          </div>
        </div>
        <div className="logs-viewer" style={{ height: "300px" }}>
          {logs.length === 0 ? (
            <div className="muted italic text-center empty-state-card">
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
      {editingOperatorGroup && (
        <ServiceGroupModal
          group={editingOperatorGroup === "new" ? null : editingOperatorGroup}
          services={services}
          onClose={() => setEditingOperatorGroup(null)}
          onSaved={() => {
            setEditingOperatorGroup(null);
            void load();
          }}
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
      {provisionTarget && (
        <ResourceProvisionModal
          serviceId={provisionTarget.service.id}
          serviceName={provisionTarget.service.name}
          profile={provisionTarget.profile}
          onClose={() => setProvisionTarget(null)}
          onProvisioned={() => void load()}
        />
      )}
      {promoteTarget && (
        <PromoteEmbeddedDbModal
          embedded={promoteTarget}
          onClose={() => setPromoteTarget(null)}
          onPromoted={() => void load()}
        />
      )}
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
        .env-missing-banner {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          margin: 0.5rem 0;
          padding: 0.55rem 0.75rem;
          border: 1px dashed color-mix(in srgb, var(--warn, #d97706) 55%, transparent);
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--warn, #d97706) 10%, var(--bg-sunken));
          color: var(--text-primary);
        }
        .env-missing-banner svg { color: var(--warn, #d97706); flex-shrink: 0; }
        .env-missing-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.25; }
        .env-missing-text strong { font-size: 0.78rem; }
        .env-missing-text span { font-size: 0.7rem; color: var(--text-muted); overflow-wrap: anywhere; }
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

function ServiceGroupModal({
  group,
  services,
  onClose,
  onSaved
}: {
  group: OperatorServiceGroup | null;
  services: Service[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(group?.service_ids ?? []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
    setSelected(new Set(group?.service_ids ?? []));
  }, [group]);

  const sortedServices = useMemo(
    () => [...services].sort((a, b) => a.name.localeCompare(b.name)),
    [services]
  );

  function toggleService(serviceId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Group name is required");
      return;
    }
    setSaving(true);
    try {
      await api(group ? `/service-groups/${group.id}` : "/service-groups", {
        method: group ? "PUT" : "POST",
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim(),
          serviceIds: Array.from(selected)
        })
      });
      toast.success(group ? "Service group updated" : "Service group created");
      onSaved();
    } catch {
      /* api handles toast */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-content service-group-modal" onSubmit={(event) => void save(event)}>
        <div className="modal-header">
          <h3>{group ? "Edit Service Group" : "New Service Group"}</h3>
        </div>
        <div className="modal-body">
          <div className="form-stack">
            <div className="form-group">
              <label htmlFor="service-group-name">Name</label>
              <input
                id="service-group-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Daily launch"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="service-group-description">Description</label>
              <textarea
                id="service-group-description"
                value={description ?? ""}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Production services"
                rows={3}
              />
            </div>
            <div className="form-group">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label>Services</label>
                <span className="muted tiny">{selected.size} selected</span>
              </div>
              <div className="service-group-service-list">
                {sortedServices.length === 0 ? (
                  <div className="muted small">No services available.</div>
                ) : (
                  sortedServices.map((service) => (
                    <label key={service.id} className="service-group-checkbox-row">
                      <input
                        type="checkbox"
                        checked={selected.has(service.id)}
                        onChange={() => toggleService(service.id)}
                      />
                      <StatusBadge status={service.status} dotOnly />
                      <span>{service.name}</span>
                      <code>{service.type}</code>
                      {service.port && <code>{service.port}</code>}
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {group ? "Save Group" : "Create Group"}
          </button>
        </div>
      </form>
    </div>
  );
}
