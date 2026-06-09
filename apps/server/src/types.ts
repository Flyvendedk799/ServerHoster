import type Database from "better-sqlite3";
import type Docker from "dockerode";
import type httpProxy from "http-proxy";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { config } from "./config.js";

export type LogLevel = "info" | "warn" | "error";
export type RuntimeProcess = {
  process: ChildProcessWithoutNullStreams;
  serviceId: string;
  processGroupPid?: number;
  /** Unique per spawn; lets a stale exit handler tell if it was replaced. */
  instanceId: string;
  /** Fires once the process has stayed up long enough to clear the crash counter. */
  stabilityTimer?: ReturnType<typeof setTimeout>;
};
export type BuildType = "docker" | "node" | "python" | "godot" | "static" | "unknown";

export type AppConfig = typeof config;

export type TerminalRuntime = {
  id: string;
  serviceId: string;
  pty: IPty;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
};

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
  terminalSubscribers: Map<string, Set<WebSocket>>;
  terminalSessions: Map<string, TerminalRuntime>;
  runtimeProcesses: Map<string, RuntimeProcess>;
  actionLocks: Set<string>;
  manuallyStopped: Set<string>;
  config: AppConfig;
  shutdownTasks: Array<() => Promise<void> | void>;
};
