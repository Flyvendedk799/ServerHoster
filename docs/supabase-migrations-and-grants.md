# Supabase: migrations on deploy, grants at provision

> Status: **Part B shipped** (`services/resources/deployMigrations.ts`, covered by
> `deploy.migrations.test.ts`). **Part A (grants) is still a proposal.**
> Scope: the `supabase` resource profile only. Managed Postgres/`managedDb` resources are out of scope.
>
> Three things shipped differently from the proposal below; each is called out inline as
> **Shipped as**: the hook runs before the build rather than after it, the default is **on**
> rather than off, and the session timeouts were dropped because the CLI owns its own connection.

Two defects keep costing us a debugging session per app. They look like one problem — "the
database is wrong after a deploy" — but they have different causes, different fixes, and
different blast radii. They should ship as two changes.

| | Symptom | Cause | Fix belongs in |
|---|---|---|---|
| **A** | `42501 permission denied for table …` on every request | Provisioning never grants the PostgREST API roles anything | `profiles/supabase.ts` provision |
| **B** | New migration files in a repo never reach the database | Nothing calls the migration apply outside provisioning | `deploy.ts` (shipped) |

Both were hit on Havekongen (2026-08-11): saving a garden failed with `42501` even though the
table had four correct RLS policies, and the fix migration then had to be applied to the live
database by hand because a deploy does not run migrations.

---

## Evidence from the live fleet

Measured on the VPS before writing this, because the design turns on these facts:

- **The resource workdir is the service checkout.** `profiles/supabase.ts:478` records
  `workdir = workdirOverride ?? service.working_dir`. For Havekongen that is
  `/root/.survhub/projects/hvRhvyxXbp0SOIx-Ntfzv` — the same directory the GitOps poller pulls
  into. New migration files are therefore *already on disk* after a deploy. This is also why
  edge functions pick up code changes on deploy without any extra plumbing.
- **The CLI ledger is intact.** `supabase_migrations.schema_migrations` on the Havekongen stack
  holds 27 rows against 28 files on disk — exactly one pending, the grants migration added by
  hand. Provisioning already populates it, because `supabaseMigrationApply` (`supabaseCli.ts:131`)
  shells out to `supabase migration up`, which records every migration it applies.
- **`service_resource_links` is ambiguous.** Service `hvRhvyxXbp0SOIx-Ntfzv` has **three active
  links** — one `running` resource and two `failed` duplicates from earlier provisioning attempts
  — plus one inactive. Any "find the database for this service" lookup must handle this or it will
  migrate the wrong database.

The first two facts make **B** far smaller than it first appears: there is no baseline problem and
no new ledger to build. The third is the real hazard.

---

## Part A — grant the API roles at provision time

### Why this is not a migration

The missing grants are a property of *how ServerHoster provisions a stack*, not of any app.
Supabase Cloud sets them up when it creates a project; our provisioner creates the schema and the
RLS policies and stops. Pushing a grants migration into each app repo — which is what we did for
Havekongen as a stopgap — means every current and future app has to carry a workaround for a
platform gap, and every new app hits `42501` first and learns about it the hard way.

A `GRANT` is checked **before** any RLS policy is consulted, so a table with perfect policies is
still unreachable without one. That is why this presents as a baffling error: the policies are
visibly correct.

### Change

In `profiles/supabase.ts`, after the migrate step (currently `supabase.ts:598-604`), add an
`api-grants` provision step that applies:

```sql
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL    ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, anon, authenticated;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO service_role, anon, authenticated;
-- plus matching ALTER DEFAULT PRIVILEGES so later migrations inherit them
NOTIFY pgrst, 'reload schema';
```

Register it in the provision plan alongside `apply-migrations` (`supabase.ts:733`) so it shows in
the UI as a real step rather than happening invisibly.

### The safety check this must not skip

Granting `SELECT` on **all** tables to `anon` is only safe because RLS decides which rows come
back. If a table has RLS *off*, this grant turns it into a publicly readable table.

So before granting, count tables in `public` where `relrowsecurity` is false. If any exist:

- do **not** grant to `anon`/`authenticated` (still grant `service_role`, which bypasses RLS anyway),
- surface a provision warning naming the offending tables,
- mark the resource degraded rather than failed — a half-granted stack is more useful than none.

Havekongen passes cleanly: 40 public tables, 40 with RLS, 0 with RLS-but-no-policy.

### Repairing the existing fleet

The running stacks (Havekongen, Awaire, DinGaming, DinRedaktion, …) were provisioned before this
and are missing grants unless they were patched by hand. Add an idempotent repair that runs the
same block, exposed as a resource action so it can be triggered per stack from the UI. Re-running
it is harmless.

---

## Part B — apply migrations on deploy

### Where the hook goes

**Shipped as:** inside `deployFromGitLocked`, immediately after
`reconcileManagedSupabaseConfig` re-materialises the managed `config.toml` and **before**
build-type detection — earlier than the proposed `applyPostDeployServiceState` slot.

The proposal put it after a successful build, before `startService`. Two things moved it
earlier:

- Build steps can read the database (type generation, SSG that queries Supabase at build time).
  Migrating after the build means those steps see the old schema.
- A bad migration fails the deploy in seconds instead of after a full build.

It has to come after the config reconcile either way: the CLI reads `supabase/config.toml` for
the stack's host ports, and the git hard-reset strips the managed block out of it.

The ordering property the proposal cared about is unchanged — migrations still run before the
new code starts, so the mismatch window is old-code-against-new-schema, which
expand-then-contract already covers. What is genuinely different: if the *build* then fails, the
schema has already moved while the previous build keeps serving. Same window, wider.

### What it does

1. Resolve the one started supabase stack linked to the service (see the hazard below).
2. Diff the repo's `supabase/migrations/*.sql` versions against
   `supabase_migrations.schema_migrations`, read straight from the stack. **Nothing pending
   means the CLI is never invoked and no lock is taken** — that is every deploy but a handful.
3. Otherwise run `supabaseMigrationApply(workdir, { local: true, includeAll })`.
   `--include-all` is passed only when a pending file sorts *before* the newest applied
   version — two branches merged out of order, which plain `migration up` refuses outright.
4. Re-read the history table and confirm every pending version is now recorded. The exit code is
   not trusted on its own: a CLI that exits 0 without recording is treated as a failure, because
   proceeding would start the new code against the old schema.
5. Write one line into the deployment's `build_log`, naming the versions applied.

Step 4 of the proposal — running the Part A grant block after a migration — is **not** shipped.
Grants are still Part A and still unimplemented.

### The resource-ambiguity hazard

This is the part to get right. As measured above, one service can carry several active links,
including to `failed` resources. Migrating a dead duplicate would be silent and wrong; worse, a
service linked to two *healthy* stacks has no obvious correct answer.

**Shipped as** `resolveMigrationTarget`, with one widening: `status` may be `running` **or**
`ready`. A freshly provisioned stack sits at `ready` and has a perfectly good database, and
that same pair is what `requireBootstrapResource` already accepts.

- consider only links with `active = 1` **and** resource `status` in (`running`, `ready`) **and**
  `profile = 'supabase'` (duplicate links to one resource collapse to a single candidate);
- exactly one match → migrate it;
- zero matches → skip quietly, this is the normal case for most services;
- more than one match → **skip and warn**, do not guess. The build log names the candidates.

We should also clean up the stale `failed` links, but the rule must not depend on that cleanup
having happened.

### Failure policy

If a migration fails, fail the deployment and do **not** start the new build. This matches the
existing behaviour where a failed build leaves the previous version serving. A service that is
already running should be left running — the same reasoning as `deploy.ts:1695-1704`.

### Concurrency and lock safety

- **Shipped:** `pg_try_advisory_lock(hashtext('survhub:supabase-migrations'))` on the stack's own
  database, taken around the apply and released in a `finally`. A held lock fails fast with
  "another migration run holds the advisory lock"; it never queues.
- **Not shipped:** the session `lock_timeout` / `statement_timeout`. The CLI opens its own
  connection, so the only way to scope those to it is a persistent `ALTER ROLE … IN DATABASE`,
  which would silently apply to every other connection to that stack too. A long
  `ACCESS EXCLUSIVE` migration can therefore still stall the live app — worth revisiting, but not
  worth a persistent global setting to fix.

### The default

The proposal argued for default **off**: the GitOps poller redeploys within ~60s of any push to
`main`, so turning this on globally means arbitrary SQL executes against production on push with
no review gate.

**Shipped as default ON**, deliberately, because that trade already exists. A push to `main`
*already* ships arbitrary application code to production within 60s with no review gate. The
schema was the one part left behind, and leaving it behind is exactly what broke Havekongen and
Awaire. The reviewer in both cases is the same person, at `git push` time.

The escape hatch is per stack: `auto_migrate: false` in the resource config, set via
`POST /resources/:id/auto-migrate {"enabled": false}`. `GET /resources/:id/migrations` shows what
the next deploy would apply without running anything.

What makes the default defensible is the set of properties enforced in code, not the default
itself: local stacks only, one unambiguous stack only, forward-only, never seeds, never replays
against a database with no history table, and a failure stops the deploy.

---

## Testing

Part B is covered by `apps/server/src/deploy.migrations.test.ts`. Both side-effecting layers are
injected — the CLI through `setMigrationCliRunner`, Postgres through `setMigrationDbClient` — so
nothing shells out to a real CLI or touches a real database.

- **Link resolution** — one running + two failed links → picks the running one. Two started links
  → skips and warns, touches neither. Zero links → silent no-op.
- **Diffing** — pending detection, out-of-order detection, and "nothing pending" taking neither
  the lock nor the CLI.
- **Failure** — a throwing CLI, and a CLI that exits 0 without recording, both produce an error
  the deploy turns into a failed deployment; the advisory lock is released either way.
- **Guards** — hosted `db_url`, missing history table, stopped stack, and `auto_migrate: false`
  each skip without running anything.

Still owed for **Part A**: RLS-off table present → anon/authenticated grants withheld, warning
raised, resource degraded not failed; all-RLS → full grant block emitted; repair action
idempotent.

## Exit criteria

- ~~A repo whose only change is a new file in `supabase/migrations` reaches the database on
  deploy, with the applied versions visible in the deployment log.~~ **Done.**
- ~~A service linked to more than one running supabase resource never migrates either of them.~~
  **Done.**
- A freshly provisioned stack answers PostgREST queries without a hand-applied grants migration.
  *(Part A, outstanding.)*
- `docs/troubleshooting.md` gains a `42501` entry pointing at the repair action.
  *(Part A, outstanding.)*

## Explicitly out of scope

- Rollback / down-migrations. `supabase migration up` is forward-only and we should keep it that
  way; recovery is restore-from-backup.
- Applying migrations to managed Postgres (`profiles/managedDb.ts`) resources.
- Reviewing or gating migration *content* — dangerous SQL is the app author's responsibility.
- Data seeding. `supabaseSeed` stays a provision-time concern.
