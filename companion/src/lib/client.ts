import type { PairedServer } from "./vault";
import { invalidateServer } from "./vault";

/**
 * HTTP to a paired machine.
 *
 * Two assumptions shape this file, and both come from where the app runs: a
 * phone, on a train, on a connection that stalls rather than fails. So every
 * request carries a hard timeout (a stalled fetch is indistinguishable from a
 * hung server, and neither should freeze a screen), and a 401 is treated as
 * "this pairing is gone" rather than "retry" — the machine has no other reason
 * to reject a device token.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class OfflineError extends Error {
  constructor(message = "Can't reach this server") {
    super(message);
    this.name = "OfflineError";
  }
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function request<T>(
  server: PairedServer,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${server.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${server.url}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
  } catch {
    // Abort, DNS failure, TLS failure, CORS rejection — from here they are all
    // the same actionable thing: this phone cannot currently reach that box.
    throw new OfflineError(
      controller.signal.aborted ? "Timed out reaching this server" : "Can't reach this server"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; code?: string };
      message = parsed.error ?? parsed.message ?? message;
      code = parsed.code;
    } catch {
      /* non-JSON error body */
    }
    if (response.status === 401) {
      invalidateServer(server.id);
      throw new ApiError("This phone is no longer paired with that server", 401, code);
    }
    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Typed views over the control plane's responses -------------------------

export type ServiceSummary = {
  id: string;
  name: string;
  status: string;
  type: string;
  port: number | null;
  projectId: string | null;
  projectName: string | null;
};

export type DeploymentSummary = {
  id: string;
  serviceId: string;
  serviceName: string | null;
  status: string;
  commitHash: string | null;
  createdAt: string;
};

export type NotificationSummary = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  serviceId: string | null;
  read: number;
  createdAt: string;
};

export type Summary = {
  server: { name: string; platform: string; uptimeSeconds: number };
  system: {
    totalMemory: number;
    freeMemory: number;
    memoryUsedPercent: number;
    loadAvg: number[];
    cpus: number;
  };
  services: ServiceSummary[];
  counts: { total: number; running: number; stopped: number; error: number; building: number };
  deployments: DeploymentSummary[];
  notifications: NotificationSummary[];
  unreadNotifications: number;
  generatedAt: string;
};

export function fetchSummary(server: PairedServer, signal?: AbortSignal): Promise<Summary> {
  return request<Summary>(server, "/companion/summary", { signal });
}

export type ServiceAction = "start" | "stop" | "restart" | "redeploy";

export function serviceAction(
  server: PairedServer,
  serviceId: string,
  action: ServiceAction
): Promise<unknown> {
  // Redeploy pulls and rebuilds; it can legitimately take minutes, so it gets a
  // longer leash than the default. The control plane answers as soon as the
  // deploy is *queued*, but a cold Docker build can still stall the response.
  return request(server, `/services/${serviceId}/${action}`, {
    method: "POST",
    timeoutMs: action === "redeploy" ? 60_000 : DEFAULT_TIMEOUT_MS
  });
}

/** Raw `logs` row as the control plane returns it — snake_case and all. */
export type ServiceLogLine = {
  id: string;
  service_id: string;
  level: string;
  message: string;
  timestamp: string;
};

export function fetchServiceLogs(
  server: PairedServer,
  serviceId: string,
  signal?: AbortSignal
): Promise<ServiceLogLine[]> {
  return request<ServiceLogLine[]>(server, `/services/${serviceId}/logs`, { signal });
}

export function markNotificationRead(server: PairedServer, id: string): Promise<unknown> {
  return request(server, `/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead(server: PairedServer): Promise<unknown> {
  return request(server, "/notifications/read-all", { method: "POST" });
}

export function unpairSelf(server: PairedServer): Promise<unknown> {
  return request(server, "/companion/unpair", { method: "POST" });
}
