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

## Test J — async lease race (Postgres)

PASS: `[PASSED] J exactly one ACTIVE lease wins`, `[PASSED] J loser sees
{ acquired: false }`, `[PASSED] J single ACTIVE lease in DB`.

Running the S7 harness against a live Postgres surfaced three latent
defects in the shared-backend code path. All three are fixed and the
race now passes end-to-end:

1. `ExecutionStore.acquireLeaseAsync` passed parameterized SQL
   (`... WHERE job_id = ? ...`) to `tx.execAsync(sql)` — which accepts
   no parameters. Postgres rejected the unsubstituted `?` with a
   syntax error. Fixed to use `tx.prepareAsync(sql).run(jobId,
   acquiredAt)`, matching the convention used by every other
   parameterized async method in the store.

2. `bootstrapPgSchema` (`src/core/pg-bootstrap.ts`) executed
   `ALTER TABLE execution_attempts ADD COLUMN ... heartbeat_at`
   before the corresponding `CREATE TABLE execution_attempts`, causing
   `relation "execution_attempts" does not exist`. The CREATE and its
   `idx_attempts_job` index now precede the ALTER.

3. `acquireLeaseAsync`'s duplicate-key handler ran a follow-up
   `SELECT` inside the same `transactionAsync` block as the failed
   `INSERT`. Postgres aborts a transaction on any statement failure,
   so the follow-up read was rejected with
   `current transaction is aborted`. The try/catch now wraps the
   `transactionAsync` call instead of living inside it, so the
   duplicate-key check runs after rollback on a fresh connection
   state.

Test J is self-contained: S7 applies `bootstrapPgSchema` (idempotent)
before spawning the child.

## Files touched

- `src/core/execution-store.ts` (+40 lines)
- `src/core/execution-engine.ts` (+6 lines, dispatch)
- `scripts/test-phase198-ownership.ts` (new)
- `scripts/_phase198_pg_child.ts` (new, BLOCKED harness)