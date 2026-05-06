import { nowIso } from "../lib/core.js";
import type { AppContext } from "../types.js";

/**
 * Sequence 2 — canonical deployment state machine.
 *
 * The deployments table historically tracked a free-form `status` string.
 * That made it hard to reason about whether a deploy was finished, in flight,
 * or had been rolled back. This module introduces a closed set of states and
 * a strict transition table; every other module (`services/deploy.ts`,
 * `routes/deployments.ts`, the WebSocket broadcast layer) routes its writes
 * through `transition()` so the resulting state is always one we expect.
 *
 * The state machine intentionally stays close to existing semantics:
 *
 *   queued    → cloning → building → starting → healthy
 *                                              ↘ failed
 *   * → rolled_back  (operator-driven rollback path)
 *
 * Any unexpected transition is logged at WARN level and accepted, so a buggy
 * caller can't strand a deployment in an unknown state. The "failed" state
 * carries a `failure_stage` field so post-mortem tooling can tell whether a
 * deploy died during clone, build, or start.
 */

export type DeployState =
  | "queued"
  | "cloning"
  | "building"
  | "starting"
  | "healthy"
  | "failed"
  | "rolled_back";

export type DeployStateRow = {
  id: string;
  service_id: string;
  status: string;
  failure_stage?: string | null;
};

const ALL_STATES: ReadonlyArray<DeployState> = [
  "queued",
  "cloning",
  "building",
  "starting",
  "healthy",
  "failed",
  "rolled_back"
];

/**
 * Allowed forward transitions. Terminal states (healthy, failed,
 * rolled_back) only accept transitions to rolled_back, which is how
 * operator-driven rollbacks are recorded.
 */
const TRANSITIONS: Readonly<Record<DeployState, ReadonlyArray<DeployState>>> = {
  queued: ["cloning", "failed", "rolled_back"],
  cloning: ["building", "failed", "rolled_back"],
  building: ["starting", "failed", "rolled_back"],
  starting: ["healthy", "failed", "rolled_back"],
  healthy: ["rolled_back"],
  failed: ["rolled_back"],
  rolled_back: []
};

export function isValidState(value: string): value is DeployState {
  return (ALL_STATES as ReadonlyArray<string>).includes(value);
}

export function isTerminal(state: DeployState): boolean {
  return state === "healthy" || state === "failed" || state === "rolled_back";
}

export function canTransition(from: DeployState, to: DeployState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Persist a state transition for a single deployment. Records the new
 * status, optional `failure_stage`, and recomputes `duration_ms` whenever
 * the deploy reaches a terminal state.
 *
 * Returns the resulting state. If the requested transition isn't legal, the
 * machine still applies it but logs a WARN — defensiveness over rigidity:
 * we never want to lose an event because the table was incomplete.
 */
export function transition(
  ctx: AppContext,
  deploymentId: string,
  to: DeployState,
  options: { failureStage?: string | null; gitSha?: string | null } = {}
): DeployState {
  const current = ctx.db
    .prepare("SELECT id, service_id, status, failure_stage, started_at FROM deployments WHERE id = ?")
    .get(deploymentId) as
    | {
        id: string;
        service_id: string;
        status: string;
        failure_stage: string | null;
        started_at: string | null;
      }
    | undefined;
  if (!current) {
    ctx.app?.log?.warn?.({ deploymentId, to }, "deployStateMachine: unknown deployment");
    return to;
  }
  const from = isValidState(current.status) ? current.status : "queued";
  if (from !== to && !canTransition(from, to)) {
    ctx.app?.log?.warn?.({ deploymentId, from, to }, "deployStateMachine: applying out-of-order transition");
  }

  const now = nowIso();
  const finishedAt = isTerminal(to) ? now : null;
  const durationMs =
    finishedAt && current.started_at ? Date.parse(finishedAt) - Date.parse(current.started_at) : null;

  const failureStage = to === "failed" ? (options.failureStage ?? current.failure_stage ?? "unknown") : null;

  ctx.db
    .prepare(
      `UPDATE deployments
       SET status = ?,
           failure_stage = ?,
           git_sha = COALESCE(?, git_sha),
           duration_ms = COALESCE(?, duration_ms),
           finished_at = COALESCE(?, finished_at)
       WHERE id = ?`
    )
    .run(to, failureStage, options.gitSha ?? null, durationMs, finishedAt, deploymentId);

  return to;
}

/**
 * Convenience helper for callers that already know the failure stage and
 * want to mark a deployment failed in one call.
 */
export function markFailed(
  ctx: AppContext,
  deploymentId: string,
  stage: "queued" | "cloning" | "building" | "starting" | "unknown"
): void {
  transition(ctx, deploymentId, "failed", { failureStage: stage });
}
