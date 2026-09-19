import Docker from "dockerode";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppContext } from "../types.js";

const N8N_IMAGE = "docker.n8n.io/n8nio/n8n:latest";
const N8N_CONTAINER = "serverhoster-n8n";

export type N8nStatus = {
  running: boolean;
  state: string;
  port: number;
};

export async function getN8nStatus(ctx: AppContext): Promise<N8nStatus> {
  try {
    const container = ctx.docker.getContainer(N8N_CONTAINER);
    const info = await container.inspect();
    return {
      running: info.State.Running,
      state: info.State.Status,
      port: 5678,
    };
  } catch {
    return { running: false, state: "stopped", port: 5678 };
  }
}

export async function setN8nPower(ctx: AppContext, action: "start" | "stop" | "restart"): Promise<N8nStatus> {
  const container = ctx.docker.getContainer(N8N_CONTAINER);
  try {
    const info = await container.inspect().catch(() => null);
    
    if (action === "stop" && info?.State.Running) {
      await container.stop();
    } else if (action === "restart" && info) {
      await container.restart();
    } else if (action === "start") {
      if (info) {
        if (!info.State.Running) await container.start();
      } else {
        // Container doesn't exist, create it
        await createAndStartN8n(ctx);
      }
    }
  } catch (err) {
    throw new Error(`Failed to ${action} n8n: ${(err as Error).message}`);
  }
  return getN8nStatus(ctx);
}

async function createAndStartN8n(ctx: AppContext) {
  // Ensure we have the image
  try {
    await ctx.docker.getImage(N8N_IMAGE).inspect();
  } catch {
    await new Promise((resolve, reject) => {
      ctx.docker.pull(N8N_IMAGE, (err: any, stream: any) => {
        if (err) return reject(err);
        ctx.docker.modem.followProgress(stream, (err: any) => err ? reject(err) : resolve(null));
      });
    });
  }

  // Create persistent volume dir
  const dataDir = path.join(ctx.config.serviceDataDir, "n8n_data");
  await mkdir(dataDir, { recursive: true, mode: 0o777 });

  const container = await ctx.docker.createContainer({
    Image: N8N_IMAGE,
    name: N8N_CONTAINER,
    Env: [
      `OPENAI_API_KEY=ai-auth-local-key`,
      // For Linux we can use 172.17.0.1, but for safety in generic docker:
      `OPENAI_BASE_URL=http://host.docker.internal:${ctx.config.apiPort}/n8n/ai/v1`, 
    ],
    HostConfig: {
      Binds: [`${dataDir}:/home/node/.n8n`],
      PortBindings: {
        "5678/tcp": [{ HostPort: "5678" }]
      },
      ExtraHosts: ["host.docker.internal:host-gateway"]
    },
    ExposedPorts: {
      "5678/tcp": {}
    }
  });

  await container.start();
}

export async function readN8nLog(ctx: AppContext, lines: number): Promise<string> {
  try {
    const container = ctx.docker.getContainer(N8N_CONTAINER);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: Math.min(Math.max(lines, 1), 2000),
    });
    return logs.toString('utf-8');
  } catch (err) {
    return `Failed to read logs: ${(err as Error).message}`;
  }
}
