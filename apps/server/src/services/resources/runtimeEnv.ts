import type { AppContext } from "../../types.js";
import { getResource, listLinksForService } from "./lifecycle.js";
import { envFromResourceConfig, getProfile } from "./profiles.js";

/**
 * Resource-provided env for a service (Database-Tracker Phase 1).
 *
 * Reads the service's ACTIVE service_resource_links in link-creation order and
 * merges each linked resource's env (later links win on key conflicts):
 *
 *   1. profile.env() when the resource's profile is registered, otherwise the
 *      env map stored in the resource's config_json.env;
 *   2. the link's env_map_json overrides on top (per-link remapping).
 *
 * Synchronous on purpose: this feeds getServiceEnvWithLinks, which is the one
 * shared (sync) env merge used by both deploy and runtime. Precedence with the
 * other layers lives in runtime.ts, not here.
 */
export function getResourceEnvForService(ctx: AppContext, serviceId: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const link of listLinksForService(ctx, serviceId)) {
    const resource = getResource(ctx, link.resource_id);
    if (!resource) continue;

    const profile = getProfile(resource.profile);
    const baseEnv = profile ? profile.env(ctx, resource.id, serviceId) : envFromResourceConfig(resource);
    Object.assign(merged, baseEnv);

    try {
      const envMap = JSON.parse(link.env_map_json || "{}") as Record<string, unknown>;
      for (const [key, value] of Object.entries(envMap)) {
        if (typeof value === "string") merged[key] = value;
      }
    } catch {
      // Corrupt env_map_json: skip the per-link overrides, keep profile env.
    }
  }
  return merged;
}
