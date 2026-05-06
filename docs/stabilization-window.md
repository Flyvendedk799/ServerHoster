# Sequence 9 — Stabilization Window

> "Once and for all" hardening cycle described in
> [`docs/100-percent-readiness-sequence-plan.md`](100-percent-readiness-sequence-plan.md).
> Two release cycles of bugfix-only work, gated on a green readiness
> scorecard.

## Scope rules

- **No new feature scope.** Refactors land only when they fix a defect or
  unblock a stabilization gate (verifier, performance budget, packaging
  matrix). Anything else waits for the next minor.
- **Critical / major defects block promotion.** A candidate may not be
  promoted to the next stable tag while there is a P0 or P1 bug open.
- **All [MUST] gates in [`docs/readiness-checklist.md`](readiness-checklist.md)
  must be green** for two consecutive release cycles.
- **Stability KPIs sustained:**
  - Successful deploy rate >= 99% over a 14-day rolling window.
  - Successful rollback rate == 100% over the same window.
  - p95 deploy duration within the budget published in
    [`ops/perf-budgets.json`](../ops/perf-budgets.json).

## Weekly triage

Every week during the stabilization window:

1. Re-run `npm run verify:readiness` and `npm run perf:budgets`. Update
   [`ops/readiness-scorecard.json`](../ops/readiness-scorecard.json) and
   [`ops/perf-results.json`](../ops/perf-results.json) on the release
   branch.
2. Inspect `cleanup_dead_letter` (`/ops/cleanup/dead-letter` admin route in
   future) and `audit_logs` for repeated failure patterns.
3. Confirm the SSL renewal loop and scheduled backup loop both ran in the
   last 7 days (look at `localsurv_backup_*` and certificate expiry dates).
4. Triage open issues against the SLOs above. Anything that breaches a SLO
   gets a P0/P1 label; everything else is deferred.

## Promotion checklist

Before tagging a stable release out of the stabilization window:

- [ ] Two consecutive release cycles with a green
      `ops/readiness-scorecard.json` (no required-gate fails).
- [ ] Two consecutive release cycles with `ops/perf-results.json` inside
      every budget.
- [ ] Zero P0 / P1 issues open against the candidate.
- [ ] CHANGELOG.md updated with the stable version, including the
      stabilization-window summary as the headline entry.
- [ ] `docs/readiness-checklist.md` Readiness Scorecard table reflects the
      latest CI run.
- [ ] Release notes embed the scorecard summary so downstream consumers can
      read the verification status without leaving the release page.

## Rollback plan

If a critical regression escapes after promotion:

1. Re-tag the previous release as `latest` for Docker / Homebrew.
2. Open an incident with the failure mode, link to
   `ops/readiness-scorecard.json` and `ops/perf-results.json` from the run
   that shipped the regression.
3. Reset the stabilization clock: the next promotion needs two more clean
   cycles before it can take the stable label.
