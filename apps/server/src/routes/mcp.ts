import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { getService, insertLog, serializeError } from "../lib/core.js";
import { listServiceEnvRequirements } from "../services/envScan.js";
import {
  getContainerLogs,
  getContainerStatus,
  getDatabase,
  type DatabaseRow
} from "../services/databases.js";
import { restartService, startService, stopService } from "../services/runtime.js";
import { validateMcpSessionToken } from "../services/agents.js";
import { writeAuditLog } from "../services/audit.js";

type McpAuth = NonNullable<ReturnType<typeof validateMcpSessionToken>>;

function text(content: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
      }
    ]
  };
}

function auditTool(ctx: AppContext, auth: McpAuth, tool: string, statusCode: number, details?: string): void {
  writeAuditLog(ctx, {
    actor: `mcp:${auth.id}`,
    action: `MCP ${tool}`,
    resourceType: "services",
    resourceId: auth.serviceId,
    statusCode,
    details
  });
}

function assertMutationAllowed(auth: McpAuth, tool: string): void {
  if (!auth.allowMutations || !auth.policy.includes(tool)) {
    throw new Error(`MCP tool ${tool} is not allowed for this read-only agent session`);
  }
}

function recentLogs(ctx: AppContext, serviceId: string, limit: number) {
  return ctx.db
    .prepare(
      "SELECT level, message, timestamp FROM logs WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(serviceId, Math.max(1, Math.min(500, limit))) as Array<{
    level: string;
    message: string;
    timestamp: string;
  }>;
}

function createServiceMcpServer(ctx: AppContext, auth: McpAuth): McpServer {
  const server = new McpServer({
    name: "serverhoster-service-context",
    version: "1.0.0"
  });

  server.registerTool(
    "service_summary",
    {
      title: "Service summary",
      description:
        "Read the selected ServerHoster service status, command, ports, URLs, and runtime metadata.",
      inputSchema: {}
    },
    async () => {
      try {
        const service = getService(ctx, auth.serviceId);
        const proxy = ctx.db
          .prepare(
            "SELECT domain, target_port FROM proxy_routes WHERE service_id = ? ORDER BY created_at DESC"
          )
          .all(auth.serviceId);
        auditTool(ctx, auth, "service_summary", 200);
        return text({ service, proxy });
      } catch (error) {
        auditTool(ctx, auth, "service_summary", 500, serializeError(error));
        throw error;
      }
    }
  );

  server.registerTool(
    "recent_logs",
    {
      title: "Recent service logs",
      description:
        "Read recent persisted service stdout/stderr logs. Terminal keystrokes and agent transcripts are not included.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(100) }
    },
    async ({ limit }) => {
      const logs = recentLogs(ctx, auth.serviceId, Number(limit ?? 100)).reverse();
      auditTool(ctx, auth, "recent_logs", 200, `limit=${limit}`);
      return text(logs);
    }
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search service logs",
      description: "Search recent persisted service logs for a case-insensitive query.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async ({ query, limit }) => {
      const rows = ctx.db
        .prepare(
          "SELECT level, message, timestamp FROM logs WHERE service_id = ? AND LOWER(message) LIKE ? ORDER BY timestamp DESC LIMIT ?"
        )
        .all(
          auth.serviceId,
          `%${String(query).toLowerCase()}%`,
          Math.max(1, Math.min(200, Number(limit ?? 50)))
        );
      auditTool(ctx, auth, "search_logs", 200, `query=${query}`);
      return text(rows);
    }
  );

  server.registerTool(
    "env_requirements",
    {
      title: "Environment requirements",
      description: "Read detected service environment variable requirements and whether they are satisfied.",
      inputSchema: {}
    },
    async () => {
      const rows = await listServiceEnvRequirements(ctx);
      auditTool(ctx, auth, "env_requirements", 200);
      return text(
        rows.find((row) => row.service_id === auth.serviceId) ?? {
          service_id: auth.serviceId,
          requirements: []
        }
      );
    }
  );

  server.registerTool(
    "deployments",
    {
      title: "Deployments",
      description: "Read recent deployment records for this service.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) }
    },
    async ({ limit }) => {
      const rows = ctx.db
        .prepare(
          "SELECT id, commit_hash, status, artifact_path, started_at, finished_at, branch, trigger_source, created_at FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(auth.serviceId, Math.max(1, Math.min(50, Number(limit ?? 10))));
      auditTool(ctx, auth, "deployments", 200);
      return text(rows);
    }
  );

  server.registerTool(
    "database_summary",
    {
      title: "Database summary",
      description: "Read databases linked to the same project and the service linked database if present.",
      inputSchema: {}
    },
    async () => {
      const service = getService(ctx, auth.serviceId) as {
        project_id?: string;
        linked_database_id?: string | null;
      };
      const rows = ctx.db
        .prepare(
          "SELECT id, project_id, name, engine, port, created_at FROM databases WHERE project_id = ? ORDER BY created_at DESC"
        )
        .all(service.project_id ?? "") as DatabaseRow[];
      const enriched = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          linked: row.id === service.linked_database_id,
          container_status: await getContainerStatus(ctx, row).catch(() => ({ state: "unknown" }))
        }))
      );
      auditTool(ctx, auth, "database_summary", 200);
      return text(enriched);
    }
  );

  server.registerTool(
    "database_logs",
    {
      title: "Database logs",
      description: "Read recent container logs for a managed database in the same project.",
      inputSchema: {
        databaseId: z.string().min(1),
        tail: z.number().int().min(1).max(500).default(120)
      }
    },
    async ({ databaseId, tail }) => {
      const service = getService(ctx, auth.serviceId) as { project_id?: string };
      const db = getDatabase(ctx, String(databaseId));
      if (!db || db.project_id !== service.project_id)
        throw new Error("Database not found in this service project");
      const logs = await getContainerLogs(ctx, db, Number(tail ?? 120));
      auditTool(ctx, auth, "database_logs", 200, `database=${databaseId}`);
      return text(logs.slice(-8000));
    }
  );

  server.registerTool(
    "start_service",
    {
      title: "Start service",
      description: "Start the selected service. Requires the agent run to allow service actions.",
      inputSchema: {}
    },
    async () => {
      assertMutationAllowed(auth, "service:start");
      await startService(ctx, auth.serviceId);
      auditTool(ctx, auth, "start_service", 200);
      return text({ ok: true });
    }
  );

  server.registerTool(
    "stop_service",
    {
      title: "Stop service",
      description: "Stop the selected service. Requires the agent run to allow service actions.",
      inputSchema: {}
    },
    async () => {
      assertMutationAllowed(auth, "service:stop");
      await stopService(ctx, auth.serviceId);
      auditTool(ctx, auth, "stop_service", 200);
      return text({ ok: true });
    }
  );

  server.registerTool(
    "restart_service",
    {
      title: "Restart service",
      description: "Restart the selected service. Requires the agent run to allow service actions.",
      inputSchema: {}
    },
    async () => {
      assertMutationAllowed(auth, "service:restart");
      await restartService(ctx, auth.serviceId);
      auditTool(ctx, auth, "restart_service", 200);
      return text({ ok: true });
    }
  );

  server.registerTool(
    "add_log_marker",
    {
      title: "Add log marker",
      description:
        "Add an informational marker to the selected service logs. Requires the agent run to allow service actions.",
      inputSchema: { message: z.string().min(1).max(300) }
    },
    async ({ message }) => {
      assertMutationAllowed(auth, "log:marker");
      insertLog(ctx, auth.serviceId, "info", `[agent marker] ${message}`);
      auditTool(ctx, auth, "add_log_marker", 200);
      return text({ ok: true });
    }
  );

  return server;
}

function extractBearer(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.replace(/^Bearer\s+/i, "") ?? "";
}

export function registerMcpRoutes(ctx: AppContext): void {
  ctx.app.post("/mcp/:tokenId", async (req, reply) => {
    const { tokenId } = req.params as { tokenId: string };
    const token = extractBearer(req.headers as Record<string, string | string[] | undefined>);
    const auth = validateMcpSessionToken(ctx, tokenId, token);
    if (!auth) {
      reply.code(401).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized MCP session" },
        id: null
      });
      return;
    }

    const mcpServer = createServiceMcpServer(ctx, auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (error) {
      ctx.app.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP server error" },
            id: null
          })
        );
      }
    } finally {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    }
  });

  ctx.app.get("/mcp/:tokenId", async (_req, reply) => {
    reply.code(405).send({ error: "MCP stateless endpoint accepts POST requests only" });
  });

  ctx.app.delete("/mcp/:tokenId", async (_req, reply) => {
    reply.code(405).send({ error: "MCP stateless endpoint accepts POST requests only" });
  });
}
