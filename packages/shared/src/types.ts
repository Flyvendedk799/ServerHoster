export type ServiceType = "process" | "docker" | "static";
export type ServiceStatus = "stopped" | "running" | "crashed" | "building";
export type DatabaseEngine = "postgres" | "mysql" | "redis" | "mongo";

export interface Project {
  id: string;
  name: string;
  description?: string;
  gitUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  projectId: string;
  name: string;
  type: ServiceType;
  command?: string;
  workingDir?: string;
  dockerImage?: string;
  dockerfile?: string;
  port?: number;
  status: ServiceStatus;
  autoRestart: number;
  restartCount: number;
  maxRestarts: number;
  createdAt: string;
  updatedAt: string;
  tunnelUrl?: string | null;
  quickTunnelEnabled?: number;
}

export interface LogEntry {
  id: string;
  serviceId: string;
  level: "info" | "error" | "warn";
  message: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Generic resource layer (Database-Tracker) — managed local dependencies
// (Postgres, Supabase stacks, Redis, …) provisioned through resource profiles.
// Field names mirror the control-plane rows / profile contract (snake_case).
// ---------------------------------------------------------------------------

export type ResourceProfileId = "postgres" | "supabase" | "redis" | "mysql" | "mongo" | "manual";

export type ResourceStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "stopped"
  | "degraded"
  | "failed"
  | "error";

export type DetectionConfidence = "high" | "medium" | "low";

export interface DetectionSignal {
  kind: "package" | "file" | "env" | "migration" | "function" | "code";
  value: string;
  source_file: string;
  confidence: DetectionConfidence;
}

export interface ProvisionPlanAction {
  id: string;
  label: string;
  risk: "safe" | "destructive" | "external";
  default_enabled: boolean;
}

export interface ProvisionPlan {
  profile: ResourceProfileId;
  service_id: string;
  project_id: string | null;
  confidence: DetectionConfidence;
  signals: DetectionSignal[];
  actions: ProvisionPlanAction[];
  env: {
    generated: string[];
    required_user_input: string[];
    optional_user_input: string[];
    injected: string[];
  };
}

export interface ManagedResource {
  id: string;
  project_id: string | null;
  name: string;
  profile: ResourceProfileId;
  status: ResourceStatus;
  config: Record<string, unknown>;
  ports: Record<string, number>;
  containers: string[];
  created_at: string;
  updated_at: string;
}

/** Secret values are stored encrypted; APIs only ever expose this preview shape. */
export interface ResourceSecretPreview {
  key: string;
  is_generated: boolean;
  value_preview: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceResourceLink {
  id: string;
  service_id: string;
  resource_id: string;
  active: boolean;
  env_map: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** Classification of env keys read by Supabase Edge Functions (Deno.env.get etc.). */
export type FunctionSecretClassification =
  | "auto-generated"
  | "optional-external"
  | "infrastructure"
  | "unknown";

export interface FunctionSecretRequirement {
  key: string;
  classification: FunctionSecretClassification;
  /** Files (relative to the service dir) referencing the key. */
  source_files: string[];
}

/**
 * Spec "Local Function Secrets" UI states for a function env key:
 * generated (ServerHoster created it), provided (user pasted it),
 * missing-optional (feature may fail locally), disabled (user disabled it
 * locally), missing-required (function can't serve until resolved).
 */
export type ResourceSecretState =
  | "generated"
  | "provided"
  | "missing-optional"
  | "disabled"
  | "missing-required";

/** A scanned function env key with its resolved UI state for one resource. */
export interface FunctionSecretState extends FunctionSecretRequirement {
  state: ResourceSecretState;
}

/** Per-function serve status (Phase 4). */
export interface EdgeFunctionStatus {
  name: string;
  /** Function directory, relative to the service working dir. */
  path: string;
  /**
   * serving  — process up, all referenced secrets resolved;
   * degraded — serving but one or more referenced secrets are missing;
   * disabled — serving is off, or a referenced secret was disabled locally.
   */
  status: "serving" | "degraded" | "disabled";
  /** Keys still missing (empty when disabled — operator intent). */
  missing_secrets: string[];
  secrets: FunctionSecretState[];
}

/** GET /resources/:id/env-requirements response. */
export interface EnvRequirementsResponse {
  resource_id: string;
  /** Whether the `supabase functions serve` process is currently running. */
  serving: boolean;
  functions: EdgeFunctionStatus[];
  /** Aggregate key list across every function (deduped, sorted). */
  aggregate: FunctionSecretState[];
}

/** POST /resources/:id/secrets body. */
export interface ResourceSecretsUpdateRequest {
  /** Upsert user-provided secrets (stored encrypted, is_generated=false). */
  secrets?: Record<string, string>;
  /** Keys to disable locally (added to config_json.disabled_secrets). */
  disable?: string[];
  /** Keys to re-enable. */
  enable?: string[];
}

/** POST /resources/:id/secrets response — previews + states, never raw values. */
export interface ResourceSecretsUpdateResponse {
  ok: true;
  secrets: ResourceSecretPreview[];
  requirements: EnvRequirementsResponse;
}

/** config_json.functions — serve-process identity recorded on the resource. */
export interface ResourceFunctionsState {
  enabled: boolean;
  pid?: number;
  started_at?: string;
  env_file?: string;
  functions?: string[];
  /** Why serving is off/degraded (set on serve failures). */
  error?: string;
}

export interface DependencyScan {
  id: string;
  service_id: string;
  /** Recommended profile; "manual" when nothing was detected. */
  profile: ResourceProfileId;
  confidence: DetectionConfidence;
  signals: DetectionSignal[];
  env_requirements: FunctionSecretRequirement[];
  created_at: string;
}

/** GET /resources/profiles entry. */
export interface ResourceProfileSummary {
  id: ResourceProfileId;
  label: string;
}

/** POST /resources/scans/:serviceId/run response. */
export interface DependencyScanRunResult {
  scan: DependencyScan;
  /** One plan per profile that produced detection signals. */
  plans: ProvisionPlan[];
  /** The plan backing the persisted recommendation (null when nothing matched). */
  recommended: ProvisionPlan | null;
}

// ---- Database/resource recognition ----------------------------------------

export type RecognitionState = "satisfied" | "missing" | "partial" | "conflict" | "unknown";

export type RecognitionProviderKind =
  | "managed-resource"
  | "legacy-database"
  | "hosted-env"
  | "manual-env"
  | "embedded-sqlite"
  | "data-dir"
  | "none";

export interface RecognitionProvider {
  kind: RecognitionProviderKind;
  label: string;
  profile: ResourceProfileId | "sqlite" | null;
  source: "resource" | "legacy" | "service-env" | "project-env" | "runtime" | "docker" | "none";
  resource_id?: string;
  database_id?: string;
  env_key?: string;
  env_value_preview?: string;
  status?: string;
  persistent?: boolean;
  details?: string;
}

export interface RecognitionIssue {
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
}

export interface RecognitionAction {
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
}

export interface DatabaseRecognitionPreference {
  mode: "auto" | "hosted" | "local" | "manual" | "ignore";
  note?: string;
  updated_at?: string;
}

export interface DatabaseRecognition {
  service_id: string;
  service_name: string;
  project_id: string | null;
  service_type: ServiceType;
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
  preference: DatabaseRecognitionPreference;
}

export interface DatabaseRecognitionPreferenceRequest {
  mode: DatabaseRecognitionPreference["mode"];
  note?: string;
}

export interface AdoptDatabaseRequest {
  databaseId: string;
  serviceId?: string;
  name?: string;
}

export interface AdoptDatabaseResponse {
  ok: true;
  resource: ManagedResourceDetail;
  recognition?: DatabaseRecognition;
}

/**
 * GET /resources and GET /resources/:id shape. Raw secret values never appear:
 * `secrets` is preview-only and env values inside `config`/`env_map` are masked.
 */
export interface ManagedResourceDetail extends ManagedResource {
  secrets: ResourceSecretPreview[];
  links: ServiceResourceLink[];
}

/** Migration/data mode for resource provisioning. Never imports hosted data. */
export type ProvisionMode = "schema-only" | "schema-and-seed" | "empty";

/** POST /resources/provision body. */
export interface ProvisionRequest {
  serviceId: string;
  profile: ResourceProfileId;
  /** Defaults to "schema-only"; seeds run ONLY on "schema-and-seed". */
  mode?: ProvisionMode;
  /** Restart/redeploy the service after provisioning (default true). */
  restart?: boolean;
  /** Resource display name (defaults to a service-derived name). */
  name?: string;
  /** Operator-provided secrets, stored encrypted with is_generated=false. */
  secrets?: Record<string, string>;
  /** Keys the operator disabled locally (config_json.disabled_secrets). */
  disabledSecrets?: string[];
  /**
   * Serve Edge Functions after provisioning (plan action "serve-functions").
   * Defaults to true when supabase/functions exists; explicit false skips it.
   */
  serveFunctions?: boolean;
  /** Profile-specific extras (e.g. supabase { init: true }). */
  config?: Record<string, unknown>;
}

/** POST /resources/:id/start|stop|restart response. */
export interface ResourceActionResponse {
  ok: true;
  resource: ManagedResourceDetail;
}

/** DELETE /resources/:id response — mirrors /databases removal semantics. */
export interface ResourceRemoveResponse {
  ok: true;
  /** Actively linked services whose injected env now dangles (warned, not blocked). */
  strandedServices: number;
}

/**
 * GET /resources/:id/logs response. Docker logs of containers_json entries
 * plus a `=== functions ===` section with captured `supabase functions serve`
 * output; `?source=containers|functions|all` (default all) narrows the view.
 */
export interface ResourceLogsResponse {
  logs: string;
}

/** POST /resources/:id/link body. */
export interface ResourceLinkRequest {
  serviceId: string;
  /** Per-link env overrides applied on top of the profile's env(). */
  envMap?: Record<string, string>;
}

export interface ResourceLinkResponse {
  ok: true;
  link: ServiceResourceLink;
}

/** POST /resources/:id/unlink body. */
export interface ResourceUnlinkRequest {
  serviceId: string;
}

/** WS event: resource status transition (provisioning → ready/failed, …). */
export interface ResourceStatusEvent {
  type: "resource_status";
  resourceId: string;
  status: ResourceStatus | "removed";
  profile: ResourceProfileId;
}

/** WS event: granular provisioning progress (preflight/start/migrate/…). */
export interface ResourceProvisioningEvent {
  type: "resource_provisioning";
  resourceId: string;
  step: string;
  message: string;
}

// ---- First user / admin / org bootstrap (Database-Tracker Phase 5) ----------

/** POST /resources/:id/bootstrap body. */
export interface BootstrapRequest {
  email: string;
  password: string;
  fullName?: string;
  /** One of the detected role enum values (BootstrapPlanInfo.roles). */
  role?: string;
  makePlatformAdmin?: boolean;
  organization?: {
    create: boolean;
    name: string;
    slug: string;
  };
}

/** A role-ish Postgres enum detected in the local database. */
export interface BootstrapRoleEnum {
  schema: string;
  name: string;
  values: string[];
}

export interface BootstrapColumnInfo {
  name: string;
  data_type: string;
  udt_name: string;
}

/** Shape of a bootstrap-relevant table in the local database. */
export interface BootstrapTableInfo {
  name: string;
  columns: BootstrapColumnInfo[];
  /** Columns with a FOREIGN KEY to auth.users. */
  auth_user_fk_columns: string[];
  /** Column typed with one of the detected role enums, when present. */
  role_column: { name: string; enum_name: string } | null;
}

/** Live introspection of the local Supabase database (Bootstrap Scanner). */
export interface BootstrapSchemaInfo {
  /** public.app_role plus any public enum named like %role%, with values. */
  role_enums: BootstrapRoleEnum[];
  /** Values of the primary role enum (public.app_role preferred). */
  roles: string[];
  auth: {
    has_profiles: boolean;
    /** Column shape of public.profiles when present. */
    profiles: BootstrapTableInfo | null;
    profiles_references_auth_users: boolean;
    /** Trigger on auth.users whose function inserts into public.profiles. */
    profile_trigger: string | null;
    /** All non-internal triggers on auth.users. */
    auth_user_triggers: string[];
  };
  admin: {
    platform_admins: BootstrapTableInfo | null;
    admins: BootstrapTableInfo | null;
    user_roles: BootstrapTableInfo | null;
  };
  org: {
    organizations: BootstrapTableInfo | null;
    memberships: BootstrapTableInfo | null;
    /** Trigger on public.organizations whose function inserts memberships. */
    owner_trigger: string | null;
  };
}

export type BootstrapOperationStep =
  | "create-user"
  | "profile-via-trigger"
  | "insert-profile"
  | "insert-platform-admin"
  | "insert-organization"
  | "membership-via-trigger"
  | "insert-membership";

/** One entry of the ordered operations preview shown before execution. */
export interface BootstrapOperationPreview {
  step: BootstrapOperationStep;
  detail: string;
  /** Set on plans built without a request: the wizard may toggle this step. */
  optional?: boolean;
}

/** Wizard-facing bootstrap plan derived from BootstrapSchemaInfo. */
export interface BootstrapPlanInfo {
  roles: string[];
  has_platform_admins: boolean;
  has_profiles: boolean;
  profile_trigger: string | null;
  org_support: {
    organizations: boolean;
    memberships: boolean;
    owner_trigger: string | null;
  };
  operations: BootstrapOperationPreview[];
  warnings: string[];
}

/** GET /resources/:id/bootstrap/plan response. */
export interface BootstrapPlanResponse {
  resource_id: string;
  resource_name: string;
  /** Always the LOCAL stack URL (bootstrap never targets hosted Supabase). */
  api_url: string;
  schema: BootstrapSchemaInfo;
  plan: BootstrapPlanInfo;
}

/** POST /resources/:id/bootstrap response. Never carries the password. */
export interface BootstrapResult {
  user_id: string;
  /** True when the email already existed and the existing user was promoted. */
  user_existed: boolean;
  /** How the profile row came to be: auth trigger, explicit insert, or none. */
  profile: "trigger" | "created" | "none";
  platform_admin: boolean;
  organization: { id: string; slug: string; created: boolean } | null;
  membership: {
    organization_id: string;
    role: string | null;
    status: string | null;
    via_trigger: boolean;
  } | null;
  warnings: string[];
}
