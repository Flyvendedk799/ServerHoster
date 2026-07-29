import type { Readable } from "node:stream";
import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  deleteMediaFile,
  getPlexStatus,
  listMediaFiles,
  listPlexLibraries,
  listPlexSessions,
  MEDIA_LIBRARIES,
  readPlexLog,
  refreshPlexLibrary,
  saveMediaUpload,
  setPlexAutostart,
  setPlexPower
} from "../services/plex.js";

const powerSchema = z.object({
  action: z.enum(["start", "stop", "restart"])
});

const autostartSchema = z.object({
  enabled: z.boolean()
});

const logQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200)
});

const uploadQuerySchema = z.object({
  library: z.enum(MEDIA_LIBRARIES),
  filename: z.string().min(1).max(255),
  /** Optional single subfolder, e.g. "Dune (2021)". */
  folder: z.string().min(1).max(255).optional()
});

const mediaQuerySchema = z.object({
  library: z.enum(MEDIA_LIBRARIES)
});

const mediaDeleteSchema = z.object({
  library: z.enum(MEDIA_LIBRARIES),
  path: z.string().min(1).max(1024)
});

/** 128 GiB — a ceiling no real media file reaches, not a memory reservation. */
const UPLOAD_BODY_LIMIT = 128 * 1024 * 1024 * 1024;

export function registerPlexRoutes(ctx: AppContext): void {
  // Uploads arrive as a raw body so a multi-gigabyte movie streams to disk
  // instead of being buffered. Fastify has no built-in parser for this type,
  // and handing the untouched stream to the handler is the correct global
  // behaviour for it.
  ctx.app.addContentTypeParser(
    "application/octet-stream",
    (_req, payload, done: (err: Error | null, body?: unknown) => void) => {
      done(null, payload);
    }
  );


  /** Lifecycle + claim state. Safe to poll; never returns the Plex token. */
  ctx.app.get("/plex/status", async () => getPlexStatus());

  ctx.app.post("/plex/power", async (req) => {
    const { action } = powerSchema.parse(req.body);
    // Serialize lifecycle actions the same way service start/stop is guarded,
    // so a double-click can't have systemd starting and stopping at once.
    if (ctx.actionLocks.has("plex")) {
      const error = new Error("A Plex power action is already in progress") as Error & {
        statusCode: number;
      };
      error.statusCode = 409;
      throw error;
    }
    ctx.actionLocks.add("plex");
    try {
      return await setPlexPower(action);
    } finally {
      ctx.actionLocks.delete("plex");
    }
  });

  ctx.app.post("/plex/autostart", async (req) => {
    const { enabled } = autostartSchema.parse(req.body);
    return setPlexAutostart(enabled);
  });

  ctx.app.get("/plex/libraries", async () => ({ items: await listPlexLibraries() }));

  ctx.app.post("/plex/libraries/:key/refresh", async (req) => {
    const { key } = req.params as { key: string };
    await refreshPlexLibrary(key);
    return { ok: true };
  });

  ctx.app.get("/plex/sessions", async () => ({ items: await listPlexSessions() }));

  ctx.app.get("/plex/logs", async (req) => {
    const { lines } = logQuerySchema.parse(req.query ?? {});
    return { log: await readPlexLog(lines) };
  });

  /**
   * Streaming upload into the media tree.
   *
   * The file is the raw request body; target and name travel as query params
   * so nothing has to be buffered to be parsed. The route raises the 50 MiB
   * app-wide `bodyLimit` well past any plausible media file — the body is
   * never held in memory here, and free disk space is checked against
   * Content-Length before the write begins.
   */
  ctx.app.post("/plex/upload", { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const { library, filename, folder } = uploadQuerySchema.parse(req.query ?? {});
    const declared = Number(req.headers["content-length"] ?? 0);
    const result = await saveMediaUpload({
      library,
      filename,
      folder,
      source: req.body as Readable,
      declaredBytes: Number.isFinite(declared) && declared > 0 ? declared : null
    });
    return reply.code(201).send(result);
  });

  /** What's actually on disk — visible before Plex has scanned it. */
  ctx.app.get("/plex/media", async (req) => {
    const { library } = mediaQuerySchema.parse(req.query ?? {});
    return { items: await listMediaFiles(library) };
  });

  ctx.app.delete("/plex/media", async (req) => {
    const { library, path: relativePath } = mediaDeleteSchema.parse(req.query ?? {});
    await deleteMediaFile(library, relativePath);
    return { ok: true };
  });
}
