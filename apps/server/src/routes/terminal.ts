import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  createTerminalSession,
  getTerminalCapabilities,
  killTerminalSession,
  listTerminalSessions
} from "../services/terminals.js";

const createTerminalSchema = z.object({
  target: z.enum(["host", "docker"]).optional(),
  rows: z.number().int().optional(),
  cols: z.number().int().optional()
});

export function registerTerminalRoutes(ctx: AppContext): void {
  ctx.app.get("/services/:id/terminal-capabilities", async (req) => {
    const { id } = req.params as { id: string };
    return getTerminalCapabilities(ctx, id);
  });

  ctx.app.get("/services/:id/terminal-sessions", async (req) => {
    const { id } = req.params as { id: string };
    return listTerminalSessions(ctx, id);
  });

  ctx.app.post("/services/:id/terminal-sessions", async (req) => {
    const { id } = req.params as { id: string };
    const body = createTerminalSchema.parse(req.body ?? {});
    return createTerminalSession(ctx, {
      serviceId: id,
      target: body.target,
      rows: body.rows,
      cols: body.cols,
      kind: "shell",
      title: "Shell"
    });
  });

  ctx.app.delete("/services/:id/terminal-sessions/:sessionId", async (req) => {
    const { sessionId } = req.params as { id: string; sessionId: string };
    killTerminalSession(ctx, sessionId);
    return { ok: true };
  });
}
