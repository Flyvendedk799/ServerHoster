import type { AppContext } from "../../../types.js";
import { scanForDatabaseDrivers } from "../../codeScan.js";
import { getResource } from "../lifecycle.js";
import {
  envFromResourceConfig,
  registerProfile,
  type DetectionSignal,
  type ProvisionPlan,
  type ResourceProfile,
  type ResourceStatus
} from "../profiles.js";

/**
 * Thin Redis profile (Database-Tracker Phase 2).
 *
 * Detection wraps the existing manifest driver scan (redis/ioredis et al.) so
 * dependency scans can recommend Redis. Provisioning stays on the existing
 * /databases flow until Phase 3 moves it behind this profile.
 */

function detectRedisSignals(servicePath: string): DetectionSignal[] {
  return scanForDatabaseDrivers(servicePath)
    .filter((signal) => signal.driver === "Redis" || signal.driver.startsWith("Redis "))
    .map((signal) => ({
      kind: "package" as const,
      value: signal.driver,
      source_file: signal.source_file,
      confidence: "high" as const
    }));
}

export const redisProfile: ResourceProfile = {
  id: "redis",
  label: "Redis",
  detect(servicePath: string): DetectionSignal[] {
    return detectRedisSignals(servicePath);
  },
  async plan(ctx: AppContext, serviceId): Promise<ProvisionPlan> {
    const service = ctx.db
      .prepare("SELECT id, project_id, working_dir FROM services WHERE id = ?")
      .get(serviceId) as { id: string; project_id: string | null; working_dir: string | null } | undefined;
    if (!service) throw new Error("Service not found");
    const signals = detectRedisSignals(service.working_dir ?? "");
    return {
      profile: "redis",
      service_id: serviceId,
      project_id: service.project_id,
      confidence: signals.length > 0 ? "high" : "low",
      signals,
      actions: [
        {
          id: "create-redis",
          label: "Create managed Redis and inject REDIS_URL",
          risk: "safe",
          default_enabled: true
        }
      ],
      env: { generated: ["REDIS_URL"], required_user_input: [], optional_user_input: [], injected: [] }
    };
  },
  async provision(): Promise<never> {
    throw new Error(
      "Redis provisioning through the resource layer is not implemented in this phase — use the existing /databases flow (Phase 3 wires this profile)"
    );
  },
  async status(ctx, resourceId): Promise<ResourceStatus> {
    const resource = getResource(ctx, resourceId);
    return (resource?.status as ResourceStatus | undefined) ?? "error";
  },
  env(ctx, resourceId): Record<string, string> {
    const resource = getResource(ctx, resourceId);
    return resource ? envFromResourceConfig(resource) : {};
  },
  async remove(): Promise<never> {
    throw new Error(
      "Redis resource removal is not implemented in this phase — use the existing /databases flow (Phase 3 wires this profile)"
    );
  }
};

registerProfile(redisProfile);
