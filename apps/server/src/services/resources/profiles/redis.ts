import { registerProfile } from "../profiles.js";
import { buildManagedDbProfile } from "./managedDb.js";

/**
 * Redis profile (Database-Tracker — legacy-database-backed, see managedDb.ts).
 *
 * Detection wraps the existing manifest driver scan: redis/ioredis (node),
 * redis/rq (python), go-redis, redis gems, and rust redis all surface as Redis
 * labels. Provisioning creates an authenticated redis:7 container, records a
 * managed resource, links it to the service, and injects REDIS_URL.
 *
 * Port window 63790-63890: clear of Redis' default 6379 and every other
 * managed window (postgres 54320-54420, mysql 33306-33406, mongo 47017-47117).
 */
export const redisProfile = buildManagedDbProfile({
  id: "redis",
  label: "Redis",
  engine: "redis",
  drivers: { Redis: "high", "Redis (RQ)": "high" },
  portRange: [63790, 63890],
  envKey: "REDIS_URL"
});

registerProfile(redisProfile);
