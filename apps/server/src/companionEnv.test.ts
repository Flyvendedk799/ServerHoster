/**
 * Regression test for companion-service env inheritance (getInheritedServiceEnv).
 *
 * A repo with several root Dockerfiles auto-creates a companion service per
 * unclaimed Dockerfile (e.g. a worker). Instead of a one-time snapshot copy,
 * the companion carries an `env_from_service_id` link to its primary tier and
 * inherits that tier's CURRENT env at deploy time — so a rotated secret flows
 * through, and only the companion inherits (no leak to unrelated tiers).
 *
 * Uses node:sqlite (built in) so it needs no native build.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";

import { getInheritedServiceEnv } from "./services/runtime.js";
import { encryptSecret } from "./security.js";
import type { AppContext } from "./types.js";

const SECRET = "test-secret-key-32-bytes-not-for-prod";

const SCHEMA = `
CREATE TABLE services (
  id TEXT PRIMARY KEY, project_id TEXT, name TEXT, dockerfile TEXT, env_from_service_id TEXT
);
CREATE TABLE env_vars (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0
);
`;

let db: DatabaseSync;
let ctx: AppContext;

function makeCtx(): AppContext {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return { db, config: { secretKey: SECRET } } as unknown as AppContext;
}

function addService(id: string, envFrom: string | null = null): void {
  db.prepare(
    "INSERT INTO services (id, project_id, name, dockerfile, env_from_service_id) VALUES (?, 'proj', ?, 'Dockerfile', ?)"
  ).run(id, id, envFrom);
}

function addEnv(serviceId: string, key: string, value: string, secret = 0): void {
  db.prepare(
    "INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)"
  ).run(`${serviceId}:${key}`, serviceId, key, secret ? encryptSecret(value, SECRET) : value, secret);
}

beforeEach(() => {
  ctx = makeCtx();
});

describe("getInheritedServiceEnv", () => {
  test("a service with no link inherits nothing", () => {
    addService("backend");
    addEnv("backend", "REDIS_URL", "redis://x");
    addService("worker");
    assert.deepEqual(getInheritedServiceEnv(ctx, "worker"), {});
  });

  test("inherits the linked tier's env, decrypting secrets", () => {
    addService("backend");
    addEnv("backend", "REDIS_URL", "redis://host.docker.internal:6379/0");
    addEnv("backend", "DATABASE_URL", "postgres://u:p@h/db", 1); // stored encrypted
    addService("worker", "backend");

    const inherited = getInheritedServiceEnv(ctx, "worker");
    assert.equal(inherited.REDIS_URL, "redis://host.docker.internal:6379/0");
    assert.equal(inherited.DATABASE_URL, "postgres://u:p@h/db", "secret is decrypted");
  });

  test("continuous sync: reads the primary's CURRENT value, not a snapshot", () => {
    addService("backend");
    addEnv("backend", "OPENAI_API_KEY", "sgk_old");
    addService("worker", "backend");
    assert.equal(getInheritedServiceEnv(ctx, "worker").OPENAI_API_KEY, "sgk_old");

    // Rotate the secret on the primary — the companion should see the new value.
    db.prepare("UPDATE env_vars SET value = 'sgk_new' WHERE service_id = 'backend' AND key = 'OPENAI_API_KEY'").run();
    assert.equal(
      getInheritedServiceEnv(ctx, "worker").OPENAI_API_KEY,
      "sgk_new",
      "no stale snapshot — the rotated value flows through"
    );
  });

  test("a self-link yields nothing (no infinite/degenerate inheritance)", () => {
    addService("backend", "backend");
    addEnv("backend", "REDIS_URL", "redis://x");
    assert.deepEqual(getInheritedServiceEnv(ctx, "backend"), {});
  });
});
