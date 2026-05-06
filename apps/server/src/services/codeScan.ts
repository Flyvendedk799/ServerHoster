import fs from "node:fs";
import path from "node:path";

/**
 * Lightweight static scan of a service's source directory for known database
 * driver / ORM dependencies. Used to pre-flag services that will probably
 * want a managed database — even before they've been started.
 *
 * Scope: walk the working directory up to MAX_DEPTH levels deep (skipping
 * heavy/irrelevant dirs), read recognised manifest files, return a deduped
 * list of detected drivers with the file they were found in.
 */

export type DbCodeSignal = {
  /** Human-readable label, e.g. "PostgreSQL" or "Prisma". */
  driver: string;
  /** Ecosystem the manifest belongs to: node, python, go, ruby, rust. */
  ecosystem: "node" | "python" | "go" | "ruby" | "rust";
  /** Manifest path relative to the working directory. */
  source_file: string;
};

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
  ".vscode"
]);

type EcosystemDef = {
  ecosystem: DbCodeSignal["ecosystem"];
  filenames: string[];
  /** package_name → human label */
  drivers: Record<string, string>;
};

const ECOSYSTEMS: EcosystemDef[] = [
  {
    ecosystem: "node",
    filenames: ["package.json"],
    drivers: {
      pg: "PostgreSQL",
      postgres: "PostgreSQL",
      "@prisma/client": "Prisma",
      prisma: "Prisma",
      mysql: "MySQL",
      mysql2: "MySQL",
      mongodb: "MongoDB",
      mongoose: "MongoDB",
      sqlite3: "SQLite",
      "better-sqlite3": "SQLite",
      sequelize: "Sequelize ORM",
      typeorm: "TypeORM",
      "drizzle-orm": "Drizzle ORM",
      knex: "Knex",
      redis: "Redis",
      ioredis: "Redis"
    }
  },
  {
    ecosystem: "python",
    filenames: ["requirements.txt", "pyproject.toml", "Pipfile"],
    drivers: {
      psycopg2: "PostgreSQL",
      "psycopg2-binary": "PostgreSQL",
      psycopg: "PostgreSQL",
      asyncpg: "PostgreSQL",
      sqlalchemy: "SQLAlchemy",
      alembic: "Alembic migrations",
      django: "Django ORM",
      pymysql: "MySQL",
      mysqlclient: "MySQL",
      pymongo: "MongoDB",
      motor: "MongoDB",
      redis: "Redis",
      rq: "Redis (RQ)",
      peewee: "Peewee ORM",
      "tortoise-orm": "Tortoise ORM"
    }
  },
  {
    ecosystem: "go",
    filenames: ["go.mod"],
    drivers: {
      "lib/pq": "PostgreSQL",
      "jackc/pgx": "PostgreSQL",
      "gorm.io/gorm": "GORM",
      "go-sql-driver/mysql": "MySQL",
      "go.mongodb.org/mongo-driver": "MongoDB",
      "go-redis/redis": "Redis"
    }
  },
  {
    ecosystem: "ruby",
    filenames: ["Gemfile"],
    drivers: {
      pg: "PostgreSQL",
      mysql2: "MySQL",
      mongoid: "MongoDB",
      redis: "Redis",
      activerecord: "ActiveRecord ORM"
    }
  },
  {
    ecosystem: "rust",
    filenames: ["Cargo.toml"],
    drivers: {
      sqlx: "SQLx",
      diesel: "Diesel ORM",
      "tokio-postgres": "PostgreSQL",
      postgres: "PostgreSQL",
      mysql_async: "MySQL",
      mongodb: "MongoDB",
      redis: "Redis"
    }
  }
];

function checkNodeManifest(content: string, drivers: Record<string, string>): string[] {
  // Parse package.json strictly — substring matching gives too many false positives.
  let parsed: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const declared = new Set([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {})
  ]);
  const out = new Set<string>();
  for (const [pkg, label] of Object.entries(drivers)) {
    if (declared.has(pkg)) out.add(label);
  }
  return Array.from(out);
}

function checkLineManifest(content: string, drivers: Record<string, string>): string[] {
  // requirements.txt / Pipfile / Gemfile / go.mod / Cargo.toml — line-based.
  // For each line, normalise to a candidate package name and look it up.
  const out = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split(/[#;]/)[0].trim(); // strip comments
    if (!line) continue;
    for (const [pkg, label] of Object.entries(drivers)) {
      if (matchesPkgInLine(line, pkg)) out.add(label);
    }
  }
  return Array.from(out);
}

function matchesPkgInLine(line: string, pkg: string): boolean {
  // Robust enough across requirements.txt (`pkg==x`, `pkg>=x`), Gemfile
  // (`gem "pkg"`), go.mod (`github.com/lib/pq v1.x`), Cargo.toml (`pkg = "x"`).
  if (line === pkg) return true;
  // Require a word boundary on both sides so "pg" doesn't match "fastapi-pg".
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-zA-Z0-9_/-])${escaped}([^a-zA-Z0-9_]|$)`);
  return re.test(line);
}

function scanFile(filePath: string, sourceRel: string, def: EcosystemDef): DbCodeSignal[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const labels =
    def.filenames[0] === "package.json" && filePath.endsWith("package.json")
      ? checkNodeManifest(content, def.drivers)
      : checkLineManifest(content, def.drivers);
  return labels.map((label) => ({ driver: label, ecosystem: def.ecosystem, source_file: sourceRel }));
}

/**
 * Walk a directory up to MAX_DEPTH levels deep, scanning any manifest files
 * we recognise. Returns a deduped list of (driver, ecosystem, source_file).
 */
export function scanForDatabaseDrivers(workingDir: string): DbCodeSignal[] {
  if (!workingDir || !fs.existsSync(workingDir)) return [];
  const seen = new Set<string>();
  const out: DbCodeSignal[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      for (const def of ECOSYSTEMS) {
        if (!def.filenames.includes(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        const rel = path.relative(workingDir, filePath) || entry.name;
        for (const signal of scanFile(filePath, rel, def)) {
          const key = `${signal.ecosystem}:${signal.driver}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(signal);
        }
      }
    }
  };

  walk(workingDir, 0);
  return out;
}
