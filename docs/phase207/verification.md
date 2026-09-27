# Phase 207 - Verification

## TypeScript

npx tsc --noEmit --pretty false -> exit 0.

## Phase 207 test - shared PostgreSQL mode

npx tsx scripts/test-phase207-production-scheduler.ts

Result (real PostgreSQL, all scenarios driven through production APIs):

    PASS:        20
    FAIL:         0
    BLOCKED:      0
    NOT EXECUTED: 0

## Scenario coverage

| ID | Scenario | Result |
|---|---|---|
| 207A | kernel boot | PASS |
| 207B | scheduler status (pre-start) | PASS |
| 207C | shared-mode start | PASS |
| 207D | idempotent start | PASS |
| 207E | scheduler construct on kernel store | PASS |
| 207F | execution reconciliation | PASS |
| 207G | queued job admission | PASS |
| 207H | worker dispatch | PASS |
| 207I | lease acquisition exclusivity | PASS |
| 207J | dependency gating A->B | PASS |
| 207K | DAG progression A->B->C | PASS |
| 207L | fan-out A->B,A->C | PASS |
| 207M | fan-in B->D,C->D | PASS |
| 207N | duplicate tick protection | PASS |
| 207O | concurrent scheduler instances | PASS |
| 207P | worker race | PASS |
| 207Q | stale worker fencing | PASS |
| 207R | retry promotion | PASS |
| 207S | scheduler restart | PASS |
| 207T | end-to-end execution | PASS |

## Production APIs exercised

- DistributedScheduler.tick / dispatchTick / recoverStaleAttemptsTick
- ExecutionStore.admitNextJobAsync, atomicClaimJobAsync,
  dispatchAdmittedJobAsync, completeAttemptAndTransitionJobAsync,
  promoteDueRetriesAsync, recordAttemptHeartbeatAsOwnerAsync,
  fenceStaleAttemptAsync, listStaleAttemptsAsync
- AsyncStageDependencyStore.add / getDependencies
- isStageEligible (stage-eligibility.ts)
- NexusKernel.startDistributedScheduler / stopDistributedScheduler
- ExecutionEngine.recoverStaleJobs

## Test isolation

Every row created by this test uses the run prefix
phase207-<timestamp>-<random>. finish() deletes only rows whose job_id,
execution_id or worker_id matches that prefix. No pre-existing
production/test rows are modified by the test itself.

Note: recoverStaleAttemptsTick operates on all stale RUNNING attempts in
the shared database by design. Other pre-existing stale attempts may be
fenced as a side effect of exercising the production recovery path.

## Regression 201-206

All 15 scripts exit 0; see artifacts/phase207/regression-summary.json.
