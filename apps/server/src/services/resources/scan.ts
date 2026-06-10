import { nanoid } from "nanoid";
import { nowIso } from "../../lib/core.js";
import type { AppContext } from "../../types.js";
import {
  listProfiles,
  type DetectionSignal,
  type ProvisionPlan,
  type ResourceProfileId
} from "./profiles.js";
import { scanFunctionSecrets, type FunctionSecretRequirement } from "./secretsScan.js";

// Side-effect imports: rich profiles register themselves on load so every
// scan (and the runtime env merge) sees the full registry.
import "./profiles/supabase.js";
import "./profiles/postgres.js";
import "./profiles/mysql.js";
import "./profiles/mongo.js";
import "./profiles/redis.js";

/**
 * Dependency scan orchestrator (Database-Tracker Phase 2).
 *
 * Runs every registered profile's detect() against a service's working dir,
 * builds a ProvisionPlan per matching profile, picks the recommended profile,
 * and persists a snapshot row into `dependency_scans` so the UI can render
 * dependency-aware cards without re-walking the filesystem.
 */

type DependencyScanDbRow = {
  id: string;
  service_id: string;
  profile: string;
  confidence: string;
  signals_json: string;
  env_requirements_json: string;
  created_at: string;
};

export type DependencyScanRecord = {
  id: string;
  service_id: string;
  /** Recommended profile; "manual" when nothing was detected. */
  profile: ResourceProfileId;
  confidence: "high" | "medium" | "low";
  signals: DetectionSignal[];
  env_requirements: FunctionSecretRequirement[];
  created_at: string;
};

export type DependencyScanRunResult = {
  scan: DependencyScanRecord;
  /** One plan per profile that produced detection signals. */
  plans: ProvisionPlan[];
  /** The plan backing the persisted recommendation (null when nothing matched). */
  recommended: ProvisionPlan | null;
};

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * Tie-break priority between profiles at equal confidence. Supabase outranks
 * plain Postgres so a Supabase app (which often also carries pg/Prisma deps)
 * is never labeled postgres-only.
 */
const PROFILE_PRIORITY: Record<string, number> = {
  supabase: 5,
  postgres: 4,
  mysql: 3,
  mongo: 3,
  redis: 2,
  manual: 0
};

function pickRecommended(plans: ProvisionPlan[]): ProvisionPlan | null {
  if (plans.length === 0) return null;
  // Hard rule from the spec: a medium/high Supabase hit always wins — the app
  // talks to Supabase, plain Postgres would be a misleading recommendation.
  const supabase = plans.find((plan) => plan.profile === "supabase");
  if (supabase && CONFIDENCE_RANK[supabase.confidence] >= CONFIDENCE_RANK.medium) return supabase;
  return [...plans].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      (PROFILE_PRIORITY[b.profile] ?? 0) - (PROFILE_PRIORITY[a.profile] ?? 0)
  )[0];
}

function parseScanRow(row: DependencyScanDbRow): DependencyScanRecord {
  const parse = <T>(json: string, fallback: T): T => {
    try {
      const parsed = JSON.parse(json || "null");
      return (parsed as T) ?? fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    service_id: row.service_id,
    profile: row.profile as ResourceProfileId,
    confidence: row.confidence as DependencyScanRecord["confidence"],
    signals: parse<DetectionSignal[]>(row.signals_json, []),
    env_requirements: parse<FunctionSecretRequirement[]>(row.env_requirements_json, []),
    created_at: row.created_at
  };
}

/**
 * Detect dependencies for one service, persist the snapshot, and return the
 * full result (plans included) for immediate rendering.
 */
export async function runDependencyScan(
  ctx: AppContext,
  serviceId: string
): Promise<DependencyScanRunResult> {
  const service = ctx.db.prepare("SELECT id, working_dir FROM services WHERE id = ?").get(serviceId) as
    | { id: string; working_dir: string | null }
    | undefined;
  if (!service) throw new Error("Service not found");
  const workingDir = service.working_dir ?? "";

  const plans: ProvisionPlan[] = [];
  for (const profile of listProfiles()) {
    if (profile.id === "manual") continue;
    const signals = profile.detect(workingDir);
    if (signals.length === 0) continue;
    plans.push(await profile.plan(ctx, serviceId));
  }

  const recommended = pickRecommended(plans);
  const envRequirements = scanFunctionSecrets(workingDir);

  const record: DependencyScanRecord = {
    id: nanoid(),
    service_id: serviceId,
    // Unknown apps fall back to "manual" so the operator picks a profile.
    profile: recommended?.profile ?? "manual",
    confidence: recommended?.confidence ?? "low",
    signals: recommended?.signals ?? [],
    env_requirements: envRequirements,
    created_at: nowIso()
  };

  ctx.db
    .prepare(
      `INSERT INTO dependency_scans
       (id, service_id, profile, confidence, signals_json, env_requirements_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.service_id,
      record.profile,
      record.confidence,
      JSON.stringify(record.signals),
      JSON.stringify(record.env_requirements),
      record.created_at
    );

  return { scan: record, plans, recommended };
}

/** Latest persisted scan snapshot for a service, or null if never scanned. */
export function getLatestScan(ctx: AppContext, serviceId: string): DependencyScanRecord | null {
  const row = ctx.db
    .prepare(
      "SELECT * FROM dependency_scans WHERE service_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(serviceId) as DependencyScanDbRow | undefined;
  return row ? parseScanRow(row) : null;
}

/** Latest scan snapshot per service (insert-only table, so max rowid = latest). */
export function listLatestScans(ctx: AppContext): DependencyScanRecord[] {
  const rows = ctx.db
    .prepare(
      `SELECT ds.* FROM dependency_scans ds
       JOIN (SELECT service_id, MAX(rowid) AS max_rowid FROM dependency_scans GROUP BY service_id) latest
         ON ds.rowid = latest.max_rowid
       ORDER BY ds.created_at DESC, ds.rowid DESC`
    )
    .all() as DependencyScanDbRow[];
  return rows.map(parseScanRow);
}
