# Phase 262 — Test results

## Environment

- Repository: `C:\Users\pc\NEXUS`
- Baseline HEAD: `98aa32b`
- PostgreSQL: local container `nexus-pg`, port 55432, database `nexus`
- `NEXUS_PERSISTENCE_MODE=shared`, `DATABASE_URL` pointed at the container
- Test runner: `tsx`

## Commands and results

### `npm run typecheck`

    > typecheck
    > tsc --noEmit

    TYPECHECK_EXIT=0

### `npm run test:phase261`

    11 checks, 0 failed
    PHASE261_EXIT=0

All existing Phase 261 checks still pass. The 261I stub was updated to
provide `transactionAsync` on the fake `store.asyncDb`, so the injected
claim failure surfaces through the new code path. No assertion was
weakened.

### `npm run test:phase262a`

    12 checks, 0 failed
    PHASE262A_EXIT=0

The output, verbatim:

    [PASS] 262.boot kernel boots in shared mode and wires drainer
    [PASS] 262A two drainers partition 5 rows with batchSize=3 (barrier) -- r1=3 r2=2; workers=2; disjoint=ok
    [PASS] 262B three drainers partition 10 rows with batchSize=4 (barrier) -- total=10 distribution=4/4/2; workers=3; disjoint=ok
    [PASS] 262C active unexpired claim is not stolen -- ghost owner preserved
    [PASS] 262D expired claim is recovered -- expired claim reclaimed and delivered
    [PASS] 262E failed claim transaction surfaces cause -- OutboxClaimError with cause preserved
    [PASS] 262F every delivered event appears exactly once -- 5 events, no duplicates
    [PASS] 262G 5 contention trials all partition correctly -- t0=4 t1=4 t2=4 t3=4 t4=4
    [PASS] 262H shutdown persists outbox_drain_on_shutdown; pool closed
    [PASS] 262I shutdown drain failure logged; pool closed; no throw
    [PASS] 262J emit failure logged; pool closed
    [PASS] 262K cleanup complete even when emit fails

### `npm run build`

    built in 6.93s
    BUILD_EXIT=0

### `git diff --check`

    DIFF_CHECK_EXIT=0

Two warnings about CRLF-to-LF normalization on
`engineering-run-event-drainer.ts` and `kernel.ts`. Content-preserving
normalizations; no whitespace errors.

## Test-by-test coverage

| ID | What it verifies | Backend |
|---|---|---|
| 262.boot | Kernel boots in shared mode; `store.hasAsyncBackend()` true | Real PostgreSQL |
| 262A | Two concurrent drainers each claim a disjoint subset of 5 eligible rows, batch size 3. Ownership observed at claim time via a barrier-gated `runService`; `claimed_by` read from the database while delivery is blocked. Asserts `workers=2`, union of owners covers all 5 rows, no overlap, all 5 delivered. | Real PostgreSQL |
| 262B | Same as 262A with 10 rows and 3 drainers, batch size 4. Asserts 3 distinct owners partition the 10 rows. | Real PostgreSQL |
| 262C | A row with an active unexpired claim is not stolen. | Real PostgreSQL |
| 262D | A row with an expired claim is reclaimed and delivered. | Real PostgreSQL |
| 262E | A transaction failure inside `claimBatch` surfaces as `OutboxClaimError` with the original cause preserved. | Injected fake (unit) |
| 262F | Every delivered event appears exactly once in `engineering_run_events`. | Real PostgreSQL |
| 262G | 5 independent contention trials all partition their 4 rows correctly. | Real PostgreSQL |
| 262H | Kernel boot + shutdown with a pending row persists `outbox_drain_on_shutdown` and closes the PostgreSQL pool. | Real PostgreSQL |
| 262I | A drain failure during shutdown is logged via `console.error("[engineering-outbox] Shutdown drain failed:", ...)`; pool still closes; `shutdown()` does not throw. | Real PostgreSQL |
| 262J | An event-persistence failure during shutdown is logged via `console.error("[engineering-outbox] Shutdown drain event persist failed:", ...)`; pool still closes; `shutdown()` does not throw. | Real PostgreSQL |
| 262K | Same scenario as 262J, plus assertion that the kernel's `status` is not `"failed"` and the pool is closed. | Real PostgreSQL |

Tests 262A–D, 262F, 262G, 262H–K run against real PostgreSQL. Test 262E
uses an injected fake `store.asyncDb` to force a transaction error; it
is a unit-level check and is labeled accordingly in the code.

## How the barrier tests prove disjoint ownership

`gatedRunService` wraps the real `EngineeringRunService`. Its
`recordStageExecutionEventWithId` awaits a Promise (`gate`) before
delegating, so both drainers can claim their rows and then block on the
first delivery call. The test polls
`SELECT count(*) ... WHERE claimed_by IS NOT NULL` until every eligible
row shows a claim, then reads `claimed_by` for each row while delivery
is still paused.

Because the schema stores a single `claimed_by` per row, disjointness
is proved by:

1. Every eligible row shows a non-null `claimed_by`.
2. The set of owners has at least 2 distinct worker ids (or exactly 3
   for 262B).
3. The union of per-owner row sets covers every eligible row, and its
   size equals the row count.

This is stronger than the earlier count-only form, which observed
`claimed_by` only after delivery had cleared it.

## What is not tested

- Multi-process concurrency. 262A/262B/262G exercise concurrency
  within one process via `Promise.all`. The claim SQL is safe by
  construction under PostgreSQL row locking, but a two-process race
  is not exercised by this suite.
- Long-running contention under sustained backlog.
- The `NEXUS_EXEC_RECONCILE_MS` periodic tick. The test file sets this
  env var to `0` before booting the outer kernel to prevent the tick
  from racing the barrier tests. See `known-limitations.md`.

## What "PASS" means

Every assertion checks observable state: either a persisted column
(`claimed_by`, `delivered_at`, `attempts`, `permanently_failed_at`) or a
captured `console.error` line. No assertion fabricates a result. No
test was marked PASS without being executed.
---

# Phase 262L — Outbox drain lifecycle coordination

## Commands and results

### `npm run typecheck`

    > typecheck
    > tsc --noEmit

    TYPECHECK_EXIT=0

### `npm run test:phase261`

    11 checks, 0 failed
    PHASE261_EXIT=0

### `npm run test:phase262a`

    12 checks, 0 failed
    PHASE262A_EXIT=0

### `npm run test:phase262l`

    3 checks, 0 failed
    PHASE262L_EXIT=0

The output, verbatim:

    [PASS] 262L-1 shutdown waits for in-flight startup drain before pool close -- startup drain awaited; pool closed after settle
    [PASS] 262L-2 shutdown waits for in-flight periodic drain before pool close -- periodic drain awaited; pool closed after settle
    [engineering-outbox] Failing test drain failed: 262L_injected_drain_failure
    [PASS] 262L-3 failed tracked drain is logged; pool still closed -- failed drain logged; pool closed

### `npm run build`

    built in 6.53s
    BUILD_EXIT=0

### `git diff --check`

    DIFF_CHECK_EXIT=0

Two CRLF-to-LF normalization warnings on
`engineering-run-event-drainer.ts` and `kernel.ts`. Content-preserving
normalizations; no whitespace errors.

## What each Phase 262L test proves

| ID | Property | Method |
|---|---|---|
| 262L-1 | `shutdown()` does not close the pool until an in-flight startup drain settles. | Boot a kernel. Track a 400ms promise on the kernel's private `outboxDrainsInFlight` set. Replace `pgClient.close` with a wrapper that records whether it was called before the tracked promise settled. Call `shutdown()`. Assert the wrapper never saw an unsettled drain, the promise settled before shutdown returned, and `getPgClient() === null`. |
| 262L-2 | Same property for an in-flight periodic drain. | Set `NEXUS_EXEC_RECONCILE_MS=100`, boot a kernel, replace the drainer's `drain` with a slow stub before the first tick, wait for the tick to invoke the stub, then shutdown with the same pool-close wrapper. |
| 262L-3 | A tracked drain that rejects is logged and does not skip pool cleanup. | Boot a kernel. Track a `Promise.reject(new Error("262L_injected_drain_failure"))`. Capture `console.error`. Call `shutdown()`. Assert shutdown did not throw, `getPgClient() === null`, and the log contains `[engineering-outbox] Failing test drain failed: 262L_injected_drain_failure`. |

## Failure mode addressed

Before Phase 262L, `kernel.ts:610` fired the eager startup drain with
`void this.engineeringOutboxDrainer.drain(...).catch(...)`, and the
periodic tick at `kernel.ts:400` did the same. Neither promise was
tracked. Either could still be executing when `shutdown()` or
`cleanupOnFailedBoot()` closed the PostgreSQL pool, producing
`[engineering-outbox] Startup drain failed: Error: PgClient: not
connected` in the log.

Phase 262L introduces `outboxDrainsInFlight` (a set of tracked
promises) and `outboxShuttingDown` (a gate), and awaits
`awaitInFlightOutboxDrains()` in both `_shutdown` and
`cleanupOnFailedBoot` before `pgClient.close()`. The shutdown drain
block from Phase 261/262B is preserved unchanged.

## What is still not tested

- Multi-process contention (recorded in `known-limitations.md`).
- `261A`'s claim-count assertion under a concurrent startup drain
  (recorded in `known-limitations.md`).
## Phase 262L hardening — shutdown stop-step tolerance

### `npm run test:phase262l`

    4 checks, 0 failed
    PHASE262L_EXIT=0

Test 262L-4 was added in the hardening pass:

    [PASS] 262L-4 a throwing stop-step does not skip pool cleanup -- stop-step failure tolerated; pool closed

It injects a throwing `driftObserver.stop`, calls `shutdown()`, and
asserts:

- `shutdown()` does not throw.
- `getPgClient() === null` after the failing step (pool closed).
- A second `shutdown()` call returns the memoized promise; no duplicate
  cleanup work; pool remains closed.

### Verification of `PgClient.withTransaction`

Inspected but not changed. The implementation:

    async withTransaction<T>(fn) {
      if (!this.pool) throw ...;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const r = await fn(client);
          await client.query("COMMIT");
          return r;
        } catch (e) {
          try { await client.query("ROLLBACK"); } catch { /* ignore */ }
          throw e;
        }
      } finally {
        client.release();
      }
    }

Commit on success, rollback on failure (rollback error swallowed to
preserve the original cause), unconditional release in `finally`.
`PgClient.close` is idempotent and swallows `p.end()` errors.

### Full-suite result after hardening

    typecheck      exit 0
    test:phase261  11 checks, 0 failed
    test:phase262a 12 checks, 0 failed
    test:phase262l 4 checks, 0 failed
    build          exit 0