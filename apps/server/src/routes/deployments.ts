import { z } from "zod";
import type { AppContext } from "../types.js";
import { deployFromGit, rollbackDeployment } from "../services/deploy.js";

const deploySchema = z.object({ serviceId: z.string(), repoUrl: z.string().url() });
const rollbackSchema = z.object({ serviceId: z.string(), deploymentId: z.string() });

export function registerDeploymentRoutes(ctx: AppContext): void {
  ctx.app.post("/deployments/from-git", async (req) => {
    const p = deploySchema.parse(req.body);
    return deployFromGit(ctx, p.serviceId, p.repoUrl);
  });

  ctx.app.post("/deployments/rollback", async (req) => {
    const p = rollbackSchema.parse(req.body);
    return rollbackDeployment(ctx, p.serviceId, p.deploymentId);
  });

  ctx.app.get("/deployments", async () => ctx.db.prepare("SELECT * FROM deployments ORDER BY created_at DESC").all());
}
