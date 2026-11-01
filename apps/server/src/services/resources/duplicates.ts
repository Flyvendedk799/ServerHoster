import { nowIso } from "../../lib/core.js";
import type { AppContext } from "../../types.js";
import { isFunctionsServing } from "./functions.js";
import { resourceConfig, type ManagedResourceRow, type ServiceResourceLinkRow } from "./lifecycle.js";

/**
 * One physical stack recorded as several managed_resources rows.
 *
 * Re-provisioning a service could create a second row for a stack that already
 * had one: same profile, same checkout (workdir), same host ports, same database.
 * Awaire carried two "Awaire-supabase" rows (created 2026-07-23 and 2026-08-10)
 * for one stack. Deploy-time migrations saw "two started stacks", refused to
 * guess, and silently skipped every migration for weeks.
 *
 * Rows describing the same stack are not ambiguous — there is only one database
 * to migrate. This module recognises them (`stackIdentity`), collapses them for
 * readers, and merges the records on request or at boot. Merging is pure
 * bookkeeping: links, secrets and missing config move to the kept row and the
 * duplicate row is deleted. No container, volume, process or file is touched —
 * the profile's remove() is never called, since for a duplicate it would stop
 * (and possibly wipe) the very stack the kept row describes.
 */

function normaliseWorkdir(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\\/g, "/");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function canonicalPorts(portsJson: string): string {
  try {
    const parsed = JSON.parse(portsJson || "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const entries = Object.entries(parsed)
      .filter(([, port]) => typeof port === "number" && Number.isFinite(port))
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? JSON.stringify(entries) : "";
  } catch {
    return "";
  }
}

/**
 * Identity of the physical stack a row describes, or null when the row does not
 * say enough to prove sameness (no workdir, or neither ports nor a db_url).
 * Two rows with the same identity are the same stack.
 */
export function stackIdentity(resource: ManagedResourceRow): string | null {
  const config = resourceConfig(resource);
  const workdir = normaliseWorkdir(config.workdir);
  if (!workdir) return null;
  const ports = canonicalPorts(resource.ports_json);
  const dbUrl = typeof config.db_url === "string" ? config.db_url.trim() : "";
  if (!ports && !dbUrl) return null;
  return JSON.stringify([resource.profile, workdir, ports, dbUrl]);
}

/** How much live state a record carries; the busiest record survives a merge. */
function liveness(resource: ManagedResourceRow): number {
  const functions = resourceConfig(resource).functions as { enabled?: unknown } | undefined;
  return (
    (isFunctionsServing(resource.id) ? 4 : 0) +
    (functions?.enabled === true ? 2 : 0) +
    (resource.status === "running" || resource.status === "ready" ? 1 : 0)
  );
}

/**
 * Order rows best-keeper first: the record whose functions are being served (an
 * in-memory process keyed by its id), then one with functions enabled, then a
 * started one, then the most recently updated, then the oldest.
 */
export function rankKeepers(rows: ManagedResourceRow[]): ManagedResourceRow[] {
  return [...rows].sort(
    (a, b) =>
      liveness(b) - liveness(a) ||
      b.updated_at.localeCompare(a.updated_at) ||
      a.created_at.localeCompare(b.created_at)
  );
}

export type DuplicateGroup = {
  identity: string;
  keep: ManagedResourceRow;
  duplicates: ManagedResourceRow[];
};

/** Groups of rows describing one stack (only groups with 2+ rows). */
export function groupDuplicates(rows: ManagedResourceRow[]): DuplicateGroup[] {
  const byIdentity = new Map<string, ManagedResourceRow[]>();
  for (const row of rows) {
    const identity = stackIdentity(row);
    if (!identity) continue;
    const list = byIdentity.get(identity) ?? [];
    list.push(row);
    byIdentity.set(identity, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [identity, list] of byIdentity) {
    if (list.length < 2) continue;
    const [keep, ...duplicates] = rankKeepers(list);
    groups.push({ identity, keep: keep!, duplicates });
  }
  return groups;
}

export function findDuplicateResourceGroups(ctx: AppContext): DuplicateGroup[] {
  const rows = ctx.db
    .prepare("SELECT * FROM managed_resources ORDER BY created_at")
    .all() as ManagedResourceRow[];
  return groupDuplicates(rows);
}

/** Config keys never carried over from a duplicate: stale per-row state. */
const NON_MERGED_CONFIG_KEYS = new Set(["error", "merged_duplicates"]);

/**
 * Fold `duplicate` into `keep` and delete the duplicate row. DB only, one
 * transaction. Links are repointed (or folded into an existing link to the kept
 * row, keeping it active if either was), secrets the kept row lacks move over,
 * and config keys the kept row lacks are filled in.
 */
function mergeInto(ctx: AppContext, keepId: string, duplicateId: string): void {
  ctx.db.transaction(() => {
    const keep = ctx.db.prepare("SELECT * FROM managed_resources WHERE id = ?").get(keepId) as
      | ManagedResourceRow
      | undefined;
    const dup = ctx.db.prepare("SELECT * FROM managed_resources WHERE id = ?").get(duplicateId) as
      | ManagedResourceRow
      | undefined;
    if (!keep || !dup) return;
    const now = nowIso();

    const keepConfig = resourceConfig(keep);
    const merged: Record<string, unknown> = { ...keepConfig };
    for (const [key, value] of Object.entries(resourceConfig(dup))) {
      if (NON_MERGED_CONFIG_KEYS.has(key) || key in merged) continue;
      merged[key] = value;
    }
    const previous = Array.isArray(keepConfig.merged_duplicates) ? keepConfig.merged_duplicates : [];
    merged.merged_duplicates = [...previous, { id: dup.id, created_at: dup.created_at, merged_at: now }];

    const emptyJson = (value: string, empty: string) => !value || value.trim() === empty;
    const ports = emptyJson(keep.ports_json, "{}") ? dup.ports_json : keep.ports_json;
    const containers = emptyJson(keep.containers_json, "[]") ? dup.containers_json : keep.containers_json;
    ctx.db
      .prepare(
        "UPDATE managed_resources SET config_json = ?, ports_json = ?, containers_json = ?, updated_at = ? WHERE id = ?"
      )
      .run(JSON.stringify(merged), ports, containers, now, keep.id);

    ctx.db
      .prepare(
        `UPDATE resource_secrets SET resource_id = ?, updated_at = ?
          WHERE resource_id = ? AND key NOT IN (SELECT key FROM resource_secrets WHERE resource_id = ?)`
      )
      .run(keep.id, now, dup.id, keep.id);
    ctx.db.prepare("DELETE FROM resource_secrets WHERE resource_id = ?").run(dup.id);

    const links = ctx.db
      .prepare("SELECT * FROM service_resource_links WHERE resource_id = ?")
      .all(dup.id) as ServiceResourceLinkRow[];
    for (const link of links) {
      const existing = ctx.db
        .prepare("SELECT * FROM service_resource_links WHERE service_id = ? AND resource_id = ?")
        .get(link.service_id, keep.id) as ServiceResourceLinkRow | undefined;
      if (existing) {
        if (link.active === 1 && existing.active !== 1) {
          ctx.db
            .prepare("UPDATE service_resource_links SET active = 1, updated_at = ? WHERE id = ?")
            .run(now, existing.id);
        }
        ctx.db.prepare("DELETE FROM service_resource_links WHERE id = ?").run(link.id);
      } else {
        ctx.db
          .prepare("UPDATE service_resource_links SET resource_id = ?, updated_at = ? WHERE id = ?")
          .run(keep.id, now, link.id);
      }
    }

    ctx.db.prepare("DELETE FROM managed_resources WHERE id = ?").run(dup.id);
  })();
}

export type DuplicateMergeReport = {
  dryRun: boolean;
  groups: Array<{
    kept: { id: string; name: string };
    merged: Array<{ id: string; name: string; created_at: string }>;
    /** Set when the group was left alone, with the reason. */
    skipped?: string;
  }>;
};

/**
 * Merge every group of exact duplicate records (same profile, workdir, ports and
 * db_url). With `dryRun` nothing changes; the report says what would.
 */
export function mergeDuplicateResources(
  ctx: AppContext,
  options: { dryRun?: boolean } = {}
): DuplicateMergeReport {
  const dryRun = options.dryRun === true;
  const groups = findDuplicateResourceGroups(ctx);
  const report: DuplicateMergeReport = { dryRun, groups: [] };
  for (const group of groups) {
    const serving = group.duplicates.find((dup) => isFunctionsServing(dup.id));
    const skipped = serving
      ? `Edge Functions are being served under ${serving.id}; stop them before merging`
      : undefined;
    if (!dryRun && !skipped) for (const dup of group.duplicates) mergeInto(ctx, group.keep.id, dup.id);
    report.groups.push({
      kept: { id: group.keep.id, name: group.keep.name },
      merged: group.duplicates.map((dup) => ({ id: dup.id, name: dup.name, created_at: dup.created_at })),
      ...(skipped ? { skipped } : {})
    });
  }
  return report;
}

/**
 * If `resourceId` is a duplicate record of another row, fold it into that row
 * and return the row it was merged into; otherwise null. Lets "remove this
 * resource" drop a duplicate record without the profile tearing down the stack
 * the other record still describes.
 */
export function mergeIfDuplicate(ctx: AppContext, resourceId: string): ManagedResourceRow | null {
  const group = findDuplicateResourceGroups(ctx).find(
    (g) => g.keep.id === resourceId || g.duplicates.some((dup) => dup.id === resourceId)
  );
  if (!group) return null;
  if (isFunctionsServing(resourceId)) {
    // Its serve process is tracked under this id; deleting the row would orphan it.
    throw new Error(
      "This record is a duplicate of another record for the same stack, but its Edge Functions are being " +
        "served under it. Stop functions on it first, then remove it (only the record is removed)."
    );
  }
  const others = [group.keep, ...group.duplicates].filter((row) => row.id !== resourceId);
  const into = rankKeepers(others)[0]!;
  mergeInto(ctx, into.id, resourceId);
  return into;
}
