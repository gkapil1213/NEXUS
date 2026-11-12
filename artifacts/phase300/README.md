# Phase 300 — PostgreSQL-Authoritative Remote Worker Lifecycle

Documentation reconciled 2026-11-12 on branch `phase-300-implementation`. WP1–WP4 verification evidence is recorded in the repository.

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
| WP3 | Result integrity + ownership           | PASS — 8/8 single-process + 6/6 cross-process |
| WP4 | Worker gateway routing             | PASS — 7/7 integration tests (shared PostgreSQL + SQLite fallback) |
| WP5 | RemoteExecutionManager reconciliation | VERIFIED — PostgreSQL: 10 PASS, 0 FAIL, 1 NOT EXECUTED; SQLite: 6 PASS, 0 FAIL |
| WP6 | DispatchService cancellation + status  | PASS — 10/10 PostgreSQL; SQLite methods not directly tested |
| WP7 | Kernel initialization + readiness      | PASS — 7/7 claims verified (see wp7-readiness.md) |
| WP8 | Schema + migration integrity           | PASS — 12/12 fresh-bootstrap + live inspection |

Implementation evidence: recorded for WP1-WP8 against reconstructed scope; formal completion against the original acceptance directive: NOT VERIFIED.

Acceptance criteria: reconstructed from surviving repository evidence; the original completion directive was not located.
  - WP1-WP7 verified (single-process + cross-process where applicable)
  - Cross-instance evidence includes WP3-X1..X5A and WP3-X5B (deterministic cancel-first
    and result-first ordering)
  - WP8 fresh PostgreSQL bootstrap: 12/12 PASS
  - SQLite synchronous race (Section 6): 2/2 PASS
  - PostgreSQL BOOLEAN persistence: 268-ri 8/8 PASS
  - Full regression: 68 PASS, 0 FAIL, 0 BLOCKED, 1 NOT EXECUTED
    (WP5-7 intentionally skipped; WP5-1 covers fresh-empty-DB initialization)

WP7's listener-closure integration limitation remains documented in
known-limitations.md.

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
## Latest standalone evidence — 2026-11-12

- `test-results/2026-11-11-phase268-ri-8-8-PASS.txt` — WP3 single-process, 8/8 PASS.
- `test-results/2026-11-11-phase300-wp3-cross-process-6-6-PASS.txt` — WP3 cross-process, 6/6 PASS.
- `test-results/2026-11-12-phase300-wp4-gateway-routing-7-7-PASS.txt` — WP4 real gateway routing, 7/7 PASS.
- `test-results/2026-11-12-phase300-wp6-cancellation-status-10-10-PASS.txt` — WP6 cancellation/status, 10/10 PASS.

These standalone runs are additional evidence, not additions to the November 11 aggregate.

## Commits
- `40b0ef3` — WP5 (partial) + WP6 + WP8: async reconciliation init,
  backend-aware cancel, PG result table bootstrap.
- `f47a32d` — WP2 + WP3 v1 + WP4 + WP5: async result persistence (v1),
  async claim routing, kernel init awaited.
- `977ed86` — WP3 contract v2: matching-duplicate reconcile, identity
  checks, reason string renames, row-count guards. 7/7 integration test pass.
- `9153d5c` — chore: fix execution-store comment encoding (one-character
  cosmetic fix; does not affect WP3 logic).

The original 18-criterion completion directive was not found in the repository or supplied separately. The reconstructed evidence map must not be represented as a recovered original acceptance list. The November 11 Section 8 aggregate is 68 PASS, 0 FAIL, 0 BLOCKED, and 1 documented NOT EXECUTED. November 12 WP4 and WP6 reruns are separate evidence and are not included in that aggregate.

Branch `phase-300-implementation` is pushed to `origin`. Test re-run at
`9153d5c` confirms 7/7 still holds after the encoding fix.
