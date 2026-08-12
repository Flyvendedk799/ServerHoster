import net from "node:net";
import type { AppContext } from "../../types.js";

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
 * Values this module can write. `raw` is an escape hatch for TOML that must not
 * be quoted — `env(SUPABASE_AUTH_SMTP_PASS)` is a string in the file but the CLI
 * only resolves it when it appears as a quoted env() call, and arrays have no
 * scalar form at all.
 */
export type TomlValue = number | string | boolean | { raw: string };

function formatTomlValue(value: TomlValue): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return value.raw;
}

/**
 * Set `[section] key = value` in a TOML string, creating the key or the whole
 * section if absent. Line-oriented and dependency-free: a section body runs from
 * its header to the next `[`-header (or EOF); an existing `key =` inside it is
 * replaced, otherwise the key is inserted just under the header, otherwise the
 * section is appended. Keys grouped by section so a new [db] gets both its ports.
 */
export function setTomlValues(
  toml: string,
  entries: ReadonlyArray<{ section: string; key: string; value: TomlValue }>
): string {
  const bySection = new Map<string, Array<{ key: string; value: TomlValue }>>();
  for (const e of entries) {
    const list = bySection.get(e.section) ?? [];
    list.push({ key: e.key, value: e.value });
    bySection.set(e.section, list);
  }

  let lines = toml.split("\n");
  for (const [section, kvs] of bySection) {
    lines = setSection(lines, section, kvs);
  }
  return lines.join("\n");
}

/** Port-shaped wrapper, kept because the port block is the original caller. */
export function setTomlPorts(
  toml: string,
  entries: ReadonlyArray<{ section: string; key: string; value: number }>
): string {
  return setTomlValues(toml, entries);
}

function setSection(
  lines: string[],
  section: string,
  kvs: Array<{ key: string; value: TomlValue }>
): string[] {
  const header = `[${section}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const block = ["", header, ...kvs.map((kv) => `${kv.key} = ${formatTomlValue(kv.value)}`)];
    // Trim a single trailing empty line so we don't accumulate blank lines.
    const base = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    return [...base, ...block];
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  for (const kv of kvs) {
    const line = `${kv.key} = ${formatTomlValue(kv.value)}`;
    const idx = body.findIndex((l) => new RegExp(`^\\s*${kv.key}\\s*=`).test(l));
    if (idx !== -1) body[idx] = line;
    else body.unshift(line);
  }
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)];
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
