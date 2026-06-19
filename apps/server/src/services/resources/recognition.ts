import { nowIso } from "../../lib/core.js";
import { decryptSecret, maskSecret } from "../../security.js";
import type { AppContext } from "../../types.js";
import {
  buildConnectionString,
  containerNameForDatabase,
  getDatabase,
  type DatabaseRow
} from "../databases.js";
import { listEmbeddedDatabases, type EmbeddedDatabase } from "../embeddedDatabases.js";
import {
  createResource,
  getResource,
  linkResourceToService,
  listLinksForService,
  resourceConfig,
  type ManagedResourceRow
} from "./lifecycle.js";
import {
  listProfiles,
  type DetectionSignal,
  type ProvisionPlan,
  type ResourceProfileId
} from "./profiles.js";
import { getLatestScan, runDependencyScan } from "./scan.js";
import { scanFunctionSecrets, type FunctionSecretRequirement } from "./secretsScan.js";
import { classifySecretStates } from "./functions.js";
import { setResourceSecret } from "./secrets.js";

type DetectionConfidence = "high" | "medium" | "low";
export type RecognitionState = "satisfied" | "missing" | "partial" | "conflict" | "unknown";
type ProviderKind =
  | "managed-resource"
  | "legacy-database"
  | "hosted-env"
  | "manual-env"
  | "embedded-sqlite"
  | "data-dir"
  | "none";
type ProviderSource = "resource" | "legacy" | "service-env" | "project-env" | "runtime" | "docker" | "none";

export type RecognitionProvider = {
  kind: ProviderKind;
  label: string;
  profile: ResourceProfileId | "sqlite" | null;
  source: ProviderSource;
  resource_id?: string;
  database_id?: string;
  env_key?: string;
  env_value_preview?: string;
  status?: string;
  persistent?: boolean;
  details?: string;
};

export type RecognitionIssue = {
  code:
    | "no-scan"
    | "stale-scan"
    | "missing-provider"
    | "env-override"
    | "profile-mismatch"
    | "resource-not-running"
    | "missing-secret"
    | "embedded-ephemeral"
    | "embedded-sqlite"
    | "unlinked-existing"
    | "hosted-selected"
    | "unknown-need";
  severity: "info" | "warning" | "error";
  message: string;
  evidence?: string[];
  action_id?: string;
};

export type RecognitionAction = {
  id:
    | "rescan"
    | "link-existing"
    | "adopt-legacy"
    | "provision"
    | "use-hosted"
    | "use-local"
    | "ignore"
    | "promote-sqlite"
    | "fix-env"
    | "open-settings";
  label: string;
  kind:
    | "rescan"
    | "link-existing"
    | "adopt-legacy"
    | "provision"
    | "set-preference"
    | "promote-sqlite"
    | "fix-env"
    | "open-settings";
  profile?: ResourceProfileId;
  resource_id?: string;
  database_id?: string;
  preferred?: boolean;
  destructive?: boolean;
  disabled?: boolean;
};

export type RecognitionPreference = {
  mode: "auto" | "hosted" | "local" | "manual" | "ignore";
  note?: string;
  updated_at?: string;
};

export type DatabaseRecognition = {
  service_id: string;
  service_name: string;
  project_id: string | null;
  service_type: "process" | "docker" | "static";
  detected: {
    profile: ResourceProfileId;
    confidence: DetectionConfidence;
    signals: DetectionSignal[];
    env_requirements: FunctionSecretRequirement[];
    scan_id: string | null;
    scan_created_at: string | null;
    stale: boolean;
  };
  providers: RecognitionProvider[];
  current_provider: RecognitionProvider;
  state: RecognitionState;
  issues: RecognitionIssue[];
  actions: RecognitionAction[];
  preference: RecognitionPreference;
};

type ServiceRow = {
  id: string;
  project_id: string | null;
  name: string;
  type: "process" | "docker" | "static";
  working_dir: string | null;
  linked_database_id: string | null;
};

type EnvEntry = {
  key: string;
  value: string;
  source: "service-env" | "project-env";
  isSecret: boolean;
};

type RecognitionOptions = {
  embeddedByService?: Map<string, EmbeddedDatabase>;
};

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const PROFILE_PRIORITY: Record<string, number> = {
  supabase: 5,
  postgres: 4,
  mysql: 3,
  mongo: 3,
  redis: 2,
  manual: 0
};
const PREFERENCE_KIND = "database-recognition";
const SCAN_STALE_MS = 24 * 60 * 60 * 1000;

const NONE_PROVIDER: RecognitionProvider = {
  kind: "none",
  label: "No database provider recognized",
  profile: null,
  source: "none"
};

function pickRecommended(plans: ProvisionPlan[]): ProvisionPlan | null {
  if (plans.length === 0) return null;
  const supabase = plans.find((plan) => plan.profile === "supabase");
  if (supabase && CONFIDENCE_RANK[supabase.confidence] >= CONFIDENCE_RANK.medium) return supabase;
  return [...plans].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      (PROFILE_PRIORITY[b.profile] ?? 0) - (PROFILE_PRIORITY[a.profile] ?? 0)
  )[0];
}

function parseJson<T>(json: string | null | undefined, fallback: T): T {
  try {
    const parsed = JSON.parse(json || "null");
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function profileForEngine(engine: DatabaseRow["engine"]): ResourceProfileId {
  return engine;
}

function envKeyForProfile(profile: ResourceProfileId): string {
  return profile === "redis" ? "REDIS_URL" : "DATABASE_URL";
}

function engineForProfile(profile: ResourceProfileId): DatabaseRow["engine"] | null {
  if (profile === "postgres" || profile === "mysql" || profile === "mongo" || profile === "redis") {
    return profile;
  }
  return null;
}

function isLocalHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"].includes(
    hostname
  );
}

function urlIsHosted(value: string): boolean {
  try {
    const url = new URL(value);
    return !isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function previewValue(value: string, isSecret: boolean): string {
  if (isSecret) return maskSecret(value);
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    if (url.username && /key|token|secret/i.test(url.username)) url.username = "****";
    return url.toString();
  } catch {
    return maskSecret(value);
  }
}

function profileForEnv(key: string, value: string): ResourceProfileId | null {
  if (key === "REDIS_URL") return "redis";
  if (key === "SUPABASE_URL" || key === "VITE_SUPABASE_URL") return "supabase";
  if (key === "MYSQL_URL") return "mysql";
  if (key === "MONGO_URL" || key === "MONGODB_URI") return "mongo";
  if (key === "POSTGRES_URL" || key === "POSTGRESQL_URL") return "postgres";
  if (key !== "DATABASE_URL") return null;
  try {
    const protocol = new URL(value).protocol.replace(/:$/, "");
    if (protocol === "postgres" || protocol === "postgresql") return "postgres";
    if (protocol === "mysql" || protocol === "mysql2") return "mysql";
    if (protocol === "mongodb" || protocol === "mongodb+srv") return "mongo";
    if (protocol === "redis" || protocol === "rediss") return "redis";
  } catch {
    return "manual";
  }
  return "manual";
}

function providerMatches(provider: RecognitionProvider, profile: ResourceProfileId): boolean {
  if (profile === "manual") return provider.kind !== "none";
  return provider.profile === profile;
}

function severityRank(severity: RecognitionIssue["severity"]): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function hasIssue(issues: RecognitionIssue[], code: RecognitionIssue["code"]): boolean {
  return issues.some((issue) => issue.code === code);
}

function getServiceRow(ctx: AppContext, serviceId: string): ServiceRow {
  const service = ctx.db
    .prepare("SELECT id, project_id, name, type, working_dir, linked_database_id FROM services WHERE id = ?")
    .get(serviceId) as ServiceRow | undefined;
  if (!service) throw new Error("Service not found");
  return service;
}

function listServiceRows(ctx: AppContext, projectId?: string): ServiceRow[] {
  if (projectId) {
    return ctx.db
      .prepare(
        "SELECT id, project_id, name, type, working_dir, linked_database_id FROM services WHERE project_id = ? ORDER BY created_at DESC"
      )
      .all(projectId) as ServiceRow[];
  }
  return ctx.db
    .prepare(
      "SELECT id, project_id, name, type, working_dir, linked_database_id FROM services ORDER BY created_at DESC"
    )
    .all() as ServiceRow[];
}

function listEnvEntries(ctx: AppContext, service: ServiceRow): EnvEntry[] {
  const out: EnvEntry[] = [];
  if (service.project_id) {
    const projectRows = ctx.db
      .prepare("SELECT key, value, is_secret FROM project_env_vars WHERE project_id = ?")
      .all(service.project_id) as Array<{ key: string; value: string; is_secret: number }>;
    for (const row of projectRows) {
      out.push({
        key: row.key,
        value: row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value,
        source: "project-env",
        isSecret: Boolean(row.is_secret)
      });
    }
  }
  const serviceRows = ctx.db
    .prepare("SELECT key, value, is_secret FROM env_vars WHERE service_id = ?")
    .all(service.id) as Array<{ key: string; value: string; is_secret: number }>;
  for (const row of serviceRows) {
    out.push({
      key: row.key,
      value: row.is_secret ? decryptSecret(row.value, ctx.config.secretKey) : row.value,
      source: "service-env",
      isSecret: Boolean(row.is_secret)
    });
  }
  return out;
}

async function detectNeed(ctx: AppContext, service: ServiceRow): Promise<DatabaseRecognition["detected"]> {
  const workingDir = service.working_dir ?? "";
  const plans: ProvisionPlan[] = [];
  for (const profile of listProfiles()) {
    if (profile.id === "manual") continue;
    const signals = profile.detect(workingDir);
    if (signals.length === 0) continue;
    plans.push(await profile.plan(ctx, service.id));
  }
  const recommended = pickRecommended(plans);
  const latest = getLatestScan(ctx, service.id);
  const createdAt = latest?.created_at ?? null;
  const stale =
    !latest ||
    (createdAt ? Date.now() - new Date(createdAt).getTime() > SCAN_STALE_MS : true) ||
    latest.profile !== (recommended?.profile ?? "manual");

  return {
    profile: recommended?.profile ?? latest?.profile ?? "manual",
    confidence: recommended?.confidence ?? latest?.confidence ?? "low",
    signals: recommended?.signals ?? latest?.signals ?? [],
    env_requirements: scanFunctionSecrets(workingDir),
    scan_id: latest?.id ?? null,
    scan_created_at: createdAt,
    stale
  };
}

function resourceProvider(resource: ManagedResourceRow): RecognitionProvider {
  return {
    kind: "managed-resource",
    label: resource.name,
    profile: resource.profile as ResourceProfileId,
    source: "resource",
    resource_id: resource.id,
    status: resource.status,
    details: resource.profile
  };
}

function legacyProvider(db: DatabaseRow): RecognitionProvider {
  return {
    kind: "legacy-database",
    label: db.name,
    profile: profileForEngine(db.engine),
    source: "legacy",
    database_id: db.id,
    status: db.container_id ? "linked" : "recorded",
    details: `${db.engine} on port ${db.port}`
  };
}

function envProvider(entry: EnvEntry): RecognitionProvider | null {
  const profile = profileForEnv(entry.key, entry.value);
  if (!profile) return null;
  const hosted = urlIsHosted(entry.value);
  return {
    kind: hosted ? "hosted-env" : "manual-env",
    label: hosted ? "Hosted database env" : "Manual database env",
    profile,
    source: entry.source,
    env_key: entry.key,
    env_value_preview: previewValue(entry.value, entry.isSecret),
    details: entry.source === "service-env" ? "Service-level env" : "Project-level env"
  };
}

function embeddedProvider(embedded: EmbeddedDatabase): RecognitionProvider {
  return {
    kind: "embedded-sqlite",
    label: "Embedded SQLite",
    profile: "sqlite",
    source: "docker",
    persistent: embedded.persistent,
    status: embedded.persistent ? "persistent" : "ephemeral",
    details: embedded.file_path
  };
}

function currentProviderFor(
  detectedProfile: ResourceProfileId,
  providers: RecognitionProvider[],
  preference: RecognitionPreference
): RecognitionProvider {
  const matching = providers.filter((provider) => providerMatches(provider, detectedProfile));
  if (preference.mode === "hosted") {
    const hosted = matching.find((provider) => provider.kind === "hosted-env");
    if (hosted) return hosted;
  }
  const serviceEnv = matching.find((provider) => provider.source === "service-env");
  if (serviceEnv) return serviceEnv;
  const legacy = matching.find((provider) => provider.kind === "legacy-database");
  if (legacy) return legacy;
  const resource = matching.find((provider) => provider.kind === "managed-resource");
  if (resource) return resource;
  const projectEnv = matching.find((provider) => provider.source === "project-env");
  if (projectEnv) return projectEnv;
  const embedded = providers.find((provider) => provider.kind === "embedded-sqlite");
  return embedded ?? NONE_PROVIDER;
}

function unlinkedManagedResources(
  ctx: AppContext,
  service: ServiceRow,
  profile: ResourceProfileId
): ManagedResourceRow[] {
  if (!service.project_id || profile === "manual") return [];
  return ctx.db
    .prepare(
      `SELECT mr.* FROM managed_resources mr
       WHERE mr.project_id = ? AND mr.profile = ?
         AND NOT EXISTS (
           SELECT 1 FROM service_resource_links l
           WHERE l.resource_id = mr.id AND l.service_id = ? AND l.active = 1
         )
       ORDER BY mr.created_at DESC
       LIMIT 3`
    )
    .all(service.project_id, profile, service.id) as ManagedResourceRow[];
}

function unlinkedDatabases(ctx: AppContext, service: ServiceRow, profile: ResourceProfileId): DatabaseRow[] {
  const engine = engineForProfile(profile);
  if (!service.project_id || !engine) return [];
  return ctx.db
    .prepare(
      `SELECT * FROM databases
       WHERE project_id = ? AND engine = ? AND id != COALESCE(?, '')
       ORDER BY created_at DESC
       LIMIT 3`
    )
    .all(service.project_id, engine, service.linked_database_id) as DatabaseRow[];
}

function addSecretIssues(
  ctx: AppContext,
  current: RecognitionProvider,
  issues: RecognitionIssue[]
): void {
  if (current.kind !== "managed-resource" || current.profile !== "supabase" || !current.resource_id) return;
  const resource = getResource(ctx, current.resource_id);
  if (!resource) return;
  const config = resourceConfig(resource);
  const workdir = typeof config.workdir === "string" ? config.workdir : "";
  const states = classifySecretStates(ctx, resource, scanFunctionSecrets(workdir));
  const missingRequired = states.filter((state) => state.state === "missing-required");
  const missingOptional = states.filter((state) => state.state === "missing-optional");
  if (missingRequired.length > 0) {
    issues.push({
      code: "missing-secret",
      severity: "error",
      message: `${missingRequired.length} required Supabase function secret${missingRequired.length === 1 ? " is" : "s are"} missing.`,
      evidence: missingRequired.map((state) => state.key),
      action_id: "open-settings"
    });
  }
  if (missingOptional.length > 0) {
    issues.push({
      code: "missing-secret",
      severity: "warning",
      message: `${missingOptional.length} optional function secret${missingOptional.length === 1 ? " is" : "s are"} missing; affected functions run degraded.`,
      evidence: missingOptional.map((state) => state.key),
      action_id: "open-settings"
    });
  }
}

function buildActions(
  detectedProfile: ResourceProfileId,
  current: RecognitionProvider,
  providers: RecognitionProvider[],
  issues: RecognitionIssue[],
  service: ServiceRow,
  unlinkedResources: ManagedResourceRow[],
  unlinkedDbs: DatabaseRow[]
): RecognitionAction[] {
  const actions: RecognitionAction[] = [
    { id: "rescan", label: "Rescan repository", kind: "rescan" },
    { id: "open-settings", label: "Review service env", kind: "open-settings" }
  ];
  const hasNeed = detectedProfile !== "manual";
  if (hasNeed) {
    actions.push({
      id: "provision",
      label: `Provision ${detectedProfile === "supabase" ? "Local Supabase" : detectedProfile}`,
      kind: "provision",
      profile: detectedProfile,
      preferred: current.kind === "none"
    });
  }
  const hosted = providers.find((provider) => provider.kind === "hosted-env" && providerMatches(provider, detectedProfile));
  if (hosted) {
    actions.push({
      id: "use-hosted",
      label: "Use hosted/manual env",
      kind: "set-preference",
      preferred: current.kind === "hosted-env"
    });
  }
  if (providers.some((provider) => provider.kind === "managed-resource" && providerMatches(provider, detectedProfile))) {
    actions.push({ id: "use-local", label: "Prefer local managed resource", kind: "set-preference" });
  }
  for (const resource of unlinkedResources) {
    actions.push({
      id: "link-existing",
      label: `Link existing ${resource.name}`,
      kind: "link-existing",
      profile: resource.profile as ResourceProfileId,
      resource_id: resource.id,
      preferred: !hasIssue(issues, "env-override")
    });
  }
  if (current.kind === "legacy-database" && current.database_id) {
    actions.push({
      id: "adopt-legacy",
      label: `Adopt ${current.label} into managed resources`,
      kind: "adopt-legacy",
      profile: current.profile === "sqlite" ? undefined : (current.profile ?? undefined),
      database_id: current.database_id,
      preferred: true
    });
  }
  for (const db of unlinkedDbs) {
    actions.push({
      id: "adopt-legacy",
      label: `Adopt/link existing ${db.name}`,
      kind: "adopt-legacy",
      profile: profileForEngine(db.engine),
      database_id: db.id
    });
  }
  const embedded = providers.find((provider) => provider.kind === "embedded-sqlite");
  if (embedded) {
    actions.push({
      id: "promote-sqlite",
      label: "Promote SQLite to managed database",
      kind: "promote-sqlite",
      profile: "postgres",
      preferred: !embedded.persistent
    });
  }
  if (hasIssue(issues, "env-override")) {
    actions.push({ id: "fix-env", label: "Remove or update overriding service env", kind: "fix-env", preferred: true });
  }
  if (detectedProfile === "manual") {
    actions.push({ id: "ignore", label: "Mark database not needed", kind: "set-preference" });
  }
  void service;
  return actions;
}

function stateFrom(
  detectedProfile: ResourceProfileId,
  current: RecognitionProvider,
  issues: RecognitionIssue[],
  preference: RecognitionPreference
): RecognitionState {
  if (preference.mode === "ignore") return "unknown";
  if (current.kind === "embedded-sqlite") return "partial";
  if (detectedProfile === "manual") return current.kind === "none" ? "unknown" : "satisfied";
  if (current.kind === "none") return "missing";
  if (!providerMatches(current, detectedProfile)) return "conflict";
  if (issues.some((issue) => issue.severity === "error")) return "conflict";
  if (issues.some((issue) => issue.severity === "warning")) return "partial";
  return "satisfied";
}

export function getRecognitionPreference(ctx: AppContext, serviceId: string): RecognitionPreference {
  const row = ctx.db
    .prepare("SELECT value_json, updated_at FROM service_resource_preferences WHERE service_id = ? AND kind = ?")
    .get(serviceId, PREFERENCE_KIND) as { value_json: string; updated_at: string } | undefined;
  if (!row) return { mode: "auto" };
  const parsed = parseJson<RecognitionPreference>(row.value_json, { mode: "auto" });
  return { mode: parsed.mode ?? "auto", note: parsed.note, updated_at: row.updated_at };
}

export function setRecognitionPreference(
  ctx: AppContext,
  serviceId: string,
  preference: Pick<RecognitionPreference, "mode" | "note">
): RecognitionPreference {
  const service = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(serviceId);
  if (!service) throw new Error("Service not found");
  const now = nowIso();
  const value = JSON.stringify({ mode: preference.mode, note: preference.note });
  ctx.db
    .prepare(
      `INSERT INTO service_resource_preferences (service_id, kind, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(service_id, kind) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .run(serviceId, PREFERENCE_KIND, value, now);
  return { mode: preference.mode, note: preference.note, updated_at: now };
}

export async function recognizeService(
  ctx: AppContext,
  serviceOrId: ServiceRow | string,
  opts: RecognitionOptions = {}
): Promise<DatabaseRecognition> {
  const service = typeof serviceOrId === "string" ? getServiceRow(ctx, serviceOrId) : serviceOrId;
  const detected = await detectNeed(ctx, service);
  const preference = getRecognitionPreference(ctx, service.id);
  const providers: RecognitionProvider[] = [];
  const envEntries = listEnvEntries(ctx, service);

  for (const entry of envEntries) {
    const provider = envProvider(entry);
    if (provider) providers.push(provider);
  }

  for (const link of listLinksForService(ctx, service.id)) {
    const resource = getResource(ctx, link.resource_id);
    if (resource) providers.push(resourceProvider(resource));
  }

  if (service.linked_database_id) {
    const db = getDatabase(ctx, service.linked_database_id);
    if (db) providers.push(legacyProvider(db));
  }

  const embedded = opts.embeddedByService?.get(service.id);
  if (embedded) providers.push(embeddedProvider(embedded));

  if (providers.length === 0) providers.push(NONE_PROVIDER);

  const current = currentProviderFor(detected.profile, providers, preference);
  const issues: RecognitionIssue[] = [];

  if (!detected.scan_id) {
    issues.push({
      code: "no-scan",
      severity: detected.signals.length > 0 ? "info" : "warning",
      message:
        detected.signals.length > 0
          ? "Recognition used a live scan; no saved dependency scan exists yet."
          : "No saved dependency scan exists yet.",
      action_id: "rescan"
    });
  } else if (detected.stale) {
    issues.push({
      code: "stale-scan",
      severity: "info",
      message: "The saved dependency scan may be stale; rescan before making destructive changes.",
      evidence: detected.scan_created_at ? [`Last scan: ${detected.scan_created_at}`] : undefined,
      action_id: "rescan"
    });
  }

  if (detected.profile === "manual" && detected.signals.length === 0) {
    issues.push({
      code: "unknown-need",
      severity: "info",
      message: "No database dependency was detected from the repository signals.",
      action_id: "rescan"
    });
  }

  const localMatchingProvider = providers.find(
    (provider) =>
      providerMatches(provider, detected.profile) &&
      (provider.kind === "managed-resource" || provider.kind === "legacy-database")
  );
  const serviceEnvProvider = providers.find(
    (provider) =>
      providerMatches(provider, detected.profile) &&
      provider.source === "service-env" &&
      (provider.kind === "hosted-env" || provider.kind === "manual-env")
  );
  if (localMatchingProvider && serviceEnvProvider) {
    const severity = preference.mode === "hosted" ? "info" : "error";
    issues.push({
      code: preference.mode === "hosted" ? "hosted-selected" : "env-override",
      severity,
      message:
        preference.mode === "hosted"
          ? "Hosted/manual service env is selected and will override local injected values."
          : "Service-level env overrides the linked local provider, so the service may not use the local database.",
      evidence: [serviceEnvProvider.env_key ?? "service env", localMatchingProvider.label],
      action_id: severity === "error" ? "fix-env" : "use-local"
    });
  }

  const mismatched = providers.find(
    (provider) =>
      provider.kind !== "none" &&
      provider.kind !== "embedded-sqlite" &&
      detected.profile !== "manual" &&
      !providerMatches(provider, detected.profile) &&
      (provider.kind === "managed-resource" || provider.kind === "legacy-database")
  );
  if (mismatched) {
    issues.push({
      code: "profile-mismatch",
      severity: "error",
      message: `Repository signals point to ${detected.profile}, but ${mismatched.label} is ${mismatched.profile}.`,
      evidence: [mismatched.details ?? mismatched.label],
      action_id: "provision"
    });
  }

  if (
    current.kind === "managed-resource" &&
    current.status &&
    ["stopped", "degraded", "failed", "error"].includes(current.status)
  ) {
    issues.push({
      code: "resource-not-running",
      severity: current.status === "stopped" ? "warning" : "error",
      message: `Linked resource is ${current.status}.`,
      evidence: [current.label],
      action_id: "open-settings"
    });
  }

  addSecretIssues(ctx, current, issues);

  if (current.kind === "embedded-sqlite") {
    issues.push({
      code: current.persistent ? "embedded-sqlite" : "embedded-ephemeral",
      severity: current.persistent ? "info" : "warning",
      message: current.persistent
        ? "Embedded SQLite is volume-backed, but it is still managed by the service rather than ServerHoster."
        : "Embedded SQLite is not volume-backed and can be lost when the container is recreated.",
      evidence: current.details ? [current.details] : undefined,
      action_id: "promote-sqlite"
    });
  }

  const unlinkedResources = unlinkedManagedResources(ctx, service, detected.profile);
  const unlinkedDbs = unlinkedDatabases(ctx, service, detected.profile);
  if (detected.profile !== "manual" && current.kind === "none" && (unlinkedResources.length || unlinkedDbs.length)) {
    issues.push({
      code: "unlinked-existing",
      severity: "warning",
      message: "A matching existing database/resource is available but not linked to this service.",
      evidence: [
        ...unlinkedResources.map((resource) => resource.name),
        ...unlinkedDbs.map((db) => db.name)
      ],
      action_id: unlinkedResources.length ? "link-existing" : "adopt-legacy"
    });
  }

  if (detected.profile !== "manual" && current.kind === "none" && !hasIssue(issues, "unlinked-existing")) {
    issues.push({
      code: "missing-provider",
      severity: "warning",
      message: `No ${detected.profile} provider is linked or configured for this service.`,
      action_id: "provision"
    });
  }

  const actions = buildActions(
    detected.profile,
    current,
    providers,
    issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    service,
    unlinkedResources,
    unlinkedDbs
  );

  return {
    service_id: service.id,
    service_name: service.name,
    project_id: service.project_id,
    service_type: service.type,
    detected,
    providers,
    current_provider: current,
    state: stateFrom(detected.profile, current, issues, preference),
    issues,
    actions,
    preference
  };
}

export async function listRecognitions(
  ctx: AppContext,
  opts: { projectId?: string } = {}
): Promise<DatabaseRecognition[]> {
  const embedded = await listEmbeddedDatabases(ctx, { includeLinkedServices: true }).catch(() => []);
  const embeddedByService = new Map(embedded.map((row) => [row.service_id, row]));
  const services = listServiceRows(ctx, opts.projectId);
  return Promise.all(services.map((service) => recognizeService(ctx, service, { embeddedByService })));
}

export async function runRecognitionScan(ctx: AppContext, serviceId: string): Promise<DatabaseRecognition> {
  await runDependencyScan(ctx, serviceId);
  return recognizeService(ctx, serviceId);
}

function findResourceForDatabase(ctx: AppContext, databaseId: string): ManagedResourceRow | null {
  const rows = ctx.db.prepare("SELECT * FROM managed_resources ORDER BY created_at DESC").all() as ManagedResourceRow[];
  for (const row of rows) {
    const config = resourceConfig(row);
    if (config.database_id === databaseId) return row;
  }
  return null;
}

export async function adoptDatabaseAsResource(
  ctx: AppContext,
  input: { databaseId: string; serviceId?: string; name?: string }
): Promise<ManagedResourceRow> {
  const db = getDatabase(ctx, input.databaseId);
  if (!db) throw new Error("Database not found");
  const profile = profileForEngine(db.engine);
  let resource = findResourceForDatabase(ctx, db.id);
  if (!resource) {
    resource = createResource(ctx, {
      projectId: db.project_id,
      name: input.name ?? db.name,
      profile,
      status: "ready",
      config: { database_id: db.id, adopted: true },
      ports: { [db.engine]: db.port },
      containers: [containerNameForDatabase(db)]
    });
    setResourceSecret(ctx, resource.id, envKeyForProfile(profile), buildConnectionString(db), true);
  }

  if (input.serviceId) {
    const service = ctx.db.prepare("SELECT id FROM services WHERE id = ?").get(input.serviceId);
    if (!service) throw new Error("Service not found");
    linkResourceToService(ctx, { serviceId: input.serviceId, resourceId: resource.id });
    ctx.db
      .prepare("UPDATE services SET linked_database_id = ?, updated_at = ? WHERE id = ?")
      .run(db.id, nowIso(), input.serviceId);
  }
  return resource;
}
