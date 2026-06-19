import { api } from "./api";
import type {
  BootstrapPlanResponse,
  BootstrapRequest,
  BootstrapResult,
  AdoptDatabaseRequest,
  AdoptDatabaseResponse,
  DatabaseRecognition,
  DatabaseRecognitionPreferenceRequest,
  DependencyScan,
  DependencyScanRunResult,
  EnvRequirementsResponse,
  ManagedResourceDetail,
  ProvisionRequest,
  ResourceActionResponse,
  ResourceLinkResponse,
  ResourceLogsResponse,
  ResourceProfileSummary,
  ResourceRemoveResponse,
  ResourceSecretsUpdateRequest,
  ResourceSecretsUpdateResponse
} from "../../../../packages/shared/src/types";

// Re-export the shared resource types so pages/components have one import
// point (`lib/resources`) instead of each reaching into packages/shared.
export type {
  BootstrapOperationPreview,
  BootstrapPlanInfo,
  BootstrapPlanResponse,
  BootstrapRequest,
  BootstrapResult,
  AdoptDatabaseRequest,
  AdoptDatabaseResponse,
  DatabaseRecognition,
  DatabaseRecognitionPreference,
  DatabaseRecognitionPreferenceRequest,
  DependencyScan,
  DependencyScanRunResult,
  DetectionConfidence,
  DetectionSignal,
  EdgeFunctionStatus,
  EnvRequirementsResponse,
  FunctionSecretRequirement,
  FunctionSecretState,
  ManagedResourceDetail,
  ProvisionMode,
  ProvisionPlan,
  ProvisionRequest,
  RecognitionAction,
  RecognitionIssue,
  RecognitionProvider,
  RecognitionProviderKind,
  RecognitionState,
  ResourceProfileId,
  ResourceProfileSummary,
  ResourceProvisioningEvent,
  ResourceSecretPreview,
  ResourceSecretState,
  ResourceStatus,
  ResourceStatusEvent,
  ServiceResourceLink
} from "../../../../packages/shared/src/types";

type ApiOpts = { silent?: boolean };

// ---- Typed fetchers for the /resources API ---------------------------------

export function listResourceProfiles(opts?: ApiOpts): Promise<ResourceProfileSummary[]> {
  return api<ResourceProfileSummary[]>("/resources/profiles", opts);
}

/** Latest persisted dependency scan per service. */
export function listResourceScans(opts?: ApiOpts): Promise<DependencyScan[]> {
  return api<DependencyScan[]>("/resources/scans", opts);
}

export function getResourceScan(serviceId: string, opts?: ApiOpts): Promise<DependencyScan> {
  return api<DependencyScan>(`/resources/scans/${serviceId}`, opts);
}

export function runResourceScan(serviceId: string, opts?: ApiOpts): Promise<DependencyScanRunResult> {
  return api<DependencyScanRunResult>(`/resources/scans/${serviceId}/run`, { method: "POST", ...opts });
}

export function listResourceRecognitions(
  opts?: ApiOpts & { projectId?: string }
): Promise<DatabaseRecognition[]> {
  const query = opts?.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : "";
  return api<DatabaseRecognition[]>(`/resources/recognition${query}`, { silent: opts?.silent });
}

export function getResourceRecognition(
  serviceId: string,
  opts?: ApiOpts
): Promise<DatabaseRecognition> {
  return api<DatabaseRecognition>(`/resources/recognition/${serviceId}`, opts);
}

export function runResourceRecognition(
  serviceId: string,
  opts?: ApiOpts
): Promise<DatabaseRecognition> {
  return api<DatabaseRecognition>(`/resources/recognition/${serviceId}/run`, { method: "POST", ...opts });
}

export function setResourceRecognitionPreference(
  serviceId: string,
  body: DatabaseRecognitionPreferenceRequest
): Promise<DatabaseRecognition> {
  return api<DatabaseRecognition>(`/resources/recognition/${serviceId}/preference`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function adoptDatabase(body: AdoptDatabaseRequest): Promise<AdoptDatabaseResponse> {
  return api<AdoptDatabaseResponse>("/resources/adopt-database", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

/** Awaited; progress streams over the websocket as resource_provisioning events. */
export function provisionResource(body: ProvisionRequest): Promise<ManagedResourceDetail> {
  return api<ManagedResourceDetail>("/resources/provision", {
    method: "POST",
    body: JSON.stringify(body),
    silent: true
  });
}

export function listResources(opts?: ApiOpts): Promise<ManagedResourceDetail[]> {
  return api<ManagedResourceDetail[]>("/resources", opts);
}

export function getResourceDetail(id: string, opts?: ApiOpts): Promise<ManagedResourceDetail> {
  return api<ManagedResourceDetail>(`/resources/${id}`, opts);
}

export function resourceAction(
  id: string,
  action: "start" | "stop" | "restart"
): Promise<ResourceActionResponse> {
  return api<ResourceActionResponse>(`/resources/${id}/${action}`, { method: "POST" });
}

export function removeResource(id: string): Promise<ResourceRemoveResponse> {
  return api<ResourceRemoveResponse>(`/resources/${id}`, { method: "DELETE" });
}

export function getResourceLogs(
  id: string,
  source: "containers" | "functions" | "all" = "all",
  opts?: ApiOpts
): Promise<ResourceLogsResponse> {
  return api<ResourceLogsResponse>(`/resources/${id}/logs?source=${source}`, opts);
}

export function getResourceEnvRequirements(id: string, opts?: ApiOpts): Promise<EnvRequirementsResponse> {
  return api<EnvRequirementsResponse>(`/resources/${id}/env-requirements`, opts);
}

export function updateResourceSecrets(
  id: string,
  body: ResourceSecretsUpdateRequest
): Promise<ResourceSecretsUpdateResponse> {
  return api<ResourceSecretsUpdateResponse>(`/resources/${id}/secrets`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function linkResource(
  id: string,
  serviceId: string,
  envMap?: Record<string, string>
): Promise<ResourceLinkResponse> {
  return api<ResourceLinkResponse>(`/resources/${id}/link`, {
    method: "POST",
    body: JSON.stringify({ serviceId, envMap })
  });
}

export function unlinkResource(id: string, serviceId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/resources/${id}/unlink`, {
    method: "POST",
    body: JSON.stringify({ serviceId })
  });
}

export function getBootstrapPlan(id: string, opts?: ApiOpts): Promise<BootstrapPlanResponse> {
  return api<BootstrapPlanResponse>(`/resources/${id}/bootstrap/plan`, opts);
}

export function runBootstrap(id: string, body: BootstrapRequest): Promise<BootstrapResult> {
  return api<BootstrapResult>(`/resources/${id}/bootstrap`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// ---- View helpers -----------------------------------------------------------

/** Stringy config reads — config is a redacted Record<string, unknown>. */
export function resourceConfigString(
  resource: Pick<ManagedResourceDetail, "config">,
  key: string
): string | null {
  const value = resource.config?.[key];
  return typeof value === "string" && value ? value : null;
}

/** True when the URL points at a non-local host. */
export function isNonLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"].includes(url.hostname);
  } catch {
    return false;
  }
}
