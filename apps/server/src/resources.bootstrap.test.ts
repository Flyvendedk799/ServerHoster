import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { gracefulShutdown } from "./services/runtime.js";
import {
  assertLocalBootstrapUrl,
  buildBootstrapPlan,
  executeBootstrap,
  introspectBootstrapSchema,
  setBootstrapDbClient,
  setBootstrapHttp,
  type BootstrapDbClient,
  type BootstrapHttpResponse,
  type BootstrapRequest,
  type BootstrapSchemaInfo
} from "./services/resources/bootstrap.js";
import { createResource } from "./services/resources/lifecycle.js";
import { setResourceSecret } from "./services/resources/secrets.js";

/**
 * Database-Tracker Phase 5 — first user/admin/org bootstrap: live-DB
 * introspection (via the injectable client factory), the pure plan builder,
 * execution through the Auth admin API + control-plane SQL, idempotency for
 * existing emails/slugs, the locality guard, and the two routes.
 *
 * Deterministic by construction: Postgres goes through setBootstrapDbClient,
 * the Auth admin API through setBootstrapHttp. No real database or HTTP.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;

const API_URL = "http://127.0.0.1:54321";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture-service-role-key";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const ORG_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PASSWORD = "very-secret-bootstrap-pass-1";

const APP_ROLES = [
  "super_admin",
  "org_owner",
  "org_admin",
  "compliance_manager",
  "hr_manager",
  "department_manager",
  "employee",
  "auditor_readonly"
];

// ---- canned introspection rows (LearnAI-like schema) -------------------------------

const ENUM_ROWS = APP_ROLES.map((value) => ({
  enum_schema: "public",
  enum_name: "app_role",
  enum_value: value
}));

function columnRow(table: string, column: string, dataType: string, udt = dataType) {
  return { table_name: table, column_name: column, data_type: dataType, udt_name: udt };
}

const COLUMN_ROWS = [
  columnRow("organization_memberships", "id", "uuid"),
  columnRow("organization_memberships", "organization_id", "uuid"),
  columnRow("organization_memberships", "user_id", "uuid"),
  {
    table_name: "organization_memberships",
    column_name: "role",
    data_type: "USER-DEFINED",
    udt_name: "app_role"
  },
  columnRow("organization_memberships", "status", "text"),
  columnRow("organization_memberships", "created_at", "timestamptz"),
  columnRow("organizations", "id", "uuid"),
  columnRow("organizations", "name", "text"),
  columnRow("organizations", "slug", "text"),
  columnRow("organizations", "created_by", "uuid"),
  columnRow("organizations", "created_at", "timestamptz"),
  columnRow("platform_admins", "user_id", "uuid"),
  columnRow("platform_admins", "created_at", "timestamptz"),
  columnRow("profiles", "id", "uuid"),
  columnRow("profiles", "email", "text"),
  columnRow("profiles", "full_name", "text"),
  columnRow("profiles", "created_at", "timestamptz"),
  columnRow("profiles", "updated_at", "timestamptz")
];

const FK_ROWS = [
  { table_name: "profiles", column_name: "id" },
  { table_name: "platform_admins", column_name: "user_id" },
  { table_name: "organizations", column_name: "created_by" },
  { table_name: "organization_memberships", column_name: "user_id" }
];

const TRIGGER_ROWS = [
  {
    trigger_name: "on_auth_user_created",
    table_schema: "auth",
    table_name: "users",
    function_name: "handle_new_user",
    function_def:
      "CREATE OR REPLACE FUNCTION public.handle_new_user() ... begin insert into public.profiles (id, email, full_name) values (new.id, new.email, null); return new; end"
  },
  {
    trigger_name: "on_organization_created",
    table_schema: "public",
    table_name: "organizations",
    function_name: "handle_new_organization",
    function_def:
      "CREATE OR REPLACE FUNCTION public.handle_new_organization() ... begin insert into public.organization_memberships (organization_id, user_id, role) values (new.id, new.created_by, 'org_owner'); return new; end"
  }
];

// ---- seams ---------------------------------------------------------------------------

type ExecutedStatement = { sql: string; params: unknown[] };

type FakeDbOptions = {
  /** Rows returned for the org slug SELECT (default: none → org is new). */
  existingOrgRows?: Record<string, unknown>[];
  /** Drop the org owner trigger / auth profile trigger from introspection. */
  withoutOwnerTrigger?: boolean;
  withoutProfileTrigger?: boolean;
  /** Drop platform_admins (and optionally other tables) from introspection. */
  withoutPlatformAdmins?: boolean;
  /** Reject the connection attempt entirely. */
  failConnect?: boolean;
};

function installFakeDb(options: FakeDbOptions = {}): {
  executed: ExecutedStatement[];
  dbUrls: string[];
  ended: number;
} {
  const state = { executed: [] as ExecutedStatement[], dbUrls: [] as string[], ended: 0 };
  setBootstrapDbClient((dbUrl) => {
    if (options.failConnect) throw new Error("connect ECONNREFUSED 127.0.0.1:54322");
    state.dbUrls.push(dbUrl);
    const client: BootstrapDbClient = {
      async query(sql, params = []) {
        state.executed.push({ sql, params: params as unknown[] });
        if (sql.includes("pg_enum")) return { rows: ENUM_ROWS };
        if (sql.includes("information_schema.columns")) {
          const rows = options.withoutPlatformAdmins
            ? COLUMN_ROWS.filter((row) => row.table_name !== "platform_admins")
            : COLUMN_ROWS;
          return { rows };
        }
        if (sql.includes("FOREIGN KEY")) return { rows: FK_ROWS };
        if (sql.includes("pg_trigger")) {
          let rows = TRIGGER_ROWS;
          if (options.withoutOwnerTrigger) rows = rows.filter((r) => r.table_schema !== "public");
          if (options.withoutProfileTrigger) rows = rows.filter((r) => r.table_schema !== "auth");
          return { rows };
        }
        if (sql.includes("SELECT id FROM public.organizations")) {
          return { rows: options.existingOrgRows ?? [] };
        }
        if (sql.startsWith("INSERT INTO public.organizations")) {
          return { rows: [{ id: ORG_ID }] };
        }
        return { rows: [] };
      },
      end() {
        state.ended += 1;
      }
    };
    return client;
  });
  return state;
}

type HttpCall = { url: string; method: string; headers: Record<string, string>; body?: string };

function installFakeHttp(options: { existingEmail?: boolean } = {}): { calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  setBootstrapHttp(async (url, init): Promise<BootstrapHttpResponse> => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === "POST" && url.endsWith("/auth/v1/admin/users")) {
      if (options.existingEmail) {
        return {
          status: 422,
          body: JSON.stringify({
            code: 422,
            error_code: "email_exists",
            msg: "A user with this email address has already been registered"
          })
        };
      }
      return { status: 200, body: JSON.stringify({ id: USER_ID, email: "first@local.test" }) };
    }
    if (init.method === "GET" && url.includes("/auth/v1/admin/users?email=")) {
      return {
        status: 200,
        body: JSON.stringify({ users: [{ id: USER_ID, email: "first@local.test" }] })
      };
    }
    return { status: 404, body: "not found" };
  });
  return { calls };
}

function restoreSeams(): void {
  setBootstrapDbClient(null);
  setBootstrapHttp(null);
}

function seedSupabaseResource(
  ctx: Ctx,
  overrides: { api_url?: string; db_url?: string; status?: string; profile?: string } = {}
): string {
  const resource = createResource(ctx, {
    name: "learnai-supabase",
    profile: overrides.profile ?? "supabase",
    status: overrides.status ?? "ready",
    config: {
      workdir: "/tmp/learnai",
      api_url: overrides.api_url ?? API_URL,
      studio_url: "http://127.0.0.1:54323",
      db_url: overrides.db_url ?? DB_URL
    }
  });
  setResourceSecret(ctx, resource.id, "SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY, true);
  return resource.id;
}

async function loginToken(ctx: Ctx): Promise<string> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  assert.equal(login.statusCode, 200);
  return login.json().token as string;
}

const FULL_REQUEST: BootstrapRequest = {
  email: "first@local.test",
  password: PASSWORD,
  fullName: "First Local User",
  role: "org_owner",
  makePlatformAdmin: true,
  organization: { create: true, name: "Local Org", slug: "local-org" }
};

// ---- introspection -------------------------------------------------------------------

test("introspectBootstrapSchema: LearnAI shapes — enums, tables, FKs, triggers", async () => {
  const ctx = await buildApp();
  const db = installFakeDb();
  try {
    const resourceId = seedSupabaseResource(ctx);
    const schema = await introspectBootstrapSchema(ctx, resourceId);

    assert.deepEqual(schema.roles, APP_ROLES, "all 8 app_role values in declaration order");
    assert.equal(schema.role_enums.length, 1);
    assert.equal(schema.role_enums[0].name, "app_role");

    assert.equal(schema.auth.has_profiles, true);
    assert.equal(schema.auth.profiles_references_auth_users, true);
    assert.equal(schema.auth.profile_trigger, "on_auth_user_created");
    assert.deepEqual(schema.auth.auth_user_triggers, ["on_auth_user_created"]);

    assert.ok(schema.admin.platform_admins, "platform_admins detected");
    assert.deepEqual(schema.admin.platform_admins?.auth_user_fk_columns, ["user_id"]);
    assert.equal(schema.admin.admins, null);
    assert.equal(schema.admin.user_roles, null);

    assert.ok(schema.org.organizations, "organizations detected");
    assert.ok(schema.org.memberships, "organization_memberships detected");
    assert.deepEqual(schema.org.memberships?.role_column, { name: "role", enum_name: "app_role" });
    assert.equal(schema.org.owner_trigger, "on_organization_created");

    assert.deepEqual(db.dbUrls, [DB_URL], "introspection connects to the resource db_url");
    assert.equal(db.ended, 1, "client closed after introspection");
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("introspectBootstrapSchema: unreachable database → clear 502 error", async () => {
  const ctx = await buildApp();
  installFakeDb({ failConnect: true });
  try {
    const resourceId = seedSupabaseResource(ctx);
    await assert.rejects(
      () => introspectBootstrapSchema(ctx, resourceId),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 502);
        assert.match(error.message, /Could not connect to the local Supabase database/);
        return true;
      }
    );
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

// ---- plan builder (pure) ----------------------------------------------------------------

function learnAiSchema(overrides: Partial<FakeDbOptions> = {}): Promise<BootstrapSchemaInfo> {
  // Build the schema through the real introspection path so plan tests use
  // exactly what production code produces.
  return (async () => {
    const ctx = await buildApp();
    installFakeDb(overrides);
    try {
      const resourceId = seedSupabaseResource(ctx);
      return await introspectBootstrapSchema(ctx, resourceId);
    } finally {
      restoreSeams();
      await gracefulShutdown(ctx);
    }
  })();
}

test("buildBootstrapPlan: full LearnAI schema → trigger-driven operations", async () => {
  const schema = await learnAiSchema();
  const plan = buildBootstrapPlan(schema);

  assert.deepEqual(plan.roles, APP_ROLES);
  assert.equal(plan.has_platform_admins, true);
  assert.equal(plan.has_profiles, true);
  assert.equal(plan.profile_trigger, "on_auth_user_created");
  assert.deepEqual(plan.org_support, {
    organizations: true,
    memberships: true,
    owner_trigger: "on_organization_created"
  });

  const steps = plan.operations.map((op) => op.step);
  assert.deepEqual(steps, [
    "create-user",
    "profile-via-trigger",
    "insert-platform-admin",
    "insert-organization",
    "membership-via-trigger"
  ]);
  // Without a request, selectable steps are marked optional for the wizard.
  assert.equal(plan.operations.find((op) => op.step === "insert-platform-admin")?.optional, true);
  assert.equal(plan.operations.find((op) => op.step === "create-user")?.optional, undefined);
  assert.deepEqual(plan.warnings, []);

  // With a full request the selections are firm (no optional flags).
  const requested = buildBootstrapPlan(schema, FULL_REQUEST);
  assert.ok(requested.operations.every((op) => op.optional === undefined));
  assert.match(
    requested.operations.find((op) => op.step === "insert-organization")?.detail ?? "",
    /local-org/
  );
});

test("buildBootstrapPlan: no org trigger → explicit membership insert", async () => {
  const schema = await learnAiSchema({ withoutOwnerTrigger: true });
  const plan = buildBootstrapPlan(schema, FULL_REQUEST);
  const steps = plan.operations.map((op) => op.step);
  assert.ok(steps.includes("insert-membership"), `steps: ${steps}`);
  assert.ok(!steps.includes("membership-via-trigger"));
  assert.match(plan.operations.find((op) => op.step === "insert-membership")?.detail ?? "", /org_owner/);
});

test("buildBootstrapPlan: no platform_admins table → option absent / warned", async () => {
  const schema = await learnAiSchema({ withoutPlatformAdmins: true });

  const plan = buildBootstrapPlan(schema);
  assert.equal(plan.has_platform_admins, false);
  assert.ok(!plan.operations.some((op) => op.step === "insert-platform-admin"));

  // Explicitly requesting it surfaces a warning instead of an operation.
  const requested = buildBootstrapPlan(schema, FULL_REQUEST);
  assert.ok(!requested.operations.some((op) => op.step === "insert-platform-admin"));
  assert.ok(requested.warnings.some((w) => w.includes("platform_admins")));
});

test("buildBootstrapPlan: no profile trigger → explicit profile insert; unknown role warns", async () => {
  const schema = await learnAiSchema({ withoutProfileTrigger: true });
  const plan = buildBootstrapPlan(schema, { ...FULL_REQUEST, role: "galactic_emperor" });
  const steps = plan.operations.map((op) => op.step);
  assert.ok(steps.includes("insert-profile"));
  assert.ok(!steps.includes("profile-via-trigger"));
  assert.ok(plan.warnings.some((w) => w.includes("galactic_emperor")));
});

// ---- execution ------------------------------------------------------------------------------

test("executeBootstrap: happy path — admin API + platform admin + org via trigger", async () => {
  const ctx = await buildApp();
  const db = installFakeDb();
  const http = installFakeHttp();
  try {
    const resourceId = seedSupabaseResource(ctx);
    const result = await executeBootstrap(ctx, resourceId, FULL_REQUEST);

    // Auth admin API call with service-role headers and confirmed email.
    const createCall = http.calls.find((call) => call.method === "POST");
    assert.ok(createCall, "admin create-user call made");
    assert.equal(createCall.url, `${API_URL}/auth/v1/admin/users`);
    assert.equal(createCall.headers.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
    assert.equal(createCall.headers.apikey, SERVICE_ROLE_KEY);
    const payload = JSON.parse(createCall.body ?? "{}") as Record<string, unknown>;
    assert.equal(payload.email, "first@local.test");
    assert.equal(payload.email_confirm, true);
    assert.deepEqual(payload.user_metadata, { full_name: "First Local User" });

    // platform_admins insert executed.
    const adminInsert = db.executed.find((s) => s.sql.includes("public.platform_admins"));
    assert.ok(adminInsert, "platform_admins insert executed");
    assert.deepEqual(adminInsert.params, [USER_ID]);

    // organizations insert executed; membership left to the DB trigger.
    const orgInsert = db.executed.find((s) => s.sql.startsWith("INSERT INTO public.organizations"));
    assert.ok(orgInsert, "organizations insert executed");
    assert.deepEqual(orgInsert.params, ["Local Org", "local-org", USER_ID]);
    assert.ok(
      !db.executed.some((s) => s.sql.includes("organization_memberships")),
      "membership NOT manually inserted when the owner trigger handles it"
    );
    // Profile left to the auth.users trigger.
    assert.ok(!db.executed.some((s) => s.sql.includes("public.profiles")));

    assert.deepEqual(result, {
      user_id: USER_ID,
      user_existed: false,
      profile: "trigger",
      platform_admin: true,
      organization: { id: ORG_ID, slug: "local-org", created: true },
      membership: { organization_id: ORG_ID, role: "org_owner", status: null, via_trigger: true },
      warnings: []
    });
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("executeBootstrap: no triggers → explicit profile + membership inserts with role/status", async () => {
  const ctx = await buildApp();
  const db = installFakeDb({ withoutOwnerTrigger: true, withoutProfileTrigger: true });
  installFakeHttp();
  try {
    const resourceId = seedSupabaseResource(ctx);
    const result = await executeBootstrap(ctx, resourceId, FULL_REQUEST);

    const profileInsert = db.executed.find((s) => s.sql.includes("public.profiles"));
    assert.ok(profileInsert, "explicit profile insert");
    assert.match(profileInsert.sql, /ON CONFLICT \(id\) DO NOTHING/);
    assert.deepEqual(profileInsert.params, [USER_ID, "first@local.test", "First Local User"]);

    const membershipInsert = db.executed.find((s) => s.sql.includes("organization_memberships"));
    assert.ok(membershipInsert, "explicit membership insert");
    assert.match(membershipInsert.sql, /\(organization_id, user_id, role, status\)/);
    assert.deepEqual(membershipInsert.params, [ORG_ID, USER_ID, "org_owner", "active"]);

    assert.equal(result.profile, "created");
    assert.deepEqual(result.membership, {
      organization_id: ORG_ID,
      role: "org_owner",
      status: "active",
      via_trigger: false
    });
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("executeBootstrap: existing email → lookup + promote with user_existed warning", async () => {
  const ctx = await buildApp();
  const db = installFakeDb();
  const http = installFakeHttp({ existingEmail: true });
  try {
    const resourceId = seedSupabaseResource(ctx);
    const result = await executeBootstrap(ctx, resourceId, FULL_REQUEST);

    const lookup = http.calls.find((call) => call.method === "GET");
    assert.ok(lookup, "lookup call made");
    assert.equal(
      lookup.url,
      `${API_URL}/auth/v1/admin/users?email=${encodeURIComponent("first@local.test")}`
    );

    assert.equal(result.user_id, USER_ID);
    assert.equal(result.user_existed, true);
    assert.ok(result.warnings.some((w) => w.includes("user_existed")));
    // Promotion still runs the admin/org steps.
    assert.ok(db.executed.some((s) => s.sql.includes("public.platform_admins")));
    assert.equal(result.platform_admin, true);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("executeBootstrap: existing org slug → use existing org, explicit membership, org_existed warning", async () => {
  const ctx = await buildApp();
  const db = installFakeDb({ existingOrgRows: [{ id: ORG_ID }] });
  installFakeHttp();
  try {
    const resourceId = seedSupabaseResource(ctx);
    const result = await executeBootstrap(ctx, resourceId, FULL_REQUEST);

    assert.ok(
      !db.executed.some((s) => s.sql.startsWith("INSERT INTO public.organizations")),
      "no duplicate organization insert"
    );
    // Trigger only fires on INSERT — existing orgs need the explicit membership.
    const membershipInsert = db.executed.find((s) => s.sql.includes("organization_memberships"));
    assert.ok(membershipInsert, "membership inserted explicitly for the existing org");
    assert.deepEqual(result.organization, { id: ORG_ID, slug: "local-org", created: false });
    assert.equal(result.membership?.via_trigger, false);
    assert.ok(result.warnings.some((w) => w.includes("org_existed")));
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("executeBootstrap: unknown role → 400 before any side effect", async () => {
  const ctx = await buildApp();
  installFakeDb();
  const http = installFakeHttp();
  try {
    const resourceId = seedSupabaseResource(ctx);
    await assert.rejects(
      () => executeBootstrap(ctx, resourceId, { ...FULL_REQUEST, role: "galactic_emperor" }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /Unknown role "galactic_emperor"/);
        return true;
      }
    );
    assert.equal(http.calls.length, 0, "no auth API call for an invalid role");
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

// ---- locality guard ---------------------------------------------------------------------------

test("locality guard: non-local api_url/db_url refused by plan and execute", async () => {
  const ctx = await buildApp();
  installFakeDb();
  const http = installFakeHttp();
  try {
    assert.doesNotThrow(() => assertLocalBootstrapUrl("http://host.docker.internal:54321", "api_url"));
    assert.throws(() => assertLocalBootstrapUrl("https://abc.supabase.co", "api_url"));

    const hostedApi = seedSupabaseResource(ctx, { api_url: "https://abcdef.supabase.co" });
    const hostedDb = seedSupabaseResource(ctx, {
      db_url: "postgresql://postgres:secret@db.abcdef.supabase.co:5432/postgres"
    });
    for (const resourceId of [hostedApi, hostedDb]) {
      await assert.rejects(
        () => introspectBootstrapSchema(ctx, resourceId),
        (error: Error & { statusCode?: number }) => {
          assert.equal(error.statusCode, 400);
          assert.match(error.message, /non-local host/);
          return true;
        }
      );
      await assert.rejects(
        () => executeBootstrap(ctx, resourceId, FULL_REQUEST),
        (error: Error & { statusCode?: number }) => {
          assert.equal(error.statusCode, 400);
          assert.match(error.message, /non-local host/);
          return true;
        }
      );
    }
    assert.equal(http.calls.length, 0, "no HTTP call ever leaves for a hosted target");
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

// ---- routes ----------------------------------------------------------------------------------

test("routes: bootstrap plan endpoint shape + guards", async () => {
  const ctx = await buildApp();
  installFakeDb();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const resourceId = seedSupabaseResource(ctx);

    const plan = await ctx.app.inject({
      method: "GET",
      url: `/resources/${resourceId}/bootstrap/plan`,
      headers: auth
    });
    assert.equal(plan.statusCode, 200, plan.body);
    const body = plan.json() as {
      resource_id: string;
      resource_name: string;
      api_url: string;
      schema: { roles: string[] };
      plan: { roles: string[]; operations: Array<{ step: string; detail: string }> };
    };
    assert.equal(body.resource_id, resourceId);
    assert.equal(body.resource_name, "learnai-supabase");
    assert.equal(body.api_url, API_URL);
    assert.ok(!plan.body.includes(DB_URL), "db_url never leaves the control plane");
    assert.deepEqual(body.schema.roles, APP_ROLES);
    assert.equal(body.plan.operations[0]?.step, "create-user");

    // 404 unknown resource.
    const missing = await ctx.app.inject({
      method: "GET",
      url: "/resources/nope/bootstrap/plan",
      headers: auth
    });
    assert.equal(missing.statusCode, 404);

    // 400 non-supabase profile.
    const pgResource = seedSupabaseResource(ctx, { profile: "postgres" });
    const wrongProfile = await ctx.app.inject({
      method: "GET",
      url: `/resources/${pgResource}/bootstrap/plan`,
      headers: auth
    });
    assert.equal(wrongProfile.statusCode, 400);

    // 400 not-ready resource.
    const stopped = seedSupabaseResource(ctx, { status: "stopped" });
    const notReady = await ctx.app.inject({
      method: "GET",
      url: `/resources/${stopped}/bootstrap/plan`,
      headers: auth
    });
    assert.equal(notReady.statusCode, 400);
    assert.match(notReady.json().error as string, /status/);
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("routes: POST bootstrap success — result shape, no password anywhere", async () => {
  const ctx = await buildApp();
  installFakeDb();
  installFakeHttp();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const resourceId = seedSupabaseResource(ctx);

    const response = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/bootstrap`,
      headers: auth,
      payload: FULL_REQUEST
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json() as { user_id: string; platform_admin: boolean };
    assert.equal(result.user_id, USER_ID);
    assert.equal(result.platform_admin, true);
    assert.ok(!response.body.includes(PASSWORD), "password never echoed in the response");

    // Audit logging covers the bootstrap call — without the password.
    const auditRows = ctx.db
      .prepare("SELECT action, details FROM audit_logs WHERE action = ?")
      .all(`POST /resources/${resourceId}/bootstrap`) as Array<{ action: string; details: string }>;
    assert.equal(auditRows.length, 1, "bootstrap call audit-logged");
    const allAudit = ctx.db.prepare("SELECT action || ' ' || details AS row FROM audit_logs").all() as Array<{
      row: string;
    }>;
    assert.ok(
      allAudit.every((entry) => !entry.row.includes(PASSWORD)),
      "password never lands in audit logs"
    );
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});

test("routes: POST bootstrap validation — missing password, unknown role", async () => {
  const ctx = await buildApp();
  installFakeDb();
  const http = installFakeHttp();
  try {
    const token = await loginToken(ctx);
    const auth = { authorization: `Bearer ${token}` };
    const resourceId = seedSupabaseResource(ctx);

    const missingPassword = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/bootstrap`,
      headers: auth,
      payload: { email: "first@local.test" }
    });
    assert.equal(missingPassword.statusCode, 400);
    assert.equal(missingPassword.json().error, "Validation failed");

    const badRole = await ctx.app.inject({
      method: "POST",
      url: `/resources/${resourceId}/bootstrap`,
      headers: auth,
      payload: { ...FULL_REQUEST, role: "galactic_emperor" }
    });
    assert.equal(badRole.statusCode, 400);
    assert.match(badRole.json().error as string, /Unknown role/);
    assert.equal(http.calls.length, 0, "no auth API traffic for rejected requests");
  } finally {
    restoreSeams();
    await gracefulShutdown(ctx);
  }
});
