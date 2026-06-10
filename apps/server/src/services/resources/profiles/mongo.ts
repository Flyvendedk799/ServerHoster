import { registerProfile } from "../profiles.js";
import { buildManagedDbProfile } from "./managedDb.js";

/**
 * MongoDB profile (Database-Tracker — legacy-database-backed, see managedDb.ts;
 * profiles/postgres.ts is the original template).
 *
 * Detection wraps the existing manifest driver scan: mongodb/mongoose (node),
 * pymongo/motor (python), go.mongodb.org/mongo-driver (go), mongoid (ruby) and
 * mongodb (rust) all surface as the "MongoDB" driver label.
 *
 * Port window 47017–47117: clear of the MongoDB default (27017) and every
 * other managed window (postgres 54320–54420, mysql 33306–33406).
 */
export const mongoProfile = buildManagedDbProfile({
  id: "mongo",
  label: "MongoDB",
  engine: "mongo",
  drivers: { MongoDB: "high" },
  portRange: [47017, 47117]
});

registerProfile(mongoProfile);
