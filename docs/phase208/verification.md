# Phase 208 - Verification

Command:

    NEXUS_PERSISTENCE_MODE=shared DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
      npx tsx scripts/test-phase208-worker-execution-runtime.ts

Result (three consecutive runs):

    PASS:        20
    FAIL:         0
    BLOCKED:      0
    NOT EXECUTED: 0
    exit=0

## Scenario coverage

| ID | Scenario | Production APIs exercised |
|---|---|---|
| 208A | execution runtime initialization | NexusKernel.boot() |
| 208B | worker-owned execution | admitNextJobAsync, dispatchAdmittedJobAsync |
| 208C | heartbeat durability | recordAttemptHeartbeatAsOwnerAsync |
| 208D | progress durability | recordAttemptProgressAsOwnerAsync |
| 208E | successful completion | completeAttemptAndTransitionJobAsync |
| 208F | failed completion | completeAttemptAndTransitionJobAsync (FAILED) |
| 208G | cancellation | completeAttemptAndTransitionJobAsync (CANCELLED) |
| 208H | result persistence | getAttemptResultAsync, getExecutionResultAsync |
| 208I | artifact persistence | completeAttemptAndTransitionJobAsync(artifacts) |
| 208J | completion idempotency | second completion returns idempotent |
| 208K | concurrent completion race | two completions, exactly one applied |
| 208L | stale worker completion rejection | recoverStaleAttemptsTick then rejection |
| 208M | timeout detection | recoverStaleAttemptsTick (heartbeat past window) |
| 208N | late completion after timeout rejection | rejected |
| 208O | retry after execution failure | completeAttemptAndTransitionJobAsync + promoteDueRetriesAsync |
| 208P | retry creates new attempt | attempt#1 and attempt#2, distinct ids |
| 208Q | restart durability | second NexusKernel observes state |
| 208R | reconciliation after worker failure | recoverStaleAttemptsTick |
| 208S | concurrent recovery/completion race | recoverStaleJobs + completion concurrently |
| 208T | end-to-end execution lifecycle | full path incl. provenance + artifact |

## Regression

All 16 previous scripts (201, 202, 203A-E, 204, 205, 206, 207) exit 0 in shared mode.
See artifacts/phase208/regression-summary.json.

## Known limitations

- The test uses unique 'phase208-<timestamp>-<random>' prefixes and cleans up after
  itself. recoverStaleAttemptsTick scans the whole shared database by design, so it
  may fence other stale attempts during a Phase 208 run.
- 'Real execution' means the worker-side driver is exercised through the production
  attempt/lease/completion APIs; no remote runtime adapter is launched. The
  completeAttemptAndTransitionJobAsync call is the same call a real adapter would
  make; it just runs in-process.
