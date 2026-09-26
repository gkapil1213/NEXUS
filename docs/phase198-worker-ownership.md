# Phase 198 — Worker Ownership Reconciliation

## Scope

Close the gap where shared/Postgres mode could not persist worker
heartbeat or progress. Before this phase, `recordHeartbeat` and
`recordProgress` on an async-backed store returned
`SHARED_MODE_NOT_IMPLEMENTED` without touching the database. Phase 197's
stall detector then saw every running attempt as stale after
`staleAttemptMs` and fenced the entire fleet.

## What changed

- `ExecutionStore.recordAttemptHeartbeatAsOwnerAsync` — new
- `ExecutionStore.recordAttemptProgressAsOwnerAsync` — new
- `ExecutionEngine.recordHeartbeat` / `recordProgress` now dispatch to
  the correct backend based on `store.hasAsyncBackend()`

The async twins use the **identical** WHERE predicate as their sync
counterparts, so the ownership boundary is the same on both backends:

    attempt.id = ?
    AND attempt.job_id = ?
    AND attempt.status = 'RUNNING'
    AND EXISTS (lease WHERE lease_id = ? AND worker_id = ? AND job_id = ?
                AND status = 'ACTIVE' AND expires_at > ?)

Zero-row updates are disambiguated by reading the attempt back:
`ATTEMPT_NOT_FOUND` if absent, `WORKER_OWNERSHIP_LOST` otherwise.
Ownership loss is never reported as success.

## Fencing model — unchanged

`execution_leases.lease_id` remains the fencing token. It is
per-acquisition (UUID), never reused, and the partial unique index
`idx_execution_leases_active_job` (migration 142) enforces at most one
ACTIVE lease per job at the database level. No generation/epoch was
added because no test demonstrated the immutable `lease_id` model to be
insufficient.

## Verified invariants (SQLite path)

Test suite: `scripts/test-phase198-ownership.ts` — 25 PASS / 0 FAIL.

| Invariant | Test |
|-----------|------|
| Valid owner heartbeat/progress mutates timestamps | A, B |
| Wrong worker rejected; timestamp unchanged | C, D |
| Expired lease rejected | E, F |
| Post-fence heartbeat/progress rejected | G |
| New worker acquires and mutates cleanly | H |
| Old worker cannot renew/heartbeat/progress after fence | I |

## BLOCKED

Test J (concurrent async lease acquisition against Postgres) is
`BLOCKED` on the current machine:

    [BLOCKED] S7 child exit=1 stderr=CHILD_FAIL: AggregateError
    [ECONNREFUSED]

Cause: `DATABASE_URL` is set but no Postgres server is listening on
that port. The child harness (`scripts/_phase198_pg_child.ts`) exists
and would run if a reachable Postgres were available. This is not a
code defect — it is the explicit missing-dependency case allowed by
the phase specification.

## Files touched

- `src/core/execution-store.ts` (+40 lines)
- `src/core/execution-engine.ts` (+6 lines, dispatch)
- `scripts/test-phase198-ownership.ts` (new)
- `scripts/_phase198_pg_child.ts` (new, BLOCKED harness)