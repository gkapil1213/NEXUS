# WP3 — Result integrity and ownership

**Classification: PASS — 8/8 single-process + 6/6 cross-process = 14/14**

Two independent test suites verify `persistRemoteExecutionResultAndDispatchAsOwnerAsync`:

- Single-process contract: `test-phase268-remote-result-integrity.ts` (8 cases).
- Cross-process durability and idempotency: `test-phase300-wp3-cross-process.ts` (6 cases).

## What was implemented

`ExecutionStore.persistRemoteExecutionResultAndDispatchAsOwnerAsync(result, dispatch, leaseId, workerId, now)` — a single PostgreSQL transaction that:

1. Enforces caller-identity invariants before opening the transaction:
   `dispatch.dispatchId === result.dispatchId`,
   `dispatch.jobId === result.jobId`,
   `(dispatch.attemptId ?? null) === (result.attemptId ?? null)`.
   Any disagreement returns `{ persisted: false, reason: "DISPATCH_IDENTITY_MISMATCH" }`
   with zero database operations.
2. Locks the dispatch row with `SELECT ... FOR UPDATE`.
3. Verifies the stored `dispatch.job_id === result.jobId`.
4. Verifies `dispatch.worker_id === workerId`.
5. Verifies `dispatch.lease_id === result.leaseId`.
6. Locks and validates the live lease: `status === 'ACTIVE'` and `expires_at > now`.
7. Detects existing results by `dispatch_id`. If a result row exists:
   - matching `result_sha256`: reconcile the dispatch row to terminal status
     and return `{ persisted: true, duplicate: true }`. No second result
     row is inserted. Missing digests on either side are NOT treated as
     sameness.
   - conflicting `result_sha256`: return `{ persisted: false, reason: "RESULT_CONFLICT" }`.
8. Inserts the durable result row with a row-count check, then updates the
   dispatch row to the caller-provided terminal status with a second
   row-count check.

Any rejection throws `AbortTx`, which rolls back the transaction. Any other
error propagates. A committed transaction therefore has both the result row
and the dispatch update applied atomically.

## Return contract

| Case | Return shape |
|---|---|
| Success (fresh insert) | `{ persisted: true, duplicate: false }` |
| Matching duplicate | `{ persisted: true, duplicate: true }` (dispatch reconciled) |
| Wrong worker / wrong lease | `{ persisted: false, reason: "WORKER_OWNERSHIP_LOST" }` |
| Caller id mismatch | `{ persisted: false, reason: "DISPATCH_IDENTITY_MISMATCH" }` |
| Lease expired | `{ persisted: false, reason: "LEASE_EXPIRED" }` |
| Conflicting duplicate | `{ persisted: false, reason: "RESULT_CONFLICT" }` |

## Test evidence — Suite 1: single-process contract (7/7)

`scripts/test-phase268-remote-result-integrity.ts` — 7 cases against live
PostgreSQL at `DATABASE_URL`. Verified at commit `977ed86` and re-confirmed
at `9153d5c`.

| # | Case | Result |
|---|---|---|
| 268-ri-A | Wrong worker rejected | PASS |
| 268-ri-B | Wrong lease rejected | PASS |
| 268-ri-C | Matching duplicate is idempotent, dispatch reconciled | PASS |
| 268-ri-D | Conflicting duplicate preserves original | PASS |
| 268-ri-E | Concurrent submissions (Promise.all, one process) have one winner | PASS |
| 268-ri-F | Mismatched dispatch job identity rejected | PASS |
| 268-ri-G | Mismatched result attempt identity rejected | PASS |
| 268-ri-H | Native PostgreSQL BOOLEAN false persists correctly | PASS |

Latest evidence: `test-results/2026-11-11-phase268-ri-8-8-PASS.txt`. Summary: 8 PASS, 0 FAIL, 0 BLOCKED.

## Test evidence — Suite 2: cross-process (6/6)

`scripts/test-phase300-wp3-cross-process.ts` — 6 cases against an isolated
PostgreSQL database. Each case spawns one or two independent Node processes
(via `child_process.spawn`), each with its own `PgClient` pool to the isolated
DB.

| # | Case | Result |
|---|---|---|
| WP3-X1 | A result written by process A is visible to process B | PASS |
| WP3-X2 | Two processes submit identical result concurrently; one row; other sees duplicate | PASS |
| WP3-X3 | Two processes submit conflicting results; one row; other rejected RESULT_CONFLICT | PASS |
| WP3-X4 | Sequential identical submits across processes yield idempotent duplicate | PASS |
| WP3-X5A | Late result cannot overwrite CANCELLED | PASS |
| WP3-X5B | Cancellation cannot overwrite committed result | PASS |

Latest evidence: `test-results/2026-11-11-phase300-wp3-cross-process-6-6-PASS.txt`. Summary: 6 PASS, 0 FAIL, 0 BLOCKED, 0 NOT EXECUTED.

## Combined coverage

- 14 passing checks across the two latest suites.
- 8 single-process checks, including native PostgreSQL BOOLEAN persistence.
- 6 cross-process checks, including both cancellation/result race orderings.
- Older 7/7 and 4/4 reports are historical evidence and remain preserved.

## What is NOT verified

- PostgreSQL unavailability during result persistence (the "database error
  propagation" case) is not exercised by either suite. Section 7's failure-path
  requirement would need a deliberately-broken connection mid-transaction.
  Not currently in scope; can be added if §3's interpretation requires it.
