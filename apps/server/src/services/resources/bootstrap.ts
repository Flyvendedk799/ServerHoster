import { broadcast } from "../../lib/core.js";
import type { AppContext } from "../../types.js";
import { getResource, resourceConfig, type ManagedResourceRow } from "./lifecycle.js";
import { getResourceSecret } from "./secrets.js";

/**
 * First user / admin / org bootstrap (Database-Tracker Phase 5).
 *
 * After a schema-only provision the local Supabase database has tables but no
 * users, so apps with role/org models are unusable. This module introspects
 * the LOCAL database (role enums, profiles/auth linkage, admin tables, org
 * tables, bootstrap triggers), turns the findings into a wizard-facing plan
 * with an ordered operation preview, and executes the bootstrap through the
 * local Auth admin API + direct control-plane SQL.
 *
 * Safety (spec "First User and Role Bootstrap → Safety" + Security
 * Requirements):
 *   - NEVER runs against non-local hosts — both api_url and db_url must point
 *     at 127.0.0.1 / localhost / host.docker.internal (::1 included).
 *   - Operates only via the service-role key / control-plane DB connection.
 *   - Passwords are never logged, broadcast, or echoed back in results.
 *   - Idempotent where possible: existing email → promote existing user
 *     (warning `user_existed`), existing org slug → use existing organization
 *     (warning `org_existed`).
 *
 * Both side-effecting layers are injectable so tests run without a real
 * database or HTTP stack: `setBootstrapDbClient` (Postgres) and
 * `setBootstrapHttp` (Auth admin API).
 */

// ---- shared shapes (mirrored in packages/shared/src/types.ts) -----------------------

export type BootstrapRequest = {
  email: string;
  password: string;
  fullName?: string;
  role?: string;
  makePlatformAdmin?: boolean;
  organization?: {
    create: boolean;
    name: string;
    slug: string;
  };
};

export type BootstrapRoleEnum = {
  schema: string;
  name: string;
  values: string[];
};

export type BootstrapColumnInfo = {
  name: string;
  data_type: string;
  udt_name: string;
};

export type BootstrapTableInfo = {
  name: string;
  columns: BootstrapColumnInfo[];
  /** Columns with a FOREIGN KEY to auth.users. */
  auth_user_fk_columns: string[];
  /** Column typed with one of the detected role enums, when present. */
  role_column: { name: string; enum_name: string } | null;
};

export type BootstrapSchemaInfo = {
  /** public.app_role plus any public enum named like %role%, with values. */
  role_enums: BootstrapRoleEnum[];
  /** Values of the primary role enum (public.app_role preferred). */
  roles: string[];
  auth: {
    has_profiles: boolean;
    /** Column shape of public.profiles when present. */
    profiles: BootstrapTableInfo | null;
    profiles_references_auth_users: boolean;
    /** Trigger on auth.users whose function inserts into public.profiles. */
    profile_trigger: string | null;
    /** All non-internal triggers on auth.users. */
    auth_user_triggers: string[];
  };
  admin: {
    platform_admins: BootstrapTableInfo | null;
    admins: BootstrapTableInfo | null;
    user_roles: BootstrapTableInfo | null;
  };
  org: {
    organizations: BootstrapTableInfo | null;
    memberships: BootstrapTableInfo | null;
    /** Trigger on public.organizations whose function inserts memberships. */
    owner_trigger: string | null;
  };
};

export type BootstrapOperationStep =
  | "create-user"
  | "profile-via-trigger"
  | "insert-profile"
  | "insert-platform-admin"
  | "insert-organization"
  | "membership-via-trigger"
  | "insert-membership";

export type BootstrapOperationPreview = {
  step: BootstrapOperationStep;
  detail: string;
  /** Set on plans built without a request: the wizard may toggle this step. */
  optional?: boolean;
};

export type BootstrapPlanInfo = {
  roles: string[];
  has_platform_admins: boolean;
  has_profiles: boolean;
  profile_trigger: string | null;
  org_support: {
    organizations: boolean;
    memberships: boolean;
    owner_trigger: string | null;
  };
  operations: BootstrapOperationPreview[];
  warnings: string[];
};

export type BootstrapResult = {
  user_id: string;
  /** True when the email already existed and the existing user was promoted. */
  user_existed: boolean;
  /** How the profile row came to be: auth trigger, explicit insert, or none. */
  profile: "trigger" | "created" | "none";
  platform_admin: boolean;
  organization: { id: string; slug: string; created: boolean } | null;
  membership: {
    organization_id: string;
    role: string | null;
    status: string | null;
    via_trigger: boolean;
  } | null;
  warnings: string[];
};

// ---- injectable seams ----------------------------------------------------------------

export type BootstrapDbClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void> | void;
};

export type BootstrapDbClientFactory = (dbUrl: string) => Promise<BootstrapDbClient> | BootstrapDbClient;

/** Default factory: `pg` Client against the local stack's db_url. */
const defaultDbClientFactory: BootstrapDbClientFactory = async (dbUrl) => {
  const pgModule = (await import("pg")) as typeof import("pg") & { default?: typeof import("pg") };
  const Client = pgModule.default?.Client ?? pgModule.Client;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  return {
    async query(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params as never);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: () => client.end()
  };
};

let activeDbClientFactory: BootstrapDbClientFactory = defaultDbClientFactory;

/** Test seam: replace the Postgres client factory (pass null to restore `pg`). */
export function setBootstrapDbClient(factory: BootstrapDbClientFactory | null): void {
  activeDbClientFactory = factory ?? defaultDbClientFactory;
}

export type BootstrapHttpResponse = { status: number; body: string };

export type BootstrapHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<BootstrapHttpResponse>;

/** Default HTTP layer: global fetch (Node ≥ 20). */
const defaultHttp: BootstrapHttp = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
};

let activeHttp: BootstrapHttp = defaultHttp;

/** Test seam: replace the Auth admin API HTTP layer (pass null to restore fetch). */
export function setBootstrapHttp(http: BootstrapHttp | null): void {
  activeHttp = http ?? defaultHttp;
}

// ---- guards ----------------------------------------------------------------------------

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Hosts considered "local" for bootstrap targets (spec: never hosted URLs). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1", "[::1]"]);

/**
 * Refuse any bootstrap target whose host is not local. Works for both http(s)
 * api_url values and postgresql:// db_url values.
 */
export function assertLocalBootstrapUrl(url: string, label: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw httpError(`Resource ${label} is not a valid URL — refusing to bootstrap.`, 400);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw httpError(
      `Bootstrap refused: ${label} points at non-local host "${host}". ` +
        "Bootstrap only ever runs against the local Supabase stack (127.0.0.1 / localhost / host.docker.internal).",
      400
    );
  }
  return url;
}

/**
 * Resolve + validate the bootstrap target: must exist, be a supabase resource,
 * have a started stack (ready/running), and carry LOCAL api_url + db_url.
 */
export function requireBootstrapResource(
  ctx: AppContext,
  resourceId: string
): { resource: ManagedResourceRow; apiUrl: string; dbUrl: string } {
  const resource = getResource(ctx, resourceId);
  if (!resource) throw httpError("Resource not found", 404);
  if (resource.profile !== "supabase") {
    throw httpError(
      `Bootstrap is only available for supabase resources (this resource is "${resource.profile}").`,
      400
    );
  }
  if (resource.status !== "ready" && resource.status !== "running") {
    throw httpError(
      `Bootstrap requires a started local Supabase stack (status "ready" or "running"); current status is "${resource.status}".`,
      400
    );
  }
  const config = resourceConfig(resource);
  const apiUrl = typeof config.api_url === "string" ? config.api_url : "";
  const dbUrl = typeof config.db_url === "string" ? config.db_url : "";
  if (!apiUrl || !dbUrl) {
    throw httpError(
      "Resource is missing its local api_url/db_url — re-provision the stack before bootstrapping.",
      400
    );
  }
  assertLocalBootstrapUrl(apiUrl, "api_url");
  assertLocalBootstrapUrl(dbUrl, "db_url");
  return { resource, apiUrl, dbUrl };
}

// ---- introspection -----------------------------------------------------------------------

const TRACKED_TABLES = [
  "profiles",
  "platform_admins",
  "admins",
  "user_roles",
  "organizations",
  "organization_memberships"
];

const ENUM_SQL = `SELECT n.nspname AS enum_schema, t.typname AS enum_name, e.enumlabel AS enum_value
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND (t.typname = 'app_role' OR t.typname ILIKE '%role%')
ORDER BY t.typname, e.enumsortorder`;

const COLUMNS_SQL = `SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = ANY($1)
ORDER BY table_name, ordinal_position`;

const AUTH_FK_SQL = `SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND ccu.table_schema = 'auth' AND ccu.table_name = 'users'`;

const TRIGGER_SQL = `SELECT tg.tgname AS trigger_name, n.nspname AS table_schema, c.relname AS table_name,
  p.proname AS function_name, pg_catalog.pg_get_functiondef(p.oid) AS function_def
FROM pg_catalog.pg_trigger tg
JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
WHERE NOT tg.tgisinternal
  AND ((n.nspname = 'auth' AND c.relname = 'users')
    OR (n.nspname = 'public' AND c.relname = 'organizations'))`;

async function openBootstrapDb(dbUrl: string): Promise<BootstrapDbClient> {
  try {
    return await activeDbClientFactory(dbUrl);
  } catch (error) {
    throw httpError(
      `Could not connect to the local Supabase database: ${error instanceof Error ? error.message : String(error)}. ` +
        "Is the stack running?",
      502
    );
  }
}

/**
 * Inspect the LOCAL Supabase database per the spec's Bootstrap Scanner: role
 * enums, auth/profile linkage, admin tables, org tables, and bootstrap
 * triggers. Refuses non-local targets before touching anything.
 */
export async function introspectBootstrapSchema(
  ctx: AppContext,
  resourceId: string
): Promise<BootstrapSchemaInfo> {
  const { dbUrl } = requireBootstrapResource(ctx, resourceId);
  const client = await openBootstrapDb(dbUrl);
  try {
    const [enumRows, columnRows, fkRows, triggerRows] = [
      (await client.query(ENUM_SQL)).rows,
      (await client.query(COLUMNS_SQL, [TRACKED_TABLES])).rows,
      (await client.query(AUTH_FK_SQL)).rows,
      (await client.query(TRIGGER_SQL)).rows
    ];

    // Role enums, values kept in declaration order.
    const enumsByName = new Map<string, BootstrapRoleEnum>();
    for (const row of enumRows) {
      const name = String(row.enum_name);
      const entry = enumsByName.get(name) ?? {
        schema: String(row.enum_schema ?? "public"),
        name,
        values: []
      };
      entry.values.push(String(row.enum_value));
      enumsByName.set(name, entry);
    }
    const roleEnums = Array.from(enumsByName.values());
    const primaryEnum = enumsByName.get("app_role") ?? roleEnums[0] ?? null;
    const enumNames = new Set(roleEnums.map((e) => e.name));

    // FK columns per table (FKs into auth.users only — see AUTH_FK_SQL).
    const fkByTable = new Map<string, string[]>();
    for (const row of fkRows) {
      const table = String(row.table_name);
      const list = fkByTable.get(table) ?? [];
      list.push(String(row.column_name));
      fkByTable.set(table, list);
    }

    // Column shapes per tracked table.
    const tables = new Map<string, BootstrapTableInfo>();
    for (const row of columnRows) {
      const tableName = String(row.table_name);
      const info = tables.get(tableName) ?? {
        name: tableName,
        columns: [],
        auth_user_fk_columns: fkByTable.get(tableName) ?? [],
        role_column: null
      };
      const column: BootstrapColumnInfo = {
        name: String(row.column_name),
        data_type: String(row.data_type),
        udt_name: String(row.udt_name)
      };
      info.columns.push(column);
      if (!info.role_column && enumNames.has(column.udt_name)) {
        info.role_column = { name: column.name, enum_name: column.udt_name };
      }
      tables.set(tableName, info);
    }

    // Bootstrap triggers — classified by what the trigger function inserts.
    const authUserTriggers: string[] = [];
    let profileTrigger: string | null = null;
    let ownerTrigger: string | null = null;
    for (const row of triggerRows) {
      const name = String(row.trigger_name);
      const tableSchema = String(row.table_schema);
      const tableName = String(row.table_name);
      const def = String(row.function_def ?? "");
      if (tableSchema === "auth" && tableName === "users") {
        authUserTriggers.push(name);
        if (!profileTrigger && /insert\s+into\s+(public\.)?profiles/i.test(def)) {
          profileTrigger = name;
        }
      }
      if (tableSchema === "public" && tableName === "organizations") {
        if (!ownerTrigger && /insert\s+into\s+(public\.)?organization_memberships/i.test(def)) {
          ownerTrigger = name;
        }
      }
    }

    const profiles = tables.get("profiles") ?? null;
    return {
      role_enums: roleEnums,
      roles: primaryEnum?.values ?? [],
      auth: {
        has_profiles: Boolean(profiles),
        profiles,
        profiles_references_auth_users: Boolean(profiles && profiles.auth_user_fk_columns.length > 0),
        profile_trigger: profileTrigger,
        auth_user_triggers: authUserTriggers
      },
      admin: {
        platform_admins: tables.get("platform_admins") ?? null,
        admins: tables.get("admins") ?? null,
        user_roles: tables.get("user_roles") ?? null
      },
      org: {
        organizations: tables.get("organizations") ?? null,
        memberships: tables.get("organization_memberships") ?? null,
        owner_trigger: ownerTrigger
      }
    };
  } finally {
    await client.end();
  }
}

// ---- plan ------------------------------------------------------------------------------------

function hasColumn(table: BootstrapTableInfo | null, name: string): boolean {
  return Boolean(table?.columns.some((column) => column.name === name));
}

/**
 * Wizard-facing plan: detected capabilities plus the ordered operations that
 * `executeBootstrap` would run (spec: "Preview generated operations before
 * execution"). Pure — pass the draft request to narrow the preview to the
 * operator's selections; without a request, selectable steps are marked
 * `optional: true`.
 */
export function buildBootstrapPlan(
  schema: BootstrapSchemaInfo,
  request?: BootstrapRequest
): BootstrapPlanInfo {
  const operations: BootstrapOperationPreview[] = [];
  const warnings: string[] = [];

  operations.push({
    step: "create-user",
    detail: request
      ? `Create local auth user ${request.email} via the local Auth admin API (email confirmed).`
      : "Create the first local auth user via the local Auth admin API (email confirmed)."
  });

  if (schema.auth.profile_trigger) {
    operations.push({
      step: "profile-via-trigger",
      detail: `Trigger "${schema.auth.profile_trigger}" on auth.users creates the public.profiles row automatically.`
    });
  } else if (schema.auth.has_profiles) {
    operations.push({
      step: "insert-profile",
      detail: "Insert into public.profiles explicitly (no auth.users profile trigger detected)."
    });
  } else {
    warnings.push("No public.profiles table detected — the app may not show user metadata.");
  }

  const hasPlatformAdmins = Boolean(schema.admin.platform_admins);
  if (request?.makePlatformAdmin && !hasPlatformAdmins) {
    warnings.push("Platform admin requested but no public.platform_admins table was detected — skipped.");
  } else if (hasPlatformAdmins && (request ? Boolean(request.makePlatformAdmin) : true)) {
    operations.push({
      step: "insert-platform-admin",
      detail: "Insert { user_id } into public.platform_admins.",
      ...(request ? {} : { optional: true })
    });
  }

  const orgSupported = Boolean(schema.org.organizations);
  const wantsOrg = request ? Boolean(request.organization?.create) : orgSupported;
  if (request?.organization?.create && !orgSupported) {
    warnings.push(
      "Organization creation requested but no public.organizations table was detected — skipped."
    );
  } else if (orgSupported && wantsOrg) {
    const optional = request ? {} : { optional: true };
    operations.push({
      step: "insert-organization",
      detail: request?.organization
        ? `Insert organization "${request.organization.name}" (slug "${request.organization.slug}"); an existing slug reuses that organization.`
        : "Insert into public.organizations (name, slug, created_by); an existing slug reuses that organization.",
      ...optional
    });
    if (schema.org.owner_trigger) {
      operations.push({
        step: "membership-via-trigger",
        detail: `Trigger "${schema.org.owner_trigger}" on public.organizations creates the owner membership from created_by.`,
        ...optional
      });
    } else if (schema.org.memberships) {
      operations.push({
        step: "insert-membership",
        detail: `Insert into public.organization_memberships explicitly${
          request?.role ? ` with role "${request.role}"` : " with the chosen role"
        } (no owner trigger detected).`,
        ...optional
      });
    } else {
      warnings.push(
        "public.organizations exists but no membership table or owner trigger was detected — the user may not be attached to the organization."
      );
    }
  }

  if (schema.roles.length === 0) {
    warnings.push("No role enum detected — role selection is unavailable.");
  }
  if (request?.role && schema.roles.length > 0 && !schema.roles.includes(request.role)) {
    warnings.push(`Requested role "${request.role}" is not among the detected roles.`);
  }

  return {
    roles: schema.roles,
    has_platform_admins: hasPlatformAdmins,
    has_profiles: schema.auth.has_profiles,
    profile_trigger: schema.auth.profile_trigger,
    org_support: {
      organizations: orgSupported,
      memberships: Boolean(schema.org.memberships),
      owner_trigger: schema.org.owner_trigger
    },
    operations,
    warnings
  };
}

// ---- execution ----------------------------------------------------------------------------------

function adminHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    "content-type": "application/json"
  };
}

function parseJsonBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body || "null");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function looksLikeExistingEmail(response: BootstrapHttpResponse): boolean {
  const parsed = parseJsonBody(response.body);
  const code = typeof parsed.error_code === "string" ? parsed.error_code : String(parsed.code ?? "");
  const text = `${response.body}`.toLowerCase();
  return (
    code === "email_exists" ||
    (response.status === 422 && (text.includes("already") || text.includes("exists"))) ||
    text.includes("already been registered")
  );
}

/**
 * Create the user through the local Auth admin API; on an existing email,
 * look the user up and promote them instead (spec idempotency).
 */
async function createOrLookupUser(
  apiUrl: string,
  serviceRoleKey: string,
  request: BootstrapRequest,
  warnings: string[]
): Promise<{ userId: string; existed: boolean }> {
  const base = apiUrl.replace(/\/+$/, "");
  const created = await activeHttp(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(serviceRoleKey),
    body: JSON.stringify({
      email: request.email,
      password: request.password,
      email_confirm: true,
      ...(request.fullName ? { user_metadata: { full_name: request.fullName } } : {})
    })
  });
  if (created.status >= 200 && created.status < 300) {
    const parsed = parseJsonBody(created.body);
    const user = (parsed.user && typeof parsed.user === "object" ? parsed.user : parsed) as Record<
      string,
      unknown
    >;
    const userId = typeof user.id === "string" ? user.id : "";
    if (!userId) throw httpError("Auth admin API returned no user id for the created user.", 502);
    return { userId, existed: false };
  }

  if (looksLikeExistingEmail(created)) {
    const lookup = await activeHttp(
      `${base}/auth/v1/admin/users?email=${encodeURIComponent(request.email)}`,
      { method: "GET", headers: adminHeaders(serviceRoleKey) }
    );
    if (lookup.status >= 200 && lookup.status < 300) {
      const parsed = parseJsonBody(lookup.body);
      const users = Array.isArray(parsed.users)
        ? (parsed.users as Record<string, unknown>[])
        : Array.isArray(parsed)
          ? (parsed as unknown as Record<string, unknown>[])
          : [];
      const match = users.find(
        (user) => String(user.email ?? "").toLowerCase() === request.email.toLowerCase()
      );
      if (match && typeof match.id === "string") {
        warnings.push(`user_existed: "${request.email}" already exists — promoting the existing user.`);
        return { userId: match.id, existed: true };
      }
    }
    throw httpError(
      `A user with email "${request.email}" already exists but could not be looked up via the Auth admin API.`,
      409
    );
  }

  // Error bodies from the Auth API never contain the submitted password.
  const detail = created.body.slice(0, 500);
  throw httpError(
    `Auth admin API rejected user creation (HTTP ${created.status})${detail ? `: ${detail}` : ""}`,
    502
  );
}

function emitBootstrapStep(ctx: AppContext, resourceId: string, message: string): void {
  broadcast(ctx, { type: "resource_provisioning", resourceId, step: "bootstrap", message });
}

/**
 * Execute the bootstrap per the spec's wizard Execution section. Introspects
 * first so every operation matches the actual schema; all writes are
 * `ON CONFLICT DO NOTHING` where possible so re-runs stay idempotent.
 */
export async function executeBootstrap(
  ctx: AppContext,
  resourceId: string,
  request: BootstrapRequest
): Promise<BootstrapResult> {
  const { apiUrl, dbUrl } = requireBootstrapResource(ctx, resourceId);
  const schema = await introspectBootstrapSchema(ctx, resourceId);

  if (request.role && schema.roles.length > 0 && !schema.roles.includes(request.role)) {
    throw httpError(`Unknown role "${request.role}" — detected roles: ${schema.roles.join(", ")}.`, 400);
  }
  const serviceRoleKey = getResourceSecret(ctx, resourceId, "SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    throw httpError(
      "Resource has no SUPABASE_SERVICE_ROLE_KEY secret — re-provision the stack before bootstrapping.",
      400
    );
  }

  const warnings: string[] = [];
  emitBootstrapStep(ctx, resourceId, `Creating first local user ${request.email}`);
  const { userId, existed } = await createOrLookupUser(apiUrl, serviceRoleKey, request, warnings);

  let profile: BootstrapResult["profile"] = "none";
  let platformAdmin = false;
  let organization: BootstrapResult["organization"] = null;
  let membership: BootstrapResult["membership"] = null;

  const client = await openBootstrapDb(dbUrl);
  try {
    // Profiles: prefer the auth.users trigger; insert explicitly otherwise.
    if (schema.auth.profile_trigger) {
      profile = "trigger";
    } else if (schema.auth.has_profiles) {
      const columns: string[] = ["id"];
      const values: unknown[] = [userId];
      const profiles = schema.auth.profiles;
      if (hasColumn(profiles, "email")) {
        columns.push("email");
        values.push(request.email);
      }
      if (hasColumn(profiles, "full_name") && request.fullName) {
        columns.push("full_name");
        values.push(request.fullName);
      }
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      await client.query(
        `INSERT INTO public.profiles (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      profile = "created";
    }

    // Platform admin: only when the table exists and the operator selected it.
    if (request.makePlatformAdmin) {
      if (schema.admin.platform_admins) {
        await client.query(
          "INSERT INTO public.platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [userId]
        );
        platformAdmin = true;
      } else {
        warnings.push("Platform admin requested but no public.platform_admins table was detected — skipped.");
      }
    }

    // Organization path.
    if (request.organization?.create) {
      if (!schema.org.organizations) {
        warnings.push(
          "Organization creation requested but no public.organizations table was detected — skipped."
        );
      } else {
        const { name, slug } = request.organization;
        const existing = await client.query("SELECT id FROM public.organizations WHERE slug = $1 LIMIT 1", [
          slug
        ]);
        let orgId: string;
        let orgCreated: boolean;
        const includeCreatedBy = hasColumn(schema.org.organizations, "created_by");
        if (existing.rows[0]?.id != null) {
          orgId = String(existing.rows[0].id);
          orgCreated = false;
          warnings.push(`org_existed: slug "${slug}" already exists — using the existing organization.`);
        } else {
          const columns = includeCreatedBy ? "(name, slug, created_by)" : "(name, slug)";
          const placeholders = includeCreatedBy ? "($1, $2, $3)" : "($1, $2)";
          const params = includeCreatedBy ? [name, slug, userId] : [name, slug];
          const inserted = await client.query(
            `INSERT INTO public.organizations ${columns} VALUES ${placeholders} RETURNING id`,
            params
          );
          orgId = String(inserted.rows[0]?.id ?? "");
          if (!orgId) throw httpError("Organization insert returned no id.", 502);
          orgCreated = true;
        }
        organization = { id: orgId, slug, created: orgCreated };

        // Membership: the owner trigger only fires on a fresh org INSERT with
        // created_by set; otherwise insert the membership explicitly.
        const viaTrigger = orgCreated && includeCreatedBy && Boolean(schema.org.owner_trigger);
        if (viaTrigger) {
          membership = {
            organization_id: orgId,
            role: schema.roles.includes("org_owner") ? "org_owner" : null,
            status: null,
            via_trigger: true
          };
        } else if (schema.org.memberships) {
          const memberships = schema.org.memberships;
          const role =
            request.role && schema.roles.includes(request.role)
              ? request.role
              : schema.roles.includes("org_owner")
                ? "org_owner"
                : null;
          const columns = ["organization_id", "user_id"];
          const values: unknown[] = [orgId, userId];
          if (role && memberships.role_column) {
            columns.push(memberships.role_column.name);
            values.push(role);
          }
          let status: string | null = null;
          if (hasColumn(memberships, "status")) {
            status = "active";
            columns.push("status");
            values.push(status);
          }
          const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
          await client.query(
            `INSERT INTO public.organization_memberships (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            values
          );
          membership = { organization_id: orgId, role, status, via_trigger: false };
        } else {
          warnings.push(
            "No public.organization_memberships table detected — the user was not attached to the organization."
          );
        }
      }
    }
  } finally {
    await client.end();
  }

  emitBootstrapStep(
    ctx,
    resourceId,
    `Bootstrap complete for ${request.email}${warnings.length ? ` (${warnings.length} warning(s))` : ""}`
  );
  return {
    user_id: userId,
    user_existed: existed,
    profile,
    platform_admin: platformAdmin,
    organization,
    membership,
    warnings
  };
}
