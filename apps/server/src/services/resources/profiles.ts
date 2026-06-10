import type { AppContext } from "../../types.js";
import {
  createResource,
  deleteResource,
  getResource,
  resourceConfig,
  type ManagedResourceRow,
  type ResourceProfileId,
  type ResourceStatus
} from "./lifecycle.js";

export type { ResourceProfileId, ResourceStatus } from "./lifecycle.js";

/**
 * Resource profile registry (Database-Tracker Phase 1).
 *
 * A profile describes how to detect, plan, provision, healthcheck, env-inject,
 * and remove one kind of local dependency. Rich profiles (postgres, supabase,
 * redis, …) register themselves here in later phases via `registerProfile`;
 * the runtime env merge (`runtimeEnv.ts`) and future routes only ever talk to
 * the registry, never to a concrete profile module.
 */

export type DetectionSignal = {
  kind: "package" | "file" | "env" | "migration" | "function" | "code";
  value: string;
  source_file: string;
  confidence: "high" | "medium" | "low";
};

export type ProvisionPlan = {
  profile: ResourceProfileId;
  service_id: string;
  project_id: string | null;
  confidence: "high" | "medium" | "low";
  signals: DetectionSignal[];
  actions: Array<{
    id: string;
    label: string;
    risk: "safe" | "destructive" | "external";
    default_enabled: boolean;
  }>;
  env: {
    generated: string[];
    required_user_input: string[];
    optional_user_input: string[];
    injected: string[];
  };
};

export type ProvisionInput = {
  serviceId: string;
  projectId?: string | null;
  name?: string;
  mode?: "schema-only" | "schema-and-seed" | "empty";
  restart?: boolean;
  secrets?: Record<string, string>;
  disabledSecrets?: string[];
  /**
   * Serve Edge Functions after provisioning (plan action "serve-functions").
   * Defaults to true when supabase/functions exists; explicit false skips it.
   */
  serveFunctions?: boolean;
  /** Profile-specific extra configuration (stored in config_json). */
  config?: Record<string, unknown>;
};

export type ResourceProfile = {
  id: ResourceProfileId;
  label: string;
  detect(servicePath: string): DetectionSignal[];
  plan(ctx: AppContext, serviceId: string): Promise<ProvisionPlan>;
  provision(ctx: AppContext, input: ProvisionInput): Promise<ManagedResourceRow>;
  status(ctx: AppContext, resourceId: string): Promise<ResourceStatus>;
  /**
   * Env vars this resource injects into a linked service. Synchronous by
   * design: the effective-env merge (`getServiceEnvWithLinks`) is synchronous
   * and shared by deploy + runtime, so profiles must resolve env from local
   * state (config_json / resource_secrets), not from network calls.
   */
  env(ctx: AppContext, resourceId: string, serviceId: string): Record<string, string>;
  remove(ctx: AppContext, resourceId: string): Promise<void>;
};

const registry = new Map<ResourceProfileId, ResourceProfile>();

export function registerProfile(profile: ResourceProfile): void {
  registry.set(profile.id, profile);
}

export function getProfile(id: string): ResourceProfile | null {
  return registry.get(id as ResourceProfileId) ?? null;
}

export function listProfiles(): ResourceProfile[] {
  return Array.from(registry.values());
}

/** Env map stored in a resource's config_json under the `env` key. */
export function envFromResourceConfig(resource: ManagedResourceRow): Record<string, string> {
  const config = resourceConfig(resource);
  const env = config.env;
  if (!env || typeof env !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * `manual` profile — operator-defined resource with a static env map stored in
 * config_json.env. Detects nothing; provisioning just records the resource.
 * Doubles as the reference implementation for the profile contract.
 */
const manualProfile: ResourceProfile = {
  id: "manual",
  label: "Manual resource",
  detect() {
    return [];
  },
  async plan(_ctx, serviceId): Promise<ProvisionPlan> {
    return {
      profile: "manual",
      service_id: serviceId,
      project_id: null,
      confidence: "low",
      signals: [],
      actions: [
        {
          id: "create-manual-resource",
          label: "Create manual resource",
          risk: "safe",
          default_enabled: true
        }
      ],
      env: { generated: [], required_user_input: [], optional_user_input: [], injected: [] }
    };
  },
  async provision(ctx, input): Promise<ManagedResourceRow> {
    return createResource(ctx, {
      projectId: input.projectId ?? null,
      name: input.name ?? "manual-resource",
      profile: "manual",
      status: "running",
      config: input.config ?? {}
    });
  },
  async status(ctx, resourceId): Promise<ResourceStatus> {
    const resource = getResource(ctx, resourceId);
    return (resource?.status as ResourceStatus | undefined) ?? "error";
  },
  env(ctx, resourceId): Record<string, string> {
    const resource = getResource(ctx, resourceId);
    return resource ? envFromResourceConfig(resource) : {};
  },
  async remove(ctx, resourceId): Promise<void> {
    deleteResource(ctx, resourceId);
  }
};

registerProfile(manualProfile);
