import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../types.js";
import { getService, insertLog, serializeError, withTimeout } from "../lib/core.js";
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
import { isAuthorizedToken, resolveActorFromToken } from "../services/auth.js";
import { collectSystemHealth } from "../services/health.js";
import { deployFromGit, applyPostDeployServiceState } from "../services/deploy.js";

type McpAuth = NonNullable<ReturnType<typeof validateMcpSessionToken>>;

/** Keep MCP tool/request work under typical client timeouts (~30s) with headroom. */
const MCP_REQUEST_TIMEOUT_MS = 25_000;
const MCP_LOG_TEXT_CAP = 24_000;

function text(content: unknown) {
  const raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const capped =
    raw.length > MCP_LOG_TEXT_CAP
      ? `${raw.slice(0, MCP_LOG_TEXT_CAP)}\n…[truncated ${raw.length - MCP_LOG_TEXT_CAP} chars]`
      : raw;
  return {
    content: [
      {
        type: "text" as const,
        text: capped
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

async function runTimedTool<T>(
  label: string,
  work: () => Promise<T>,
  timeoutMs = MCP_REQUEST_TIMEOUT_MS
): Promise<T> {
  return withTimeout(Promise.resolve().then(work), timeoutMs, label);
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
      const enriched = await runTimedTool("database_summary", async () => {
        const service = getService(ctx, auth.serviceId) as {
          project_id?: string;
          linked_database_id?: string | null;
        };
        const rows = ctx.db
          .prepare(
            "SELECT id, project_id, name, engine, port, created_at FROM databases WHERE project_id = ? ORDER BY created_at DESC"
          )
          .all(service.project_id ?? "") as DatabaseRow[];
        return Promise.all(
          rows.map(async (row) => ({
            ...row,
            linked: row.id === service.linked_database_id,
            container_status: await getContainerStatus(ctx, row).catch(() => ({ state: "unknown" }))
          }))
        );
      });
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
      const logs = await runTimedTool("database_logs", () =>
        getContainerLogs(ctx, db, Number(tail ?? 120))
      );
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
      await runTimedTool("start_service", () => startService(ctx, auth.serviceId));
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
      await runTimedTool("stop_service", () => stopService(ctx, auth.serviceId));
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
      await runTimedTool("restart_service", () => restartService(ctx, auth.serviceId));
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



function resolveService(ctx: AppContext, identifier: string): { id: string; project_id: string; [key: string]: unknown } {
  const row = ctx.db.prepare("SELECT * FROM services WHERE id = ? OR name = ?").get(identifier, identifier) as any;
  if (!row) throw new Error(`Service not found: ${identifier}`);
  return row;
}

function resolveDatabase(ctx: AppContext, identifier: string): DatabaseRow {
  const row = ctx.db.prepare("SELECT * FROM databases WHERE id = ? OR name = ?").get(identifier, identifier) as DatabaseRow | undefined;
  if (!row) throw new Error(`Database not found: ${identifier}`);
  return row;
}

function auditGlobalTool(ctx: AppContext, actor: string, tool: string, statusCode: number, details?: string): void {
  writeAuditLog(ctx, {
    actor,
    action: `MCP Global ${tool}`,
    resourceType: "mcp",
    resourceId: "global",
    statusCode,
    details
  });
}

function createGlobalMcpServer(ctx: AppContext, actor: string): McpServer {
  const server = new McpServer({
    name: "serverhoster-control-plane",
    version: "1.0.0"
  });

  server.registerTool("get_system_health", {
    title: "Get system health",
    description: "Get ServerHoster host health, Docker status, CPU count, memory usage, disk metrics, and system warnings.",
    inputSchema: {}
  }, async () => {
    try {
      const health = await runTimedTool("get_system_health", () => collectSystemHealth(ctx));
      auditGlobalTool(ctx, actor, "get_system_health", 200);
      return text(health);
    } catch (error) {
      auditGlobalTool(ctx, actor, "get_system_health", 500, serializeError(error));
      throw error;
    }
  });

  server.registerTool("list_projects", {
    title: "List projects",
    description: "List all projects in ServerHoster with their descriptions and created dates.",
    inputSchema: {}
  }, async () => {
    const rows = ctx.db.prepare("SELECT id, name, description, created_at FROM projects ORDER BY created_at DESC").all();
    auditGlobalTool(ctx, actor, "list_projects", 200);
    return text(rows);
  });

  server.registerTool("list_services", {
    title: "List services",
    description: "List all services configured in ServerHoster, including their running status, type, ports, domains, latest commit, and project ID.",
    inputSchema: { projectId: z.string().optional() }
  }, async ({ projectId }) => {
    let query = `
      SELECT s.id, s.project_id, s.name, s.type, s.status, s.port, s.github_repo_url, s.github_branch,
             p.domain, p.domains, s.created_at, s.updated_at
      FROM services s
      LEFT JOIN (
        SELECT service_id,
               COALESCE(MIN(CASE WHEN domain LIKE 'www.%' OR domain LIKE '*.%' THEN NULL ELSE domain END), MIN(domain)) AS domain,
               GROUP_CONCAT(domain, ',') AS domains
        FROM (
          SELECT service_id, domain FROM proxy_routes WHERE domain IS NOT NULL
          UNION
          SELECT service_id, hostname AS domain FROM saas_domains WHERE hostname IS NOT NULL
        )
        GROUP BY service_id
      ) p ON p.service_id = s.id
    `;
    const params: string[] = [];
    if (projectId) {
      query += " WHERE s.project_id = ?";
      params.push(String(projectId));
    }
    query += " ORDER BY s.created_at DESC";
    
    const rows = ctx.db.prepare(query).all(...params);
    auditGlobalTool(ctx, actor, "list_services", 200);
    return text(rows);
  });

  server.registerTool("get_service_status", {
    title: "Get service status",
    description: "Get detailed runtime status, proxy routes, environment requirements, and latest deployments for a specific service by ID or name.",
    inputSchema: { service: z.string().describe("Service ID or exact service name") }
  }, async ({ service }) => {
    try {
      const result = await runTimedTool("get_service_status", async () => {
        const srv = resolveService(ctx, String(service));
        const proxy = ctx.db.prepare("SELECT domain, target_port FROM proxy_routes WHERE service_id = ? ORDER BY created_at DESC").all(srv.id);
        const reqs = await listServiceEnvRequirements(ctx);
        const envReqs = reqs.find((r) => r.service_id === srv.id) ?? { requirements: [] };
        return { service: srv, proxy, envRequirements: envReqs };
      });
      auditGlobalTool(ctx, actor, "get_service_status", 200, `service=${(result.service as { id: string }).id}`);
      return text(result);
    } catch (error) {
      auditGlobalTool(ctx, actor, "get_service_status", 500, serializeError(error));
      throw error;
    }
  });

  server.registerTool("get_service_logs", {
    title: "Get service logs",
    description: "Fetch the most recent stdout/stderr log lines for a specific service by ID or name.",
    inputSchema: {
      service: z.string().describe("Service ID or exact service name"),
      limit: z.number().int().min(1).max(1000).default(100)
    }
  }, async ({ service, limit }) => {
    const srv = resolveService(ctx, String(service));
    const logs = recentLogs(ctx, srv.id, Number(limit ?? 100)).reverse();
    auditGlobalTool(ctx, actor, "get_service_logs", 200, `service=${srv.id} limit=${limit}`);
    return text(logs);
  });

  server.registerTool("search_service_logs", {
    title: "Search service logs",
    description: "Search stdout/stderr logs of a specific service for a case-insensitive query string.",
    inputSchema: {
      service: z.string().describe("Service ID or exact service name"),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(500).default(50)
    }
  }, async ({ service, query, limit }) => {
    const srv = resolveService(ctx, String(service));
    const rows = ctx.db.prepare("SELECT level, message, timestamp FROM logs WHERE service_id = ? AND LOWER(message) LIKE ? ORDER BY timestamp DESC LIMIT ?")
      .all(srv.id, `%${String(query).toLowerCase()}%`, Math.max(1, Math.min(500, Number(limit ?? 50))));
    auditGlobalTool(ctx, actor, "search_service_logs", 200, `service=${srv.id} query=${query}`);
    return text(rows);
  });

  server.registerTool("start_service", {
    title: "Start service",
    description: "Start a service by ID or name (resolves service dependencies automatically).",
    inputSchema: { service: z.string().describe("Service ID or exact service name") }
  }, async ({ service }) => {
    const srv = resolveService(ctx, String(service));
    await runTimedTool("start_service", () => startService(ctx, srv.id));
    auditGlobalTool(ctx, actor, "start_service", 200, `service=${srv.id}`);
    return text({ ok: true });
  });

  server.registerTool("stop_service", {
    title: "Stop service",
    description: "Stop a running service by ID or name.",
    inputSchema: { service: z.string().describe("Service ID or exact service name") }
  }, async ({ service }) => {
    const srv = resolveService(ctx, String(service));
    await runTimedTool("stop_service", () => stopService(ctx, srv.id));
    auditGlobalTool(ctx, actor, "stop_service", 200, `service=${srv.id}`);
    return text({ ok: true });
  });

  server.registerTool("restart_service", {
    title: "Restart service",
    description: "Restart a service by ID or name.",
    inputSchema: { service: z.string().describe("Service ID or exact service name") }
  }, async ({ service }) => {
    const srv = resolveService(ctx, String(service));
    await runTimedTool("restart_service", () => restartService(ctx, srv.id));
    auditGlobalTool(ctx, actor, "restart_service", 200, `service=${srv.id}`);
    return text({ ok: true });
  });

  server.registerTool("redeploy_service", {
    title: "Redeploy service",
    description: "Trigger a fresh git pull and rebuild/redeploy for a service with a configured GitHub repo.",
    inputSchema: { service: z.string().describe("Service ID or exact service name") }
  }, async ({ service }) => {
    const srv = resolveService(ctx, String(service));
    if (!srv.github_repo_url) throw new Error("Service has no github_repo_url — cannot redeploy");
    const branch = String(srv.github_branch || "main");
    const deployment = await runTimedTool(
      "redeploy_service",
      async () => {
        const d = await deployFromGit(ctx, srv.id, String(srv.github_repo_url), branch, "manual");
        await applyPostDeployServiceState(ctx, srv.id, d, { startAfterDeploy: true });
        return d;
      },
      120_000
    );
    auditGlobalTool(ctx, actor, "redeploy_service", 200, `service=${srv.id}`);
    return text(deployment);
  });

  server.registerTool("list_databases", {
    title: "List databases",
    description: "List all managed databases (Postgres, MySQL, Mongo, Redis), their container status, engine, and linked project.",
    inputSchema: { projectId: z.string().optional() }
  }, async ({ projectId }) => {
    const enriched = await runTimedTool("list_databases", async () => {
      let query = "SELECT id, project_id, name, engine, port, created_at FROM databases";
      const params: string[] = [];
      if (projectId) {
        query += " WHERE project_id = ?";
        params.push(String(projectId));
      }
      query += " ORDER BY created_at DESC";
      const rows = ctx.db.prepare(query).all(...params) as DatabaseRow[];
      return Promise.all(
        rows.map(async (row) => ({
          ...row,
          container_status: await getContainerStatus(ctx, row).catch(() => ({ state: "unknown" }))
        }))
      );
    });
    auditGlobalTool(ctx, actor, "list_databases", 200);
    return text(enriched);
  });

  server.registerTool("get_database_logs", {
    title: "Get database logs",
    description: "Fetch recent container logs for a managed database by ID or name.",
    inputSchema: {
      database: z.string().describe("Database ID or exact database name"),
      tail: z.number().int().min(1).max(500).default(120)
    }
  }, async ({ database, tail }) => {
    const db = resolveDatabase(ctx, String(database));
    const logs = await runTimedTool("get_database_logs", () =>
      getContainerLogs(ctx, db, Number(tail ?? 120))
    );
    auditGlobalTool(ctx, actor, "get_database_logs", 200, `database=${db.id} tail=${tail}`);
    return text(logs.slice(-8000));
  });

  return server;
}


function extractBearer(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers.authorization;
  if (!raw || typeof raw !== "string") return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function unauthorizedMcp(reply: FastifyReply, message: string): void {
  // Use -32000 (server error), not -32001 — MCP clients reserve -32001 for request timeouts.
  reply.code(401).send({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null
  });
}

function methodNotAllowedMcp(reply: FastifyReply): void {
  reply
    .code(405)
    .header("Allow", "POST")
    .send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for MCP Streamable HTTP." },
      id: null
    });
}

async function handleStatelessMcpRequest(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  createServer: () => McpServer,
  logLabel: string
): Promise<void> {
  const mcpServer = createServer();
  // Stateless + JSON responses: each POST is independent (matches mcp-remote).
  // Use the web-standard transport so Fastify can send the body normally —
  // avoiding reply.hijack() + @hono/node-server socket cleanup races.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  try {
    await mcpServer.connect(transport);
    const protocol = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
    const host = (req.headers.host as string | undefined) || "localhost";
    const webRequest = new Request(`${protocol}://${host}${req.url}`, {
      method: "POST",
      headers: headersFromFastify(req),
      body: JSON.stringify(req.body ?? null)
    });
    const response = await transport.handleRequest(webRequest, { parsedBody: req.body });
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      // Fastify manages content-length / transfer-encoding itself.
      if (key.toLowerCase() === "content-length" || key.toLowerCase() === "transfer-encoding") return;
      reply.header(key, value);
    });
    if (response.status === 202 || response.body == null) {
      reply.send();
      return;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    reply.send(buf.length ? buf : undefined);
  } catch (error) {
    ctx.app.log.error({ err: error }, `${logLabel} failed`);
    if (!reply.sent) {
      reply.code(500).send({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  }
}

function headersFromFastify(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
  return headers;
}

export function registerMcpRoutes(ctx: AppContext): void {
  ctx.app.post("/mcp", async (req, reply) => {
    const token = extractBearer(req.headers as Record<string, string | string[] | undefined>);
    if (!isAuthorizedToken(ctx, token)) {
      unauthorizedMcp(reply, "Unauthorized MCP session");
      return;
    }
    const actor = resolveActorFromToken(ctx, token) ?? "mcp-agent";
    await handleStatelessMcpRequest(
      ctx,
      req,
      reply,
      () => createGlobalMcpServer(ctx, actor),
      "Global MCP request"
    );
  });

  ctx.app.get("/mcp", async (_req, reply) => {
    methodNotAllowedMcp(reply);
  });

  ctx.app.delete("/mcp", async (_req, reply) => {
    methodNotAllowedMcp(reply);
  });

  ctx.app.post("/mcp/:tokenId", async (req, reply) => {
    const { tokenId } = req.params as { tokenId: string };
    const token = extractBearer(req.headers as Record<string, string | string[] | undefined>);
    const auth = validateMcpSessionToken(ctx, tokenId, token);
    if (!auth) {
      unauthorizedMcp(reply, "Unauthorized or expired MCP session");
      return;
    }

    await handleStatelessMcpRequest(
      ctx,
      req,
      reply,
      () => createServiceMcpServer(ctx, auth),
      "MCP request"
    );
  });

  ctx.app.get("/mcp/:tokenId", async (_req, reply) => {
    methodNotAllowedMcp(reply);
  });

  ctx.app.delete("/mcp/:tokenId", async (_req, reply) => {
    methodNotAllowedMcp(reply);
  });
}
