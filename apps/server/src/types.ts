import type Database from "better-sqlite3";
import type Docker from "dockerode";
import type httpProxy from "http-proxy";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { config } from "./config.js";

export type LogLevel = "info" | "warn" | "error";
export type RuntimeProcess = { process: ChildProcessWithoutNullStreams; serviceId: string };
export type BuildType = "docker" | "node" | "python" | "unknown";

export type AppConfig = typeof config;

export type AppContext = {
  app: FastifyInstance;
  db: Database.Database;
  docker: Docker;
  proxy: httpProxy;
  wsSubscribers: Set<WebSocket>;
  /**
   * Per-transferId subscribers. Used by /databases/:id/transfer/stream so chunk
   * events only reach the originating tab instead of every connected admin.
   */
  transferSubscribers: Map<string, Set<WebSocket>>;
  runtimeProcesses: Map<string, RuntimeProcess>;
  actionLocks: Set<string>;
  manuallyStopped: Set<string>;
  config: AppConfig;
  shutdownTasks: Array<() => Promise<void> | void>;
};
