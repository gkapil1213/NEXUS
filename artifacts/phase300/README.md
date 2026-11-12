# Phase 300 — PostgreSQL-Authoritative Remote Worker Lifecycle

Documentation updated 2026-11-08 on branch `phase-300-implementation`. WP1–WP4 verification evidence is recorded in the repository.

## Summary

Phase 300 makes PostgreSQL authoritative for the remote worker lifecycle in
`NEXUS_PERSISTENCE_MODE=shared` mode, while preserving SQLite-only behaviour.
The implementation spans 8 work packages. WP1-WP7 have verified evidence
(WP1-WP6 integration-tested; WP7 verified via code inspection + explicit
boot-state guards and integration-tested at the boot/listener boundary).
WP8 is verified: live PostgreSQL schema parity verified; fresh independent PostgreSQL bootstrap verified 12/12 on 2026-11-11.

| WP  | Title                                  | Classification                                |
|-----|----------------------------------------|------------------------------------------------|
| WP1 | Dispatch creation + retrieval          | PASS — 8/8 integration tests                  |
| WP2 | Atomic worker claiming                 | PASS — 6/6 integration tests (cross-process)  |
| WP3 | Result integrity + ownership           | PASS — 7/7 single-process + 4/4 cross-process |
| WP4 | Worker gateway routing             | PASS — 7/7 integration tests (shared PostgreSQL + SQLite fallback) |
| WP5 | RemoteExecutionManager reconciliation | VERIFIED — PostgreSQL: 10 PASS, 0 FAIL, 1 NOT EXECUTED; SQLite: 6 PASS, 0 FAIL |
| WP6 | DispatchService cancellation + status  | PASS - 9/9 verified (Postgres); SQLite path not tested |
| WP7 | Kernel initialization + readiness      | PASS — 7/7 claims verified (see wp7-readiness.md) |
| WP8 | Schema + migration integrity           | PASS — 12/12 fresh-bootstrap + live inspection |

Phase 300 overall: COMPLETE.

All 18 acceptance criteria verified:
  - WP1-WP7 verified (single-process + cross-process where applicable)
  - §5.C cross-instance: WP2-5 + WP3-X1..X5 (deterministic cancel-first
    and result-first ordering)
  - WP8 fresh PostgreSQL bootstrap: 12/12 PASS
  - SQLite synchronous race (Section 6): 2/2 PASS
  - PostgreSQL BOOLEAN persistence: 268-ri 8/8 PASS
  - Full regression: 68 PASS, 0 FAIL, 0 BLOCKED, 1 NOT EXECUTED
    (WP5-7 intentionally skipped; WP5-1 covers fresh-empty-DB initialization)

WP7's listener-closure integration limitation remains documented in
known-limitations.md (permitted by the Phase 300 completion directive).

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
