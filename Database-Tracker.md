# Database-Tracker.md

> Goal: make ServerHoster/LocalSURV dependency-aware instead of assuming every app needs a plain `DATABASE_URL`.
> Supabase apps should be offered a local Supabase stack with schema-only migration, local Edge Functions, local secrets, and first-user bootstrap.
> Plain Postgres/MySQL/Redis/Mongo flows must keep working.

## Product Outcome

When a service is scanned, ServerHoster should infer the backend contract it actually uses and offer the correct local resource:

- Direct Postgres/Prisma/Drizzle/`pg` apps: provision managed Postgres and inject `DATABASE_URL`.
- Supabase apps: provision local Supabase, apply migrations, serve functions, inject `VITE_SUPABASE_URL` and keys, then optionally create the first local user/org/admin.
- Redis/MySQL/Mongo apps: keep the existing managed database flow, extended through the same resource model.
- Unknown apps: show detected signals and let the operator choose a provisioning profile manually.

For LearnAI-like apps, the expected flow is:

1. Detect `@supabase/supabase-js`, `supabase/migrations`, `supabase/functions`, and `VITE_SUPABASE_*`.
2. Offer `Add Local Supabase`, not `Add Postgres`.
3. Start a local Supabase stack.
4. Apply schema migrations only, with an explicit option to run seed files.
5. Serve Edge Functions locally where possible.
6. Generate local Supabase keys and project secrets.
7. Ask for optional external provider secrets, or let the user mark those features disabled for local use.
8. Inject local frontend/function env vars.
9. Restart/rebuild the service.
10. Offer a bootstrap wizard for first local user, platform admin, organization, and role assignment based on actual schema introspection.

## Non-Goals

- Do not silently migrate hosted Supabase data.
- Do not silently copy production Auth users, password hashes, storage files, or function secrets.
- Do not remove the current one-click Postgres path.
- Do not expose generated service role keys or database passwords in normal API responses.
- Do not require a hosted Supabase project for local Supabase provisioning.

## Current Code Touchpoints

- `apps/server/src/services/codeScan.ts`: currently scans package manifests for DB drivers.
- `apps/server/src/services/envScan.ts`: scans env var requirements and reports missing/present state.
- `apps/server/src/services/embeddedDatabases.ts`: lists services with no `DATABASE_URL` and embedded SQLite.
- `apps/server/src/routes/databases.ts`: creates DB containers, promotes embedded SQLite, links services.
- `apps/server/src/services/databases.ts`: database connection strings, backup/restore, table preview, transfers.
- `apps/server/src/services/runtime.ts`: merges project env, linked DB `DATABASE_URL`, service env, and `DATA_DIR`.
- `apps/server/src/services/deploy.ts`: builds services with the same effective env used at runtime.
- `apps/web/src/pages/Services.tsx`: shows stack cards and one-click `Add Postgres`.
- `apps/web/src/pages/Databases.tsx`: database list, embedded persistence, provisioning, seed, backup, table browser.
- `apps/web/src/components/ServiceSettingsModal.tsx`: manual linked database selection.
- `apps/server/src/db.ts`: control-plane SQLite schema migrations.
- `packages/shared/src/types.ts`: shared type surface for services/resources.

## Target Architecture

### 1. Resource Profiles

Introduce a provisioning profile abstraction. A profile describes how to detect, provision, link, healthcheck, backup, and remove a local dependency.

New server module layout:

```text
apps/server/src/services/resources/
  profiles.ts
  scan.ts
  runtimeEnv.ts
  lifecycle.ts
  secrets.ts
  bootstrap.ts
  profiles/
    postgres.ts
    supabase.ts
    redis.ts
```

Initial profile contract:

```ts
export type ResourceProfileId = "postgres" | "supabase" | "redis" | "mysql" | "mongo" | "manual";

export type DetectionSignal = {
  kind: "package" | "file" | "env" | "migration" | "function" | "code";
  value: string;
  source_file: string;
  confidence: "high" | "medium" | "low";
};

export type ProvisionPlan = {
  profile: ResourceProfileId;
  service_id: string;
  project_id: string | null;
  confidence: "high" | "medium" | "low";
  signals: DetectionSignal[];
  actions: Array<{
    id: string;
    label: string;
    risk: "safe" | "destructive" | "external";
    default_enabled: boolean;
  }>;
  env: {
    generated: string[];
    required_user_input: string[];
    optional_user_input: string[];
    injected: string[];
  };
};

export type ResourceProfile = {
  id: ResourceProfileId;
  label: string;
  detect(servicePath: string): DetectionSignal[];
  plan(ctx: AppContext, serviceId: string): Promise<ProvisionPlan>;
  provision(ctx: AppContext, input: ProvisionInput): Promise<ManagedResourceRow>;
  status(ctx: AppContext, resourceId: string): Promise<ResourceStatus>;
  env(ctx: AppContext, resourceId: string, serviceId: string): Promise<Record<string, string>>;
  remove(ctx: AppContext, resourceId: string): Promise<void>;
};
```

Keep the existing database engine code under the Postgres/MySQL/Redis/Mongo profiles first. Supabase becomes the first rich profile.

### 2. Control-Plane Schema

Keep `databases` and `services.linked_database_id` for backward compatibility, but add a generic resource layer.

Add to `apps/server/src/db.ts` startup migrations:

```sql
CREATE TABLE IF NOT EXISTS managed_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  ports_json TEXT NOT NULL DEFAULT '{}',
  containers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_secrets (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_generated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(resource_id, key)
);

CREATE TABLE IF NOT EXISTS service_resource_links (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  env_map_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, resource_id)
);

CREATE TABLE IF NOT EXISTS dependency_scans (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  confidence TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  env_requirements_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_resources_project ON managed_resources(project_id);
CREATE INDEX IF NOT EXISTS idx_service_resource_links_service ON service_resource_links(service_id);
CREATE INDEX IF NOT EXISTS idx_dependency_scans_service ON dependency_scans(service_id, created_at DESC);
```

Secret storage:

- Use the same AES-256-GCM path as `env_vars` and encrypted `settings`.
- `resource_secrets.value` is always encrypted.
- API responses return `value_preview` only.

Backward compatibility:

- A Postgres resource can still insert/update a `databases` row and `services.linked_database_id`.
- New runtime env injection reads `service_resource_links` first, then preserves current `linked_database_id` behavior.
- Existing backup/restore/table preview screens continue to work for primitive database resources.

### 3. Resource-Aware Env Injection

Extend `getServiceEnvWithLinks` in `apps/server/src/services/runtime.ts`:

Current precedence:

```text
project env -> linked DATABASE_URL -> DATA_DIR -> service env
```

New precedence:

```text
project env -> active resource links -> legacy linked DATABASE_URL -> DATA_DIR -> service env
```

Rules:

- Service-level env always wins.
- Resource-provided env is system-managed.
- Generated local Supabase values include:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `APP_URL` when the service has a local/public URL
- For Vite apps, injected `VITE_*` vars must be present during both build and runtime/dev start.
- Use existing deploy env path in `apps/server/src/services/deploy.ts`; do not create a separate env merge path.

## Supabase Profile Technical Plan

### Detection

Add Supabase detection in `apps/server/src/services/resources/profiles/supabase.ts`.

High-confidence signals:

- `package.json` dependency `@supabase/supabase-js`.
- `supabase/config.toml`.
- `supabase/migrations/*.sql`.
- `supabase/functions/*/index.ts`.
- source code imports from `@/integrations/supabase/client` or calls `createClient`.
- env keys:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`

Scoring:

- `high`: package dependency plus migrations or config.
- `medium`: package dependency plus env usage.
- `low`: env usage only.

UI copy must say `Local Supabase`, not `Postgres`, for high/medium Supabase scans.

### Provisioning Method

Use Docker-backed local Supabase. The first implementation should use the official Supabase CLI when available because it owns the local stack contract.

Preflight:

- Verify Docker is reachable using existing Docker availability handling.
- Check `supabase --version`.
- If missing, show setup instructions and optionally install via platform-specific command later. Do not block other resource profiles.
- Verify service working directory contains `supabase/config.toml` or can initialize one after confirmation.

Provision flow:

1. Create `managed_resources` row with `profile='supabase'` and `status='provisioning'`.
2. Generate/persist resource secrets:
   - JWT secret if not provided by the local stack.
   - anon key and service role key from `supabase status`, or generated according to Supabase local config if the stack is created by ServerHoster.
   - `AI_KEY_ENCRYPTION_KEY` when detected and missing.
3. Run local stack start from service working dir:
   - Prefer `supabase start`.
   - Record ports from `supabase status` output.
   - Store container names/ids in `containers_json`.
4. Apply migrations in schema-only mode:
   - Prefer the CLI migration path that records migration state.
   - Do not run hosted data imports.
   - Do not run seeds unless user selects `Run seed data`.
5. Serve Edge Functions locally when `supabase/functions` exists:
   - Start `supabase functions serve` as a managed background runtime attached to the resource, or use the local stack's edge runtime if CLI exposes it.
   - Use generated env file under `$SURVHUB_DATA_DIR/resources/<resourceId>/supabase/.env`.
   - Record process/container identity in `managed_resources`.
6. Create/update `service_resource_links` for the app service.
7. Inject local Supabase env values as system-managed resource env.
8. Restart or redeploy the service, depending on service type:
   - process/dev services: restart is enough.
   - static/Vite production builds: rebuild/redeploy because `VITE_*` is baked at build time.

Data behavior:

- Default is schema-only.
- Hosted data import is a separate future action and must require explicit credentials and confirmation.
- Auth starts empty.
- Storage buckets are created only if migrations or Supabase config define them. Otherwise surface missing buckets in diagnostics.

### Local Function Secrets

Extend `envScan.ts` or add `resources/secrets.ts` to scan:

- `Deno.env.get("KEY")`
- `Deno.env.get('KEY')`
- `process.env.KEY`
- `import.meta.env.KEY`

Classify keys:

- Auto-generated:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `AI_KEY_ENCRYPTION_KEY`
  - `APP_URL`
- Optional external:
  - `LOVABLE_API_KEY`
  - `OPENAI_API_KEY`
  - `RESEND_API_KEY`
  - `SENDGRID_API_KEY`
  - `STRIPE_*`
  - any unknown `*_API_KEY`, `*_SECRET`, `*_TOKEN`
- Infrastructure-provided:
  - local DB URL for Supabase internals, not exposed to frontend by default.

UI states:

- `Generated`: ServerHoster created it.
- `Provided`: user pasted it.
- `Missing optional`: feature may fail locally.
- `Disabled locally`: user intentionally disabled it.
- `Required missing`: cannot serve affected function until resolved.

Runtime behavior for missing optional secrets:

- Do not fail local Supabase provisioning.
- Mark affected functions as degraded.
- Show which files reference the missing key.
- Logs should point to the exact missing secret.

## First User and Role Bootstrap

### Bootstrap Scanner

After migrations apply, introspect the local Supabase database, not only files.

Queries should inspect:

- enum values:
  - `public.app_role`
  - any enum with `%role%`
- auth linkage:
  - `public.profiles` referencing `auth.users`
  - triggers on `auth.users`
- admin tables:
  - `public.platform_admins`
  - `public.admins`
  - `public.user_roles`
- org tables:
  - `public.organizations`
  - `public.organization_memberships`
  - foreign keys to `auth.users`
  - role columns using detected role enum
- bootstrap triggers:
  - organization insert triggers that create owner memberships
  - auth user triggers that create profiles

For LearnAI, expected detection should find:

- enum `public.app_role`: `super_admin`, `org_owner`, `org_admin`, `compliance_manager`, `hr_manager`, `department_manager`, `employee`, `auditor_readonly`
- table `public.platform_admins`
- table `public.organization_memberships`
- table `public.organizations`
- trigger `on_auth_user_created`
- organization insert trigger that creates `org_owner` membership from `organizations.created_by`

### Bootstrap Wizard

UI flow:

1. Email and password for first local user.
2. Full name.
3. Role selector from detected roles.
4. Optional `Make platform admin` if `platform_admins` exists.
5. Optional `Create organization` if org tables exist.
6. Organization name/slug when needed.
7. Preview generated operations before execution.

Execution:

- Create user through local Supabase Auth admin API using service role key.
- Let `auth.users` trigger create `profiles` when available.
- If trigger is absent and `profiles` is detected, insert profile explicitly.
- If `platform_admins` exists and selected, insert `{ user_id }`.
- If organization path is selected:
  - Prefer inserting `organizations(name, slug, created_by)` and let DB trigger create owner membership.
  - If no trigger is detected, insert `organization_memberships` explicitly with chosen role/status.
- Use service role context or direct Postgres superuser connection only from the control plane.
- Return a structured result with inserted row IDs and warnings.

Safety:

- Never infer production credentials.
- Never run bootstrap against a hosted Supabase URL through this flow.
- Always show target resource name and local URL.
- Bootstrap operation must be idempotent where possible:
  - Existing user email should offer `promote existing user`.
  - Existing org slug should offer `use existing organization`.

## API Plan

Add routes under `apps/server/src/routes/resources.ts` and register in `apps/server/src/app.ts`.

Routes:

```text
GET    /resources/profiles
GET    /resources/scans
GET    /resources/scans/:serviceId
POST   /resources/scans/:serviceId/run
POST   /resources/provision
GET    /resources
GET    /resources/:id
POST   /resources/:id/start
POST   /resources/:id/stop
POST   /resources/:id/restart
DELETE /resources/:id
GET    /resources/:id/logs
GET    /resources/:id/env-requirements
POST   /resources/:id/secrets
POST   /resources/:id/link
POST   /resources/:id/unlink
GET    /resources/:id/bootstrap/plan
POST   /resources/:id/bootstrap
```

Request examples:

```ts
type ProvisionRequest = {
  serviceId: string;
  profile: "supabase" | "postgres" | "redis" | "mysql" | "mongo" | "manual";
  mode: "schema-only" | "schema-and-seed" | "empty";
  restart: boolean;
  secrets?: Record<string, string>;
  disabledSecrets?: string[];
};
```

```ts
type BootstrapRequest = {
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
```

Existing database routes:

- Keep `/databases/*`.
- Move shared primitive DB creation logic behind the `postgres/mysql/redis/mongo` profile.
- `POST /databases/embedded/:serviceId/promote` remains as compatibility wrapper that calls the Postgres profile.

## UI Plan

### Services Page

Replace the generic `Add database` prompt with dependency-aware cards.

States:

- `Supabase detected`: primary action `Add Local Supabase`.
- `Postgres driver detected`: primary action `Add Postgres`.
- `SQLite detected`: primary action `Promote data`.
- `No dependency detected`: hide database prompt by default.
- `Multiple dependencies`: show a compact dependency list.

For LearnAI-like projects, card copy should say:

```text
Supabase app detected
Run a local Supabase stack from this repo's migrations. No hosted data will be copied.
```

Actions:

- `Add Local Supabase`
- `Review requirements`
- `Use hosted Supabase`
- `Use plain Postgres anyway` as an escape hatch

### New Resource Provision Modal

Steps:

1. Detection summary.
2. Provisioning mode:
   - `Schema only` default for Supabase.
   - `Schema + seed` optional.
   - `Empty stack` advanced.
3. Local secrets:
   - auto-generated list.
   - user-input list.
   - optional missing list.
4. Edge Functions:
   - detected functions.
   - missing secrets per function.
   - serve enabled/disabled.
5. Bootstrap:
   - optional first user/admin/org.
6. Confirm and run.

### Databases Page

Keep primitive DB management as-is.

Add a `Resources` or `Stacks` section for rich profiles:

- Supabase stack status.
- Local API URL.
- Studio URL when available.
- linked services.
- migration state.
- Edge Function status.
- missing/degraded secrets.

Do not show Supabase as a simple Postgres database unless the user drills into internal details.

## Implementation Phases

### Phase 0 - Guardrails and Tests Around Current Behavior

- [ ] Add tests proving existing Postgres provisioning/linking still injects `DATABASE_URL`.
- [ ] Add tests proving service-level `DATABASE_URL` overrides linked DB injection.
- [ ] Add tests for `codeScan.ts` current DB driver detection.
- [ ] Add regression test for a Supabase-only frontend: it must not be labeled as plain Postgres-only.
- [ ] Document current LearnAI behavior as a fixture: Supabase client plus migrations should produce Supabase profile recommendation.

Exit criteria:

- Current database functionality has a baseline safety net before abstraction work starts.

### Phase 1 - Generic Resource Schema and Runtime Env Injection

- [ ] Add `managed_resources`, `resource_secrets`, `service_resource_links`, and `dependency_scans` tables.
- [ ] Implement encrypted `resource_secrets` helper.
- [ ] Implement `resources/profiles.ts` registry.
- [ ] Implement `resources/runtimeEnv.ts` and integrate with `getServiceEnvWithLinks`.
- [ ] Keep legacy `linked_database_id` path working.
- [ ] Add API types to `packages/shared/src/types.ts`.
- [ ] Add tests for env precedence:
  - project env
  - resource env
  - legacy linked DB env
  - service env override
  - `DATA_DIR`

Exit criteria:

- A mock resource can inject env into build/runtime without touching the old DB flow.

### Phase 2 - Supabase Detection and Planning

- [ ] Extend scan logic to emit `ProvisionPlan` objects.
- [ ] Detect Supabase package/config/migrations/functions/env keys.
- [ ] Detect Supabase function env requirements from `Deno.env.get`.
- [ ] Persist scan snapshots in `dependency_scans`.
- [ ] Add `GET /resources/scans/:serviceId` and `POST /resources/scans/:serviceId/run`.
- [ ] Update Services UI to show `Add Local Supabase` for high-confidence Supabase apps.
- [ ] Add tests with LearnAI-like fixture:
  - `@supabase/supabase-js`
  - `supabase/migrations`
  - `supabase/functions`
  - `VITE_SUPABASE_*`

Exit criteria:

- LearnAI-like services are no longer offered only `Add Postgres`.

### Phase 3 - Supabase Local Stack Provisioning

- [ ] Implement Supabase CLI preflight.
- [ ] Implement `supabase start` orchestration from service working dir.
- [ ] Parse `supabase status` for API URL, anon key, service role key, DB URL, Studio URL, and ports.
- [ ] Persist resource config, ports, containers, and generated secrets.
- [ ] Implement schema-only migration apply.
- [ ] Implement `schema-and-seed` option separately.
- [ ] Link resource to service and inject:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Restart or redeploy the service based on service type.
- [ ] Add logs and websocket lifecycle events.
- [ ] Add cleanup path for failed provisioning.

Exit criteria:

- A fresh Supabase app with migrations can run locally without hosted Supabase and without hosted data import.

### Phase 4 - Edge Functions and Secrets

- [ ] Scan `supabase/functions/*` and list functions.
- [ ] Generate local function env file under `$SURVHUB_DATA_DIR/resources/<resourceId>/`.
- [ ] Start local function serving as a resource-managed process or CLI-managed stack component.
- [ ] Surface function logs in `/resources/:id/logs`.
- [ ] Add secret classification UI:
  - generated
  - provided
  - optional missing
  - disabled locally
  - required missing
- [ ] Allow updating resource secrets via `POST /resources/:id/secrets`.
- [ ] Mark functions degraded when optional/external secrets are missing.
- [ ] Add tests for `Deno.env.get` scanning and secret classification.

Exit criteria:

- Local functions can run with generated Supabase keys and user-provided optional provider keys.

### Phase 5 - First User/Admin/Org Bootstrap

- [ ] Implement DB introspection for auth/profile/role/org/admin schema.
- [ ] Add `GET /resources/:id/bootstrap/plan`.
- [ ] Add Bootstrap UI step in the provision modal.
- [ ] Create local user via Supabase Auth admin API.
- [ ] Insert `platform_admins` when detected and selected.
- [ ] Create organization and membership using detected triggers when available.
- [ ] Provide dry-run/preview of operations before execution.
- [ ] Add idempotency handling for existing email/org slug.
- [ ] Add tests using LearnAI-like schema:
  - role enum values detected
  - platform admin table detected
  - org owner path detected
  - bootstrap creates expected rows

Exit criteria:

- A schema-only local Supabase app can be made usable from the UI without writing manual SQL.

### Phase 6 - UI Integration and Operator UX

- [ ] Add Resources/Stacks UI for Supabase resources.
- [ ] Show local API URL, Studio URL, function status, migrations, linked services, and missing secrets.
- [ ] Update existing Services stack diagram to show Supabase as a rich backend resource.
- [ ] Add escape hatches:
  - use hosted Supabase
  - use plain Postgres anyway
  - skip local functions
  - skip bootstrap
- [ ] Add clear copy that hosted data is not copied.
- [ ] Add destructive-operation confirmations for reset/remove.
- [ ] Add notifications when a service uses hosted Supabase but local Supabase is available.

Exit criteria:

- Operators can understand what was detected, what will be created, what is missing, and what is intentionally skipped.

### Phase 7 - Docs, Readiness, and Release Gates

- [ ] Update `docs/getting-started.md` database section.
- [ ] Update `docs/configuration.md` schema/env reference.
- [ ] Update `docs/api-reference.md` with `/resources/*`.
- [ ] Add troubleshooting entries for Supabase CLI missing, Docker unavailable, migration failure, function secret missing.
- [ ] Add readiness checklist items for dependency-aware provisioning.
- [ ] Add release gate metadata if this becomes a required 0.2.x capability.

Exit criteria:

- The feature can be operated without reading source code.

## Verification Matrix

Required tests:

- Unit:
  - profile registry
  - Supabase detection scoring
  - env requirement scanning for `Deno.env.get`
  - secret classification
  - env precedence
  - bootstrap introspection
- Integration:
  - Postgres provisioning compatibility
  - Supabase schema-only provisioning using fixture migrations
  - local env injection into Vite service
  - bootstrap first user/admin/org
  - cleanup on failed provisioning
- UI smoke:
  - LearnAI-like service shows `Add Local Supabase`
  - provisioning modal renders detection/secrets/bootstrap steps
  - resource status view shows URLs and degraded functions

Manual acceptance scenario:

1. Deploy LearnAI-like repo.
2. Services page detects Supabase.
3. Click `Add Local Supabase`.
4. Choose `Schema only`.
5. Accept generated secrets and skip optional external secrets.
6. Create first user, platform admin, and organization.
7. App restarts/rebuilds with local `VITE_SUPABASE_*`.
8. Sign in locally.
9. Verify schema exists and contains only bootstrap data, not hosted data.
10. Verify functions either run or show actionable missing-secret diagnostics.

## Security Requirements

- Generated anon/service role keys and DB credentials are stored encrypted.
- Service role key is never displayed in full after creation.
- Resource env injection is scoped to linked services only.
- Bootstrap APIs require admin auth and audit logging.
- Bootstrap never targets non-local Supabase URLs.
- Function secrets are redacted in logs and API responses.
- Removing a resource must warn about linked services and generated data loss.

## Risk Register

- Supabase CLI output changes:
  - Mitigation: parse structured output when available, fallback to robust text parser, test against pinned fixture outputs.
- Migration files contain seed-like inserts:
  - Mitigation: schema-only means "run migrations"; UI must clarify migrations may include reference/bootstrap rows.
- Edge Functions rely on third-party services:
  - Mitigation: classify optional secrets and allow local disabled/degraded mode.
- Vite `VITE_*` variables are build-time:
  - Mitigation: force rebuild for static/production builds, restart only for dev process services.
- Existing apps with service-level Supabase env override local resource env:
  - Mitigation: show override warning and offer to replace/archive old env values.
- Plain Postgres regression:
  - Mitigation: compatibility tests before and after resource abstraction.

## Definition of Done

- LearnAI-like Supabase apps get `Add Local Supabase`, not misleading `Add Postgres`.
- Local Supabase starts without hosted Supabase.
- Migrations apply with no hosted data import.
- Local app env points at local Supabase.
- Edge Functions are served locally or explicitly marked degraded with missing secrets.
- First-user/admin/org bootstrap works from UI based on schema introspection.
- Current Postgres/MySQL/Redis/Mongo database management still works.
- Tests cover detection, provisioning, env injection, bootstrap, and compatibility.
- Docs explain local Supabase, schema-only behavior, secrets, and escape hatches.
