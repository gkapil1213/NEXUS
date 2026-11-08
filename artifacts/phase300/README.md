# Phase 300 — PostgreSQL-Authoritative Remote Worker Lifecycle

Status as of 2026-11-08, commit `9153d5c` on branch `phase-300-implementation`.

## Summary

Phase 300 makes PostgreSQL authoritative for the remote worker lifecycle in
`NEXUS_PERSISTENCE_MODE=shared` mode, while preserving SQLite-only behaviour.
The implementation is code-complete across 8 work packages, but only one
work package (WP3) has been verified against a live integration test in this
session.

| WP  | Title                                  | Classification                                |
|-----|----------------------------------------|------------------------------------------------|
| WP1 | Dispatch creation + retrieval          | PASS — 8/8 integration tests                  |
| WP2 | Atomic worker claiming                 | CODE COMPLETE — NOT TEST VERIFIED             |
| WP3 | Result integrity + ownership           | PASS — 7/7 integration tests                  |
| WP4 | Worker gateway routing                 | CODE COMPLETE — PARTIALLY EXERCISED           |
| WP5 | RemoteExecutionManager reconciliation  | CODE COMPLETE — NOT TEST VERIFIED             |
| WP6 | DispatchService cancellation + status  | CODE COMPLETE — NOT TEST VERIFIED             |
| WP7 | Kernel initialization + readiness      | PARTIAL — startGateway boundary not inspected |
| WP8 | Schema + migration integrity           | CODE COMPLETE — PARTIAL VERIFICATION          |

Phase 300 overall: INCOMPLETE. WP1 and WP3 are verified. WPs 2, 4, 5, 6, 8
are code-complete but not test-verified. WP7 is partial. This is the honest
state per section 7 of the Phase 300 specification.

## Verified evidence

- `test-results/2026-11-08-phase268-ri-7-7-PASS.txt` — the pre-existing
  `scripts/test-phase268-remote-result-integrity.ts` suite, executed against
  live PostgreSQL at the `DATABASE_URL` in `.env`, reporting
  7 PASS / 0 FAIL / 0 BLOCKED at commit `977ed86` and re-confirmed at `9153d5c`.

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
