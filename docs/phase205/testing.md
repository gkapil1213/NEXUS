# Phase 205 Testing

## Suite

`scripts/test-phase205-execution-reconciliation.ts` — 22 assertions.

| ID | Scenario | Asserted |
|----|----------|----------|
| 205a | healthy running execution | action=ADVANCED; parent SUCCEEDED; both stages dispatched once |
| 205b | stale-attempt recovery | at least one attempt fenced; parent FAILED |
| 205c | retry-aware | parent stays RUNNING; retryPendingStages includes A; adapter not called |
| 205d | terminal failure | parent FAILED; downstream B not dispatched |
| 205e | cancellation | parent CANCELLED |
| 205f | concurrent race | final durable parent status SUCCEEDED; exactly one lifecycle event; stage dispatched exactly once |
| 205g | repeated reconciliation | 5 subsequent reconciles return NOOP_TERMINAL; exactly one lifecycle event |
| 205h | partial DAG | B and C dispatched; parent SUCCEEDED |
| 205i | restart durability | first reconcile SUCCEEDED; status survives reopen; second reconcile NOOP_TERMINAL |
| 205j | scan | returns running + cancelling parents; excludes terminal |

## Regression (unchanged)

Phase 201a 21, 201b 11, 202a 11, 202b 13, 202c 19, 202d 15, 202e 10,
203a 22, 203b 17, 203c 16, 203d 20, 203e 14, 204 18 — all green.

## Evidence

`scripts/phase205-evidence.ts` writes `artifacts/phase205/phase205-evidence.json`.

## Known limitations

- Retry scheduling on `FAILED` stages is not implemented; the reconciler
  observes RETRY_SCHEDULED but does not itself create one. Caller policy.
- Postgres shared-mode reconciliation not exercised; the reconciler's
  write path (`fenceStaleAttempt`, `recoverJobAtomic`) is sync-only today.