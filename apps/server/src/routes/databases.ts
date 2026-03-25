import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { nowIso } from "../lib/core.js";

const databaseSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  engine: z.enum(["postgres", "mysql", "redis", "mongo"]),
  port: z.number().int()
});

async function pullImage(ctx: AppContext, image: string): Promise<void> {
  const stream = await ctx.docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    ctx.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
}

export function registerDatabaseRoutes(ctx: AppContext): void {
  ctx.app.get("/databases", async () => ctx.db.prepare("SELECT * FROM databases ORDER BY created_at DESC").all());

  ctx.app.post("/databases", async (req) => {
    const p = databaseSchema.parse(req.body);
    const imageMap: Record<string, string> = { postgres: "postgres:16", mysql: "mysql:8", redis: "redis:7", mongo: "mongo:8" };
    const defaultEnv: Record<string, string[]> = {
      postgres: ["POSTGRES_PASSWORD=survhub"],
      mysql: ["MYSQL_ROOT_PASSWORD=survhub"],
      redis: [],
      mongo: ["MONGO_INITDB_ROOT_USERNAME=admin", "MONGO_INITDB_ROOT_PASSWORD=survhub"]
    };
    const containerName = `survhub-db-${nanoid(8)}`;
    let containerId = "";
    try {
      await pullImage(ctx, imageMap[p.engine]);
      const container = await ctx.docker.createContainer({
        Image: imageMap[p.engine],
        name: containerName,
        Env: defaultEnv[p.engine],
        ExposedPorts: { [`${p.port}/tcp`]: {} },
        HostConfig: {
          PortBindings: { [`${p.port}/tcp`]: [{ HostPort: String(p.port) }] },
          RestartPolicy: { Name: "unless-stopped" },
          Binds: [`survhub_${p.engine}_${p.name}:/var/lib/${p.engine}`]
        }
      });
      await container.start();
      containerId = container.id;
    } catch (error) {
      throw new Error(`Database container create/start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const row = {
      id: nanoid(),
      project_id: p.projectId,
      name: p.name,
      engine: p.engine,
      port: p.port,
      container_id: containerId,
      connection_string: `${p.engine}://localhost:${p.port}`,
      created_at: nowIso()
    };
    ctx.db.prepare("INSERT INTO databases (id, project_id, name, engine, port, container_id, connection_string, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.project_id, row.name, row.engine, row.port, row.container_id, row.connection_string, row.created_at);
    return row;
  });
}
