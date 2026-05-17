# LocalSURV Readiness Checklist

> Authoritative source for whether a candidate build is fit to ship as a
> stable release. Sequenced from `docs/100-percent-readiness-sequence-plan.md`.
> The CI verifier (`scripts/ci/verify-readiness.ts`) consumes
> `ops/release-gates.json` and matches it against this document. Each item
> below is tagged `[MUST]`, `[SHOULD]`, or `[INFO]`. Releases require every
> `[MUST]` item to be green; `[SHOULD]` items are tracked but do not gate.

## Sequence 0 — Foundation

- `[MUST]` `docs/readiness-checklist.md` exists and is referenced from the README and ROADMAP.
- `[MUST]` `ops/release-gates.json` exists and is parseable.
- `[MUST]` `scripts/ci/verify-readiness.ts` exists and exits non-zero when a mandatory gate is missing.
- `[SHOULD]` Readiness scorecard rendered in release notes.

## Sequence 1 — Security Hardening

- `[MUST]` `apps/server/src/routes/webhooks.ts` enforces HMAC signature verification with timestamp skew window for all incoming webhook providers.
- `[MUST]` `apps/server/src/routes/admin.ts` exposes a token-gated admin reset/recovery flow with audit logging.
- `[MUST]` `apps/server/src/lib/core.ts` (or co-located helper) centralises authz/ownership middleware used across service-bound routes.
- `[MUST]` `apps/server/src/config.ts` carries explicit production-safe defaults (secure cookies, trusted CORS origins).
- `[MUST]` `apps/server/src/services/audit.ts` enriches audit events with actor, target, and source IP fields.
- `[MUST]` Webhook negative-path tests (signature mismatch, stale timestamp, replay) live in the server test suite.
- `[SHOULD]` Endpoint-specific rate limits documented in `docs/configuration.md`.

## Sequence 2 — Deployment Reliability & Runtime Determinism

- `[MUST]` `apps/server/src/services/deployStateMachine.ts` exists and exposes the canonical deployment states (`queued`, `cloning`, `building`, `starting`, `healthy`, `failed`, `rolled_back`).
- `[MUST]` Deployment persistence captures `trigger_source`, `git_sha`, `duration_ms`, and `failure_stage`.
- `[MUST]` `apps/server/src/services/cleanupQueue.ts` handles idempotent cleanup with dead-letter behaviour.
- `[MUST]` Fault-injection test (`deploy.integration.test.ts` or similar) covers git failure / build failure / port conflict paths.
- `[SHOULD]` Documented rollback runbook in `docs/operations.md`.

## Sequence 3 — Networking, Proxy, TLS, and Edge Exposure

- `[MUST]` Host-based proxy routing precedes app route resolution (`apps/server/src/routes/proxy.ts`).
- `[MUST]` ACME preflight reachability check exists in `apps/server/src/services/ssl.ts`.
- `[MUST]` Tunnel adapter contract under `apps/server/src/services/tunnels/` with at least one registered adapter and a health probe.
- `[SHOULD]` Domain ownership/validation workflow.

## Sequence 4 — Observability

- `[MUST]` `apps/server/src/services/metrics.ts` records counters/histograms for deploy duration and failures.
- `[MUST]` Structured build/runtime websocket events with correlation IDs (`deploymentId`, `serviceId`).
- `[MUST]` Log query endpoint with filters by `serviceId`, `level`, time range.
- `[SHOULD]` Crash reporter retention policy documented.

## Sequence 5 — Data Safety, Backup, Disaster Recovery

- `[MUST]` `apps/server/src/services/backup.ts` (scheduler + retention) is wired into the boot loop.
- `[MUST]` Backup integrity checksums and restore preflight validation are part of the backup pipeline.
- `[MUST]` Operator endpoints / UI surface restore dry-run.
- `[SHOULD]` Nightly backup-restore smoke test in CI.

## Sequence 6 — UX

- `[MUST]` First-run wizard performs environment diagnostics (Docker, Git, ports, DNS).
- `[MUST]` Service pages expose deployment timeline plus root-cause summary.
- `[SHOULD]` Playwright smoke for onboarding + first deploy.

## Sequence 7 — Cross-Platform Packaging

- `[MUST]` `install.sh` and `install.ps1` are idempotent with rollback behaviour.
- `[MUST]` Packaging artefacts under `packaging/macos/*` and `packaging/windows/*` are exercised in CI.
- `[SHOULD]` Artifact signing + checksum publication workflow.

## Sequence 8 — Quality Gates & Release Governance

- `[MUST]` Required CI checks: typecheck, lint, unit, integration, e2e smoke, security scan, packaging smoke.
- `[MUST]` Performance smoke for deploy latency and UI responsiveness budgets.
- `[MUST]` Tag-driven release workflow with changelog validation and artifact manifest.
- `[SHOULD]` Versioned release runbook in `docs/releases.md`.

## Sequence 9 — Stabilization

- `[MUST]` Public readiness scorecard embedded in `docs/readiness-checklist.md` (this file) and release notes.
- `[MUST]` 0 critical/major open defects when scorecard turns green.
- `[SHOULD]` Stability KPIs sustained for two consecutive release cycles.

---

## Readiness Scorecard

Each row maps to a sequence above. The CI verifier writes the latest run into
`ops/readiness-scorecard.json` so external tooling and release notes can
render an up-to-date status without re-running checks.

| Sequence                   | Status        |
| -------------------------- | ------------- |
| 0 — Foundation             | tracked-by-CI |
| 1 — Security               | tracked-by-CI |
| 2 — Deployment reliability | tracked-by-CI |
| 3 — Networking & TLS       | tracked-by-CI |
| 4 — Observability          | tracked-by-CI |
| 5 — Backup & DR            | tracked-by-CI |
| 6 — UX                     | tracked-by-CI |
| 7 — Packaging              | tracked-by-CI |
| 8 — Quality gates          | tracked-by-CI |
| 9 — Stabilization          | tracked-by-CI |

Run `npm run verify:readiness` (defined at the repo root) to refresh the
scorecard locally.
