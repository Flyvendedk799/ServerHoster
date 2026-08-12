# Supabase: migrations on deploy, grants at provision

> Status: **proposal**. Nothing here is implemented yet.
> Scope: the `supabase` resource profile only. Managed Postgres/`managedDb` resources are out of scope.

Two defects keep costing us a debugging session per app. They look like one problem — "the
database is wrong after a deploy" — but they have different causes, different fixes, and
different blast radii. They should ship as two changes.

| | Symptom | Cause | Fix belongs in |
|---|---|---|---|
| **A** | `42501 permission denied for table …` on every request | Provisioning never grants the PostgREST API roles anything | `profiles/supabase.ts` provision |
| **B** | New migration files in a repo never reach the database | Nothing calls the migration apply outside provisioning | `deploy.ts` post-deploy |

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

`applyPostDeployServiceState` (`deploy.ts:1657`), inside the `deployment.status === "success"`
branch at line 1667, **before** `startService` at line 1676.

Ordering matters: the new frontend must not start against the old schema. Running migrations
first means the window of mismatch is old-frontend-against-new-schema, which the usual
expand-then-contract discipline already covers.

### What it does

1. Resolve the supabase resource(s) linked to the service (see the hazard below).
2. For each, if `supabase/migrations` exists in the workdir, run the existing
   `supabaseMigrationApply(workdir)`. The CLI skips everything already in
   `supabase_migrations.schema_migrations`, so this is a no-op on the overwhelming majority of
   deploys and needs no new bookkeeping from us.
3. Append the CLI output to the deployment's `build_log` and record the versions applied, so a
   bad migration is traceable to a deployment.
4. Run the Part A grant block afterwards when any migration applied, so new tables are reachable
   without the app repo knowing anything about grants.

### The resource-ambiguity hazard

This is the part to get right. As measured above, one service can carry several active links,
including to `failed` resources. Migrating a dead duplicate would be silent and wrong; worse, a
service linked to two *healthy* stacks has no obvious correct answer.

Proposed rule:

- consider only links with `active = 1` **and** resource `status = 'running'` **and**
  `profile = 'supabase'`;
- exactly one match → migrate it;
- zero matches → skip quietly, this is the normal case for most services;
- more than one match → **skip and warn**, do not guess. Log which resources were candidates.

We should also clean up the stale `failed` links, but the rule must not depend on that cleanup
having happened.

### Failure policy

If a migration fails, fail the deployment and do **not** start the new build. This matches the
existing behaviour where a failed build leaves the previous version serving. A service that is
already running should be left running — the same reasoning as `deploy.ts:1695-1704`.

### Concurrency and lock safety

- Take a Postgres advisory lock (`pg_try_advisory_lock`) around the apply so two deploys — or a
  deploy racing a manual `supabase migration up` — cannot interleave. If the lock is held, fail
  fast with a clear message rather than queueing.
- Set a conservative `lock_timeout` and `statement_timeout` for the session. A migration that
  wants `ACCESS EXCLUSIVE` on a large table would otherwise stall every request to the live app
  for as long as it takes.

### This must be opt-in

The GitOps poller redeploys within ~60s of any push to `main`. Turning this on globally means
**arbitrary SQL executes against production on push, with no review gate**. That is a significant
change in what a `git push` does, and it should be a deliberate per-resource choice, not a
platform default.

Add `auto_migrate` (default **off**) to the resource config, surfaced as a toggle on the resource
with text that says plainly what it does. Revisit the default only once it has run quietly for a
while across several stacks.

---

## Testing

Existing patterns to follow: `resources.provision.test.ts`, `companionEnv.test.ts`, and the
`setFunctionsSpawn` injectable seam in `functions.ts` (tests must never shell out to a real CLI or
touch a real database).

- **Grants** — RLS-off table present → anon/authenticated grants withheld, warning raised,
  resource degraded not failed. All-RLS → full grant block emitted. Repair action is idempotent.
- **Link resolution** — one running + two failed links → picks the running one. Two running links
  → skips and warns. Zero links → no-op, deploy unaffected.
- **Ordering** — migrations run before `startService`; a migration failure marks the deployment
  failed, leaves a running service running, and does not start a stopped one.
- **Opt-in** — `auto_migrate` off (the default) means no migration call at all.

## Exit criteria

- A freshly provisioned stack answers PostgREST queries without a hand-applied grants migration.
- A repo whose only change is a new file in `supabase/migrations` reaches the database on deploy,
  with the applied versions visible in the deployment log.
- A service linked to more than one running supabase resource never migrates either of them.
- `docs/troubleshooting.md` gains a `42501` entry pointing at the repair action.

## Explicitly out of scope

- Rollback / down-migrations. `supabase migration up` is forward-only and we should keep it that
  way; recovery is restore-from-backup.
- Applying migrations to managed Postgres (`profiles/managedDb.ts`) resources.
- Reviewing or gating migration *content* — dangerous SQL is the app author's responsibility.
- Data seeding. `supabaseSeed` stays a provision-time concern.
