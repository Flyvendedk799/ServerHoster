# Task 1 — Make managed Redis actually provision (not just scaffold)

## Goal
When ServerHoster detects a Redis driver in a service, let the operator
one-click provision a **real Redis container** (inject `REDIS_URL`), the same
way Postgres works today — instead of the current misleading "Add Postgres"
offer that can't satisfy a Redis need.

## Current state (why it's broken)
Redis is fully *scaffolded* but the actual provisioning is a stub:

- `apps/server/src/services/resources/profiles/redis.ts` — `provision()` and
  `remove()` **throw** `"…not implemented in this phase (Phase 3 wires this
  profile)"`. Detection + `plan()` work; provisioning does not.
- `apps/server/src/routes/databases.ts` — the POST schema accepts
  `engine: "redis"`, but the managed path only *"spin[s] up a new Postgres"*
  (`databases.ts:56`). No Redis image / port `6379` / auth branch exists.
- `apps/web/src/pages/Services.tsx:1921-1971` — the `db-suggest-banner` ignores
  the detected driver: the copy is hardcoded `"…Add Postgres so data persists."`
  and the button is hardcoded `"Add Postgres"` → `quickAddDatabase()` (Postgres
  default). Your own guard already flags this:
  `apps/server/src/resources.guardrails.test.ts:141`
  ("currently triggers the misleading one-click 'Add Postgres' offer").

So: types, scanner, profile registration, and plan/preview all know Redis — only
the container spin-up and the UI offer are missing.

## The fix

### 1. Real Redis container creation (backend)
The container-creation helper used by `provisionPostgres`
(`createManagedDatabase` in the databases service) assumes Postgres. Either:
- **(preferred)** teach `createManagedDatabase` to branch on `engine`: for
  `"redis"` run image `redis:7`, expose `6379`, set `--requirepass <password>`,
  skip the SQL `databaseName`/`username` concepts; or
- add a small dedicated `createManagedRedis(ctx, {projectId, name, port,
  password})` helper next to it.

Connection string: `redis://:<password>@127.0.0.1:<port>` (or `redis://…/0`).

### 2. Implement `redisProfile.provision()` / `remove()`
In `apps/server/src/services/resources/profiles/redis.ts`, replace the two
`throw` bodies. **Mirror `provisionPostgres`** in `profiles/postgres.ts` almost
line-for-line:

1. `createResource(ctx, { profile: "redis", status: "provisioning", … })`
2. `broadcast(ctx, { type: "resource_status", status: "provisioning", profile: "redis" })`
3. `await ctx.docker.ping()` (use `dockerUnavailableMessage` on failure)
4. `const port = await findFreePort(REDIS_PORT_RANGE[0], REDIS_PORT_RANGE[1], dbReservedPorts(ctx))`
   — add a `REDIS_PORT_RANGE` (e.g. `[63790, 63890]`) so it doesn't collide
   with the Postgres range `[54320, 54420]`.
5. create the container (step 1 helper), `password: nanoid(16)`
6. `updateResourceRuntimeState(ctx, id, { ports: { redis: port }, containers: [name], config: {…} })`
7. `setResourceSecret(ctx, id, "REDIS_URL", connString, true)` — `redis.ts`
   already declares `env.generated = ["REDIS_URL"]`, so injection is consistent.
8. `linkResourceToService(ctx, { serviceId, resourceId })`
9. `if (input.restart !== false) await restartOrRedeployService(ctx, serviceId)`
10. `updateResourceStatus(ctx, id, "ready")` + final `broadcast`
11. on error: mark `"failed"` + broadcast (same `catch` shape as Postgres).

`remove()`: stop+rm the container, `setResourceStatus`/delete the
`managed_resources` row, unlink from the service — mirror `postgresProfile.remove`.

`/resources/provision` already accepts `profile: "redis"`
(`routes/resources.ts:56`) and calls `profile.provision(...)`, so no route
change is needed once the throws are gone.

### 3. Make the suggestion banner engine-aware (frontend)
In `apps/web/src/pages/Services.tsx` (the `db-suggest-banner` block, ~1921):
- Pick the dominant detected engine from `uniqueDrivers` (the scanner already
  tags each `code_signal` with a `driver`). Map driver → resource profile
  (`redis` → `"redis"`, `PostgreSQL/Prisma/Drizzle` → `"postgres"`, etc.).
- Set the button label and copy from that engine: `"Add Redis"` and a Redis-
  appropriate sentence (see note below), not the hardcoded `"Add Postgres"`.
- Provision via the **profile-aware** endpoint
  `POST /resources/provision { serviceId, profile: <engine> }` instead of the
  Postgres-default `quickAddDatabase()`. Keep `quickAddDatabase` only for the
  genuine Postgres/SQLite-promote case.

### 4. (Optional) Tidy the legacy `/databases` path
Either generalize `databases.ts` managed-mode to branch on `engine`, or route
all new provisioning through the resource profiles and leave `/databases` for
existing Postgres/MySQL management only. Avoid two code paths that both claim to
"add a database" but only one knows Redis.

### 5. Tests
- `apps/server/src/resources.guardrails.test.ts` — flip the `:141` expectation:
  a Redis signal must yield an **"Add Redis"** offer, not "Add Postgres".
- `apps/web/src/resources.smoke.test.tsx` — add a redis-driver fixture and
  assert the banner renders "Add Redis" and calls `/resources/provision` with
  `profile: "redis"` (mirror the existing "Add Local Supabase" smoke case).
- Add a server test that `redisProfile.provision()` writes a `managed_resources`
  row with `ports.redis`, a `REDIS_URL` secret, and a link to the service
  (Docker mocked, like the Postgres provision tests).

## Acceptance criteria
- [ ] A service with a Redis signal shows **"Add Redis"** (not "Add Postgres").
- [ ] Clicking it spins a real `redis:7` container on a free port and injects
      `REDIS_URL`; the service restarts and can reach it.
- [ ] `remove()` tears the container down and unlinks cleanly.
- [ ] `redis.ts` no longer throws "not implemented"; the guardrails + smoke
      tests are green.

## Notes / gotchas
- **Redis is usually an ephemeral cache, not a persistence store.** Don't reuse
  the "…so data persists" copy verbatim — frame it as "Add Redis (cache)" and,
  if you want durability, mention enabling AOF/RDB on the volume. For a service
  whose only signal is Redis-as-cache, "no managed DB needed" may be the more
  honest banner.
- Reserve the Redis port range in `dbReservedPorts(ctx)` so concurrent
  provisions don't collide.
- Make re-provision idempotent (mirror how Postgres reuses a remembered
  port/row) so a retried click doesn't orphan a second container.
- Persist the container across redeploys the same way other managed resources
  are (the deploy git-hard-reset must not wipe it).
