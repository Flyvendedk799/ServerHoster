import { registerProfile } from "../profiles.js";
import { buildManagedDbProfile } from "./managedDb.js";

/**
 * MySQL profile (Database-Tracker — legacy-database-backed, see managedDb.ts;
 * profiles/postgres.ts is the original template).
 *
 * Detection wraps the existing manifest driver scan: mysql/mysql2 (node),
 * pymysql/mysqlclient (python), go-sql-driver/mysql (go), mysql2 (ruby) and
 * mysql_async (rust) all surface as the "MySQL" driver label. Multi-DB ORMs
 * (Sequelize/TypeORM/Knex) are NOT claimed — they could target any engine.
 *
 * Port window 33306–33406: clear of the MySQL default (3306), the X-protocol
 * default (33060), and the postgres/Supabase window (54320–54420).
 */
export const mysqlProfile = buildManagedDbProfile({
  id: "mysql",
  label: "MySQL",
  engine: "mysql",
  drivers: { MySQL: "high" },
  portRange: [33306, 33406]
});

registerProfile(mysqlProfile);
