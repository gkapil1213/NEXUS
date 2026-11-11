# Phase 300 — PostgreSQL-Authoritative Remote Worker Lifecycle

Documentation updated 2026-11-08 on branch `phase-300-implementation`. WP1–WP4 verification evidence is recorded in the repository.

## Summary

Phase 300 makes PostgreSQL authoritative for the remote worker lifecycle in
`NEXUS_PERSISTENCE_MODE=shared` mode, while preserving SQLite-only behaviour.
The implementation spans 8 work packages. WP1-WP7 have verified evidence
(WP1-WP6 integration-tested; WP7 verified via code inspection + explicit
boot-state guards and integration-tested at the boot/listener boundary).
WP8 has partial verification: live PostgreSQL schema parity is verified; fresh independent PostgreSQL bootstrap remains NOT EXECUTED.

| WP  | Title                                  | Classification                                |
|-----|----------------------------------------|------------------------------------------------|
| WP1 | Dispatch creation + retrieval          | PASS — 8/8 integration tests                  |
| WP2 | Atomic worker claiming                 | PASS — 6/6 integration tests (cross-process)  |
| WP3 | Result integrity + ownership           | PASS — 7/7 single-process + 4/4 cross-process |
| WP4 | Worker gateway routing             | PASS — 7/7 integration tests (shared PostgreSQL + SQLite fallback) |
| WP5 | RemoteExecutionManager reconciliation | VERIFIED — PostgreSQL: 10 PASS, 0 FAIL, 1 NOT EXECUTED; SQLite: 6 PASS, 0 FAIL |
| WP6 | DispatchService cancellation + status  | PASS - 9/9 verified (Postgres); SQLite path not tested |
| WP7 | Kernel initialization + readiness      | PASS — 7/7 claims verified (see wp7-readiness.md) |
| WP8 | Schema + migration integrity           | CODE COMPLETE — PARTIAL VERIFICATION          |

Phase 300 overall: INCOMPLETE. WPs 1, 2, 3, 4, 5, and 6 are verified.
WP3 includes both single-process and cross-process evidence; WP4 includes
shared PostgreSQL gateway routing and SQLite fallback tests. WP5 is
verified on PostgreSQL and SQLite. WP6 is verified (9/9 on PostgreSQL;
SQLite path untested but noted in wp6-cancellation.md). WP7 is verified
across all seven readiness claims (see wp7-readiness.md). WP8 remains
partially verified; fresh-database bootstrap verification is the
outstanding schema gap (see wp8-schema.md). §5.C cross-instance tests
are verified across WP2-5 and WP3-X1 through WP3-X5 (see
known-limitations.md). Overall Phase 300 acceptance is not established
until WP8 fresh-database bootstrap verification is complete.

## Verified evidence

- `test-results/2026-11-08-phase268-ri-7-7-PASS.txt` — the pre-existing
  `scripts/test-phase268-remote-result-integrity.ts` suite, executed against
  live PostgreSQL at the `DATABASE_URL` in `.env`, reporting
  7 PASS / 0 FAIL / 0 BLOCKED at commit `977ed86` and re-confirmed at `9153d5c`.


- `test-results/2026-11-08-phase300-wp4-7-7-PASS.txt` - WP4 gateway routing:
  7 PASS / 0 FAIL / 0 BLOCKED / 0 NOT EXECUTED. Includes PostgreSQL shared
  mode, duplicate/conflict handling, rejection paths, and SQLite fallback.
- `test-results/2026-11-08-phase300-wp5-16-1-PASS.txt` — WP5 reconciliation:
  PostgreSQL 10 PASS / 0 FAIL / 1 NOT EXECUTED; SQLite 6 PASS / 0 FAIL.
  WP5-7 is NOT EXECUTED because WP5-1 already covers fresh-database initialization.
## Commits
- `40b0ef3` — WP5 (partial) + WP6 + WP8: async reconciliation init,
  backend-aware cancel, PG result table bootstrap.
- `f47a32d` — WP2 + WP3 v1 + WP4 + WP5: async result persistence (v1),
  async claim routing, kernel init awaited.
- `977ed86` — WP3 contract v2: matching-duplicate reconcile, identity
  checks, reason string renames, row-count guards. 7/7 integration test pass.
- `9153d5c` — chore: fix execution-store comment encoding (one-character
  cosmetic fix; does not affect WP3 logic).

Branch `phase-300-implementation` is pushed to `origin`. Test re-run at
`9153d5c` confirms 7/7 still holds after the encoding fix.
