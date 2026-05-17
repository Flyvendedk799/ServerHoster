# LocalSURV 100% All‑Around Readiness Sequence Plan

> Purpose: make it unmistakably clear in the codebase that LocalSURV is targeting **production-grade, end-to-end self-hosted PaaS readiness** across reliability, security, UX, operations, and release engineering.

## North-Star Definition (What “100% all-around” means)

A release is “100% all-around ready” when all of the following are true:

1. **Secure by default**: no unsafe defaults, secrets encrypted, auth hardened, abuse-limited.
2. **Reliable in daily operation**: deploys, restarts, rollbacks, and background workers are deterministic.
3. **Observable and debuggable**: logs, metrics, audit, crash reports, and traceability are first-class.
4. **Operationally complete**: backup/restore, disaster recovery, upgrade path, and runbooks are validated.
5. **UX-complete for operators**: first-run onboarding, confidence signals, and actionable errors.
6. **Cross-platform delivery quality**: Linux/macOS/Windows install paths and package artifacts are trustworthy.
7. **CI-gated releases**: no release without passing quality/security/performance gates.

---

## Sequence 0 — Make the Goal Explicit in-Code (Foundation)

### Deliverables
- Add and maintain a **single authoritative readiness checklist** consumed by docs and release process.
- Add release gate metadata file to fail CI when readiness criteria are unmet.

### Technical implementation
- Create `docs/readiness-checklist.md` with machine-readable sections (`[MUST]`, `[SHOULD]`, `[INFO]`).
- Create `ops/release-gates.json` to encode required gates (tests, lint, security, smoke).
- Add CI script `scripts/ci/verify-readiness.ts` to parse `ops/release-gates.json` and fail build on missing artifacts/evidence.

### Exit criteria
- CI fails if any mandatory gate is incomplete.
- README and roadmap link to this readiness source of truth.

---

## Sequence 1 — Security Hardening (No-Compromise Baseline)

### Deliverables
- Webhook signature verification and replay protection.
- Strict CORS and cookie/session hardening.
- Endpoint-specific rate limits and authz checks.
- Admin reset and bootstrap flow hardened for safe recovery.

### Technical implementation targets
- `apps/server/src/routes/webhooks.ts`: enforce provider signature checks with timestamp skew window.
- `apps/server/src/lib/core.ts`: centralize authz middleware and service ownership checks.
- `apps/server/src/config.ts`: explicit production-safe defaults (secure cookies, trusted origins).
- `apps/server/src/services/audit.ts`: enrich audit events with actor, target, and source IP.
- Add `apps/server/src/routes/admin.ts` for secure `reset-admin` flow (tokenized + audited).

### Test strategy
- Negative-path tests for signature mismatch, stale timestamp, replayed nonce.
- Brute-force/rate-limit test cases in integration tests.

### Exit criteria
- OWASP-style checklist complete for auth/session/input handling.
- Security test suite mandatory in CI.

---

## Sequence 2 — Deployment Reliability & Runtime Determinism

### Deliverables
- Deterministic build/deploy state machine.
- Strong retry/backoff semantics with idempotency.
- Safe rollback path and deployment provenance.

### Technical implementation targets
- `apps/server/src/lib/upstream.ts`: normalize clone/fetch/pull behavior and explicit failure reasons.
- `apps/server/src/services/cleanupQueue.ts`: idempotent cleanup and dead-letter handling.
- Add `apps/server/src/services/deployStateMachine.ts`: canonical deployment states (`queued`, `cloning`, `building`, `starting`, `healthy`, `failed`, `rolled_back`).
- Extend deployment persistence schema to record `trigger_source`, `git_sha`, `duration_ms`, `failure_stage`.

### Test strategy
- Fault-injection tests for git failure, build failure, port conflict, healthcheck timeout.
- Verify retries do not create duplicate active instances.

### Exit criteria
- Repeated deploy attempts produce consistent final states.
- Rollback proven by automated integration test.

---

## Sequence 3 — Networking, Proxy, TLS, and Edge Exposure

### Deliverables
- Host-based proxy behavior correctness.
- TLS provisioning preflight checks and renewal resilience.
- Tunnel adapter abstraction productionized.

### Technical implementation targets
- `apps/server/src/routes/proxy.ts`: full host-header routing before app route resolution.
- `apps/server/src/services/ssl.ts`: ACME preflight reachability and robust renewal logs.
- Introduce `apps/server/src/services/tunnel/adapters/*` with adapter contract and health probes.
- Add domain ownership/validation workflow and clear operator diagnostics.

### Test strategy
- End-to-end routing tests for multi-domain and SNI cert selection.
- Renewal simulation and failure-mode assertions.

### Exit criteria
- Domain -> app routing correctness verified under concurrent traffic.
- TLS lifecycle passes automated smoke checks.

---

## Sequence 4 — Observability You Can Operate On

### Deliverables
- Unified log model across build/runtime/system events.
- Prometheus metrics endpoint and service-level KPIs.
- Request/deployment correlation IDs.

### Technical implementation targets
- `apps/server/src/services/crashReporter.ts`: opt-in crash reports with local retention policy.
- Add `apps/server/src/services/metrics.ts`: counters/histograms for deploy duration, failures, restart loops.
- Extend websocket event schema for structured build/runtime logs.
- Add log query endpoints with filters (`serviceId`, `deploymentId`, `level`, `time-range`).

### Test strategy
- Metrics contract tests (names/labels consistency).
- Log ingestion/load tests for high-volume service output.

### Exit criteria
- Any incident can be traced from UI event -> deployment -> logs -> system metrics.

---

## Sequence 5 — Data Safety, Backup, and Disaster Recovery

### Deliverables
- Scheduled encrypted backups and verified restore workflow.
- Recovery drills integrated into CI/nightly automation.

### Technical implementation targets
- Add `apps/server/src/services/backup.ts` scheduler and retention policy.
- Add backup integrity checksums and restore preflight validation.
- Add operator endpoints/UI flows for restore dry-run and rollback-safe restore.

### Test strategy
- Nightly backup/restore smoke in CI with seeded fixtures.
- Corruption simulation tests.

### Exit criteria
- RPO/RTO targets documented and continuously validated.

---

## Sequence 6 — UX and First-Run Operator Experience

### Deliverables
- First-run wizard with environment diagnostics.
- Service lifecycle UX completeness (create, deploy, inspect, rollback, delete).
- Clear, actionable errors throughout the dashboard.

### Technical implementation targets
- `apps/web` onboarding wizard with checks for Docker, Git, ports, DNS assumptions.
- Service pages expose deployment timeline + root-cause summaries.
- Replace opaque alerts with typed error surfaces and remediation hints.

### Test strategy
- Playwright smoke for onboarding + first deploy.
- Accessibility and responsive pass for critical flows.

### Exit criteria
- New user can complete first successful deploy in <=10 minutes without docs.

---

## Sequence 7 — Cross-Platform Packaging and Install Integrity

### Deliverables
- Linux/macOS/Windows installers with parity guarantees.
- Packaging validation matrix and signed artifacts.

### Technical implementation targets
- Harden `install.sh` and `install.ps1` idempotency and rollback behavior.
- Validate `packaging/macos/*`, `packaging/windows/*` build scripts in CI runners.
- Artifact signing and checksum publication workflow.

### Test strategy
- Matrix smoke runs per OS for install/start/stop/uninstall.
- Upgrade-in-place tests from previous stable tag.

### Exit criteria
- Installation success rate >=99% in CI matrix with deterministic logs.

---

## Sequence 8 — Quality Gates, Performance, and Release Governance

### Deliverables
- Non-negotiable merge/release gates.
- Performance budgets and regression alarms.
- Versioned release runbook.

### Technical implementation targets
- Enforce required checks: typecheck, lint, unit, integration, e2e smoke, security scan, packaging smoke.
- Add performance smoke suite for deploy latency and UI responsiveness budgets.
- Tag-driven release workflow with changelog validation and artifact manifest.

### Exit criteria
- No manual release exceptions.
- Every release is reproducible from tag + manifest + checksums.

---

## Sequence 9 — “Once and For All” Stabilization Window

### Deliverables
- Two-cycle hardening window focused only on bugfixes, no new feature scope.
- Public readiness scorecard embedded in docs and release notes.

### Technical implementation
- Freeze feature branches except critical blockers.
- Weekly triage against SLOs and error budgets.
- Promote candidate to stable only when scorecard is fully green.

### Exit criteria
- 0 critical/major open defects.
- Stability KPIs sustained for two consecutive release cycles.

---

## Readiness Scorecard (Required to declare 100%)

- Security hardening: 100% mandatory controls complete.
- Reliability: successful deploy/rollback rates above defined SLO.
- Observability: full traceability for incidents.
- DR: backup restore drill passing on schedule.
- UX: first-run and routine ops validated by automated smoke.
- Packaging: all target OS installer checks green.
- Release engineering: signed artifacts and reproducible builds.

---

## Ambitious Execution Cadence

- **Wave A (Weeks 1–4)**: Sequences 0–2.
- **Wave B (Weeks 5–8)**: Sequences 3–5.
- **Wave C (Weeks 9–12)**: Sequences 6–8.
- **Wave D (Weeks 13–16)**: Sequence 9 stabilization and stable release cut.

If scope risk appears, de-scope features, **never gates**.
