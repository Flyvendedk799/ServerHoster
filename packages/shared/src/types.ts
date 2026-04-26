export type ServiceType = "process" | "docker" | "static";
export type ServiceStatus = "stopped" | "running" | "crashed" | "building";
export type DatabaseEngine = "postgres" | "mysql" | "redis" | "mongo";

export interface Project {
  id: string;
  name: string;
  description?: string;
  gitUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  projectId: string;
  name: string;
  type: ServiceType;
  command?: string;
  workingDir?: string;
  dockerImage?: string;
  dockerfile?: string;
  port?: number;
  status: ServiceStatus;
  autoRestart: number;
  restartCount: number;
  maxRestarts: number;
  createdAt: string;
  updatedAt: string;
  tunnelUrl?: string | null;
  quickTunnelEnabled?: number;
}

export interface LogEntry {
  id: string;
  serviceId: string;
  level: "info" | "error" | "warn";
  message: string;
  timestamp: string;
}
