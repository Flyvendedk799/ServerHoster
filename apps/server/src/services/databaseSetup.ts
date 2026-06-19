import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { insertLog, serializeError } from "../lib/core.js";
import { encryptSecret } from "../security.js";
import { getDatabase } from "./databases.js";
import { getComposeDatabaseConnectionForService } from "./embeddedDatabases.js";
import { createNotification } from "./notifications.js";
import { restartOrRedeployService } from "./resources/restart.js";
import { getProfile, type ResourceProfileId } from "./resources/profiles.js";
import { linkResourceToService } from "./resources/lifecycle.js";
import {
  adoptDatabaseAsResource,
  recognizeService,
  runRecognitionScan,
  type DatabaseRecognition,
  type RecognitionAction
} from "./resources/recognition.js";

export type ServiceDatabaseSetupMode = "skip" | "review" | "auto" | "create" | "link";
export type ServiceDatabaseSetupProfile = Exclude<ResourceProfileId, "manual">;

export type ServiceDatabaseSetupInput = {
  mode?: ServiceDatabaseSetupMode;
  profile?: ServiceDatabaseSetupProfile;
  databaseId?: string;
  restart?: boolean;
};

export type ServiceDatabaseSetupResult = {
  mode: ServiceDatabaseSetupMode;
  status: "skipped" | "review" | "ready" | "blocked" | "failed" | "no-database-detected";
  action?: "scan" | "connect-compose" | "link-existing" | "adopt-legacy" | "provision";
  profile?: ServiceDatabaseSetupProfile;
  database_id?: string;
  resource_id?: string;
  message: string;
  recognition?: DatabaseRecognition;
};

type DatabaseSetupOptions = {
  /** Default restart/redeploy behavior when the request does not specify it. */
  defaultRestart?: boolean;
};

function failureResult(
  mode: ServiceDatabaseSetupMode,
  ctx: AppContext,
  serviceId: string,
  error: unknown
): ServiceDatabaseSetupResult {
  const message = serializeError(error);
  insertLog(ctx, serviceId, "warn", `Database setup failed: ${message}`);
  createNotification(ctx, {
    kind: "system",
    severity: "warning",
    title: "Database setup needs attention",
    body: message,
    serviceId
  });
  return {
    mode,
    status: "failed",
    message
  };
}

async function applyRuntimeEnv(ctx: AppContext, serviceId: string, restart: boolean): Promise<string | null> {
  if (!restart) return null;
  try {
    const outcome = await restartOrRedeployService(ctx, serviceId);
    return ` Service ${outcome.action} so the database env is live.`;
  } catch (error) {
    const message = serializeError(error);
    insertLog(ctx, serviceId, "warn", `Database linked, but service refresh failed: ${message}`);
    return ` Database is linked, but the service did not refresh automatically: ${message}`;
  }
}

function normalize(input: ServiceDatabaseSetupInput | undefined): {
  mode: ServiceDatabaseSetupMode;
  profile: ServiceDatabaseSetupProfile | undefined;
  databaseId: string | undefined;
  restart: boolean | undefined;
} {
  return {
    mode: input?.mode ?? "skip",
    profile: input?.profile,
    databaseId: input?.databaseId,
    restart: input?.restart
  };
}

function shouldRestart(
  ctx: AppContext,
  serviceId: string,
  requested: boolean | undefined,
  fallback: boolean
): boolean {
  if (requested !== undefined) return requested;
  const service = ctx.db
    .prepare("SELECT type, github_repo_url FROM services WHERE id = ?")
    .get(serviceId) as { type?: string; github_repo_url?: string | null } | undefined;
  // Static GitHub services need a rebuild to pick up VITE_/NEXT_PUBLIC env even
  // when they are not running yet; restartOrRedeployService preserves stopped
  // state for that redeploy path.
  if (service?.type === "static" && service.github_repo_url) return true;
  return fallback;
}

function primaryAutoAction(recognition: DatabaseRecognition): RecognitionAction | null {
  const safePriority: RecognitionAction["id"][] = ["link-existing", "adopt-legacy", "provision"];
  return (
    safePriority
      .map((id) => recognition.actions.find((action) => action.id === id && action.preferred && !action.disabled))
      .find(Boolean) ??
    safePriority
      .map((id) => recognition.actions.find((action) => action.id === id && !action.disabled))
      .find(Boolean) ??
    null
  );
}

async function provisionProfile(
  ctx: AppContext,
  serviceId: string,
  profile: ServiceDatabaseSetupProfile,
  restart: boolean
): Promise<{ resource_id: string; recognition: DatabaseRecognition }> {
  const resourceProfile = getProfile(profile);
  if (!resourceProfile) throw new Error(`Unknown database/resource profile: ${profile}`);
  const resource = await resourceProfile.provision(ctx, { serviceId, restart });
  return { resource_id: resource.id, recognition: await recognizeService(ctx, serviceId) };
}

async function connectComposeDatabase(
  ctx: AppContext,
  serviceId: string,
  restart: boolean
): Promise<ServiceDatabaseSetupResult | null> {
  const candidate = await getComposeDatabaseConnectionForService(ctx, serviceId).catch(() => null);
  if (!candidate?.available || !candidate.connection_url) return null;

  ctx.db.prepare("DELETE FROM env_vars WHERE service_id = ? AND key = ?").run(serviceId, candidate.env_key);
  ctx.db
    .prepare("INSERT INTO env_vars (id, service_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)")
    .run(
      nanoid(),
      serviceId,
      candidate.env_key,
      encryptSecret(candidate.connection_url, ctx.config.secretKey),
      1
    );

  const refreshMessage = await applyRuntimeEnv(ctx, serviceId, restart);
  return {
    mode: "auto",
    status: "ready",
    action: "connect-compose",
    profile: candidate.engine,
    message: `Connected existing Docker Compose ${candidate.engine} service "${candidate.database_service_name}".${
      refreshMessage ?? ""
    }`,
    recognition: await recognizeService(ctx, serviceId)
  };
}

async function applyInner(
  ctx: AppContext,
  serviceId: string,
  input: ServiceDatabaseSetupInput | undefined,
  options: DatabaseSetupOptions
): Promise<ServiceDatabaseSetupResult> {
  const setup = normalize(input);
  if (setup.mode === "skip") {
    return { mode: "skip", status: "skipped", message: "Database setup was skipped." };
  }

  const restart = shouldRestart(ctx, serviceId, setup.restart, options.defaultRestart ?? true);

  if (setup.mode === "link") {
    if (!setup.databaseId) throw new Error("databaseId is required when database setup mode is link");
    const db = getDatabase(ctx, setup.databaseId);
    if (!db) throw new Error("Database not found");
    const resource = await adoptDatabaseAsResource(ctx, { databaseId: db.id, serviceId });
    const refreshMessage = await applyRuntimeEnv(ctx, serviceId, restart);
    return {
      mode: "link",
      status: "ready",
      action: "adopt-legacy",
      profile: resource.profile as ServiceDatabaseSetupProfile,
      database_id: db.id,
      resource_id: resource.id,
      message: `Linked existing ${db.engine} database "${db.name}".${refreshMessage ?? ""}`,
      recognition: await recognizeService(ctx, serviceId)
    };
  }

  if (setup.mode === "create") {
    const profile = setup.profile ?? "postgres";
    const created = await provisionProfile(ctx, serviceId, profile, restart);
    return {
      mode: "create",
      status: "ready",
      action: "provision",
      profile,
      resource_id: created.resource_id,
      message: `Created and linked a local ${profile} resource.`,
      recognition: created.recognition
    };
  }

  const recognition = await runRecognitionScan(ctx, serviceId);

  if (setup.mode === "review") {
    return {
      mode: "review",
      status: "review",
      action: "scan",
      profile: recognition.detected.profile === "manual" ? undefined : recognition.detected.profile,
      message:
        recognition.detected.profile === "manual"
          ? "No database dependency was detected."
          : `Detected ${recognition.detected.profile} (${recognition.detected.confidence} confidence).`,
      recognition
    };
  }

  const compose = await connectComposeDatabase(ctx, serviceId, restart);
  if (compose) return compose;

  if (recognition.state === "satisfied") {
    return {
      mode: "auto",
      status: "ready",
      profile: recognition.detected.profile === "manual" ? undefined : recognition.detected.profile,
      message: `Database setup is already satisfied by ${recognition.current_provider.label}.`,
      recognition
    };
  }

  if (recognition.detected.profile === "manual" && recognition.current_provider.kind === "none") {
    return {
      mode: "auto",
      status: "no-database-detected",
      message: "No database dependency was detected; no database was created.",
      recognition
    };
  }

  const action = primaryAutoAction(recognition);
  if (!action) {
    return {
      mode: "auto",
      status: "blocked",
      profile: recognition.detected.profile === "manual" ? undefined : recognition.detected.profile,
      message: recognition.issues[0]?.message ?? "Database setup needs a manual decision.",
      recognition
    };
  }

  if (action.id === "link-existing" && action.resource_id) {
    linkResourceToService(ctx, { serviceId, resourceId: action.resource_id });
    const refreshMessage = await applyRuntimeEnv(ctx, serviceId, restart);
    return {
      mode: "auto",
      status: "ready",
      action: "link-existing",
      profile: action.profile && action.profile !== "manual" ? action.profile : undefined,
      resource_id: action.resource_id,
      message: `${action.label}.${refreshMessage ?? ""}`,
      recognition: await recognizeService(ctx, serviceId)
    };
  }

  if (action.id === "adopt-legacy" && action.database_id) {
    const resource = await adoptDatabaseAsResource(ctx, { databaseId: action.database_id, serviceId });
    const refreshMessage = await applyRuntimeEnv(ctx, serviceId, restart);
    return {
      mode: "auto",
      status: "ready",
      action: "adopt-legacy",
      profile: resource.profile as ServiceDatabaseSetupProfile,
      database_id: action.database_id,
      resource_id: resource.id,
      message: `${action.label}.${refreshMessage ?? ""}`,
      recognition: await recognizeService(ctx, serviceId)
    };
  }

  if (action.id === "provision") {
    const profile =
      (action.profile ?? recognition.detected.profile) === "manual"
        ? "postgres"
        : ((action.profile ?? recognition.detected.profile) as ServiceDatabaseSetupProfile);
    const created = await provisionProfile(ctx, serviceId, profile, restart);
    return {
      mode: "auto",
      status: "ready",
      action: "provision",
      profile,
      resource_id: created.resource_id,
      message: `Created and linked a local ${profile} resource.`,
      recognition: created.recognition
    };
  }

  return {
    mode: "auto",
    status: "blocked",
    profile: recognition.detected.profile === "manual" ? undefined : recognition.detected.profile,
    message: recognition.issues[0]?.message ?? "Database setup needs a manual decision.",
    recognition
  };
}

export async function applyServiceDatabaseSetup(
  ctx: AppContext,
  serviceId: string,
  input?: ServiceDatabaseSetupInput,
  options: DatabaseSetupOptions = {}
): Promise<ServiceDatabaseSetupResult> {
  const mode = input?.mode ?? "skip";
  try {
    return await applyInner(ctx, serviceId, input, options);
  } catch (error) {
    return failureResult(mode, ctx, serviceId, error);
  }
}
