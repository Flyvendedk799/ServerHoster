import net from "node:net";
import type { AppContext } from "../../types.js";
import { setTomlValues } from "./tomlEdit.js";

/**
 * Unique host-port allocation for local Supabase stacks.
 *
 * The Supabase CLI binds a fixed block of host ports (54321-54329 by default),
 * read from each project's supabase/config.toml. Two projects that both rely on
 * the defaults collide — `supabase start` fails with "port is already
 * allocated" — which is exactly what stranded a second app on its cloud
 * database. This module assigns each project a distinct, stable port offset and
 * patches config.toml so any number of Supabase stacks coexist on one host.
 *
 * The offset is a multiple of 100 added to every default port (api 54321 →
 * 54421 at +100, etc.), so the whole block shifts together and the CLI's
 * internal expectations about relative ports are preserved.
 */

/** The host-bound ports the CLI reads from config.toml, with their defaults and
 *  TOML location. Everything here can collide across projects. */
export const SUPABASE_PORT_MAP: ReadonlyArray<{ section: string; key: string; def: number }> = [
  { section: "api", key: "port", def: 54321 },
  { section: "db", key: "port", def: 54322 },
  { section: "db", key: "shadow_port", def: 54320 },
  { section: "db.pooler", key: "port", def: 54329 },
  { section: "studio", key: "port", def: 54323 },
  { section: "inbucket", key: "port", def: 54324 },
  { section: "analytics", key: "port", def: 54327 }
];

/** Largest offset we'll search before giving up (500 stacks worth of headroom). */
const MAX_OFFSET = 50_000;
const OFFSET_STEP = 100;

/**
 * TOML editing lives in tomlEdit.ts (structure-aware: multi-line arrays, inline
 * tables, comments, CRLF). Re-exported here for the existing callers.
 */
export { setTomlValues, type TomlValue } from "./tomlEdit.js";

/** Port-shaped wrapper, kept because the port block is the original caller. */
export function setTomlPorts(
  toml: string,
  entries: ReadonlyArray<{ section: string; key: string; value: number }>
): string {
  return setTomlValues(toml, entries);
}

/** Rewrite config.toml so every Supabase host port = default + offset. */
export function applyPortOffsetToToml(toml: string, offset: number): string {
  return setTomlPorts(
    toml,
    SUPABASE_PORT_MAP.map((p) => ({ section: p.section, key: p.key, value: p.def + offset }))
  );
}

/** The concrete host ports a given offset would bind. */
export function portsForOffset(offset: number): number[] {
  return SUPABASE_PORT_MAP.map((p) => p.def + offset);
}

/** True when nothing is listening on `port` (host-wide bind test on 0.0.0.0). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

/** Offsets already reserved by other Supabase resources (stable across restarts,
 *  so a stopped stack still keeps its block). */
export function reservedOffsets(ctx: AppContext, excludeResourceId?: string): Set<number> {
  const rows = ctx.db
    .prepare("SELECT id, config_json FROM managed_resources WHERE profile = 'supabase'")
    .all() as Array<{ id: string; config_json: string | null }>;
  const used = new Set<number>();
  for (const row of rows) {
    if (row.id === excludeResourceId) continue;
    try {
      const offset = JSON.parse(row.config_json ?? "{}")?.port_offset;
      if (typeof offset === "number" && Number.isFinite(offset)) used.add(offset);
    } catch {
      /* ignore unparseable config */
    }
  }
  return used;
}

/**
 * Pick a port offset for a resource: reuse its stored one if present, else the
 * smallest multiple of 100 that no other Supabase resource has reserved AND
 * whose whole port block is free on the host (so an orphaned stack squatting the
 * default ports is skipped too).
 */
export async function allocatePortOffset(
  ctx: AppContext,
  resourceId: string,
  currentOffset?: number
): Promise<number> {
  if (typeof currentOffset === "number" && Number.isFinite(currentOffset)) return currentOffset;
  const reserved = reservedOffsets(ctx, resourceId);
  for (let offset = 0; offset <= MAX_OFFSET; offset += OFFSET_STEP) {
    if (reserved.has(offset)) continue;
    const free = await Promise.all(portsForOffset(offset).map(isPortFree));
    if (free.every(Boolean)) return offset;
  }
  throw new Error("No free Supabase host-port block available.");
}
