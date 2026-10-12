# Phase 262 — Known limitations

## 1. Multi-process claim contention is unverified

Tests 262A, 262B, and 262G exercise concurrent drainers inside one
process using `Promise.all`. The claim SQL is safe across processes by
construction — `FOR UPDATE SKIP LOCKED` partitions locked rows at the
PostgreSQL level, and the subsequent `UPDATE ... WHERE outbox_id =
ANY(...)` targets exactly the locked ids.

A two-process integration test that spawns two independent `tsx`
children and races them on the same outbox table is not present. The
existing Phase 183a suite covers cross-process idempotency for a
different table (`nexus_idempotency_keys`), which shares the same
PostgreSQL locking primitives, but does not directly exercise the
outbox.

Status: NOT EXECUTED for multi-process contention.

## 2. The test file disables the kernel's periodic reconcile tick

`scripts/test-phase262-outbox-claim-concurrency.ts` sets
`NEXUS_EXEC_RECONCILE_MS=0` before booting the outer kernel (in
`main()`). This disables the `executionReconcileTimer` at
`kernel.ts:396`.

Reason: the periodic tick calls
`this.engineeringOutboxDrainer.drain(...)` with the real (non-gated)
`runService`. During 262A and 262B the tick would occasionally claim
and deliver some of the test's rows before the barrier observed them,
breaking the disjointness assertion and producing an unpredictable
`total claimed` value.

Consequence: the tests do not exercise the periodic reconcile tick. The
kernel's eager startup drain at `kernel.ts:610` still runs at boot, and
the shutdown drain at `kernel.ts:1254` still runs at shutdown, so both
of those paths are covered (262H–K).

The production default for `NEXUS_EXEC_RECONCILE_MS` is unchanged.

## 3. Startup-drain failure logs could outlive their kernel (addressed in Phase 262L)

Before Phase 262L, `kernel.ts:610` fired the eager startup drain with
`void` and a `.catch`, and the periodic tick at `kernel.ts:400` did the
same. Neither promise was tracked. Either could still be executing when
the kernel's PostgreSQL pool was closed — by `shutdown()` or by
`cleanupOnFailedBoot()` after a failed boot — producing
`[engineering-outbox] Startup drain failed: Error: PgClient: not
connected` or `... timeout exceeded when trying to connect`.

This is not a test-only pattern: the same window exists in production
if `shutdown()` is called soon after boot, or if a boot fails and
`cleanupOnFailedBoot` runs while the startup drain is in flight.

Phase 262L closes the hole. Startup, periodic, and shutdown drains are
now tracked in `outboxDrainsInFlight`. Both `_shutdown` and
`cleanupOnFailedBoot` set `outboxShuttingDown` and await
`awaitInFlightOutboxDrains()` before closing the pool. The tracked
promises carry a `.catch` that logs failures via
`console.error("[engineering-outbox] <label> failed:", ...)`, so a
failure remains observable.

Tests `262L-1`, `262L-2`, and `262L-3` prove the ordering and the
failure-observability properties.

## 4. `= ANY($1)` parameter binding requires a compatible driver

The claim update binds a JavaScript `string[]` to `WHERE outbox_id =
ANY($1)`. This relies on `node-postgres` serializing the array as a
PostgreSQL `text[]` parameter. Verified in this environment:

- `pg` driver version: 8.23.0
- Column `outbox_id` type: `text`
- `SELECT unnest($1::text[])` with a JS string array returns the
  expected rows

If the driver is ever downgraded or replaced with a non-`pg`
implementation that does not support array binding, the claim update
will fail. A future change to `PgClient` or `PgAsyncEngine` should
re-verify this.

## 5. `PgClient` pool `max: 10` is not raised for the test file

The test file boots five kernels in sequence (the outer `kernel` in
`main()`, plus one per test in 262H, 262I, 262J, 262K). Each kernel
opens its own `PgClient` with `max: 10`, and each is closed at
shutdown. During the shutdown window, a kernel's pool may still be
releasing connections while the next kernel opens its own.

The `PgClient` `max` was not raised for the tests. Increasing it would
require either an env var or a source change and was judged out of
scope. The tests pass reliably in this environment at `max: 10`, but
the occasional `timeout exceeded when trying to connect` in the
transcript (from a straggler startup drain) shows the pool is near its
budget.

Production impact: none. A production process runs one kernel.

## 6. The 261I stub update is a Phase 261 test change

`scripts/test-phase261-outbox-drainer.ts` was modified: the 261I stub
now provides `transactionAsync` on the fake `store.asyncDb`, since
`claimBatch` runs through `transactionAsync` after Phase 262. The
assertion ("claim errors surface with the original cause preserved")
is unchanged.

This was necessary because the drainer's public interaction with
`asyncDb` changed. No Phase 261 check was weakened, deleted, or
relabeled. `test:phase261` still passes 11/11.

## 7. Commit and push are deliberately withheld

Per the brief, the working tree is left for review. `git status --short`:

    M package.json
    M scripts/test-phase261-outbox-drainer.ts
    M src/core/engineering-run-event-drainer.ts
    M src/core/kernel.ts
    ?? scripts/test-phase262-outbox-claim-concurrency.ts

No commit, no push.

## 8. Startup drain does not filter by run prefix

The kernel's eager startup drain at `kernel.ts:610` drains the entire
outbox table, not a per-run subset. This is correct production behavior
(a restarted process should pick up any pending row), but it has test
consequences:

1. The barrier tests need a fresh database state or a way to control
   which rows are due. They solve this by inserting rows immediately
   before their test body runs and by disabling the periodic tick.
2. The shutdown tests (262H–K) insert their rows with a future
   `next_attempt_at` so the eager startup drain skips them, then update
   the row to be due before shutdown. Without this, the row would be
   delivered by the startup drain and the shutdown path would see no
   work.

A cleaner design would let the test inject a startup-drain skip flag
into the kernel. That is a source change and is out of scope.
## 9. `261A` can flake under concurrent startup drain

`scripts/test-phase261-outbox-drainer.ts` `261A` inserts an
undelivered outbox row and immediately asserts `drainer.drain()`
returned `claimed >= 1`. If the kernel's eager startup drain at
`kernel.ts:610` is still in flight — it is `void`-fired at boot and
runs concurrently with the test body — it can claim the row before
`261A`'s own `drain()` call. In that case the row is still delivered
(by the startup drain), but the assertion fails because `261A`'s
`drain()` sees `claimed = 0`.

Observed once during Phase 262L development (two tests failed on one
run, then passed on immediate rerun; pending-row diagnostic confirmed
the outbox was empty between runs). The failure is timing-dependent
and pre-exists Phase 262L.

Not addressed in Phase 262L to avoid changing a Phase 261 test
outside this phase's scope. If this becomes a recurring flake, the
correct fix is to poll the row for `delivered_at IS NOT NULL` instead
of asserting on the claim counter — this tests the same property
("the row is delivered") without racing the kernel's startup drain.

## 10. `shutdown()` is memoized: a kernel cannot be reused after shutdown

Phase 262L wraps `shutdown()` with a `shutdownPromise` memoization so
repeated calls return the same promise and do not run cleanup twice.
The consequence: after the first `shutdown()` completes, the kernel's
`shutdownPromise` remains set, `outboxShuttingDown` stays true, and
`bootPromise` has been cleared by `_shutdown`. Calling `boot()` again
on the same instance is not supported and will not restore the
kernel to a running state.

This matches the pre-existing lifecycle: `_shutdown` already cleared
`bootPromise` and left the kernel in a terminal state. Phase 262L
makes it explicit and caches the shutdown promise for idempotency.
Callers that need a fresh kernel must construct a new instance.
## 11. `_shutdown` stop-steps could skip pool cleanup (fixed in Phase 262L hardening)

Before the Phase 262L hardening pass, three calls in
`NexusKernel._shutdown` ran outside any try/catch:

- `await this.stopDistributedScheduler()`
- `await this.stopDriftObserver()`
- `await this.stopRecoverySupervisor({ finalPass })`

The helper methods behind `stopDriftObserver` and `stopRecoverySupervisor`
invoke the underlying supervisor's `stop()` directly, with no internal
guard. If either rejected, `_shutdown` would throw before reaching
`pgClient.close()`, leaving the PostgreSQL pool open. This was
inconsistent with `cleanupOnFailedBoot`, which already wrapped each of
these calls in `try { ... } catch { /* best-effort */ }`.

Fixed by wrapping each stop-step in `_shutdown` with the same pattern.
`stopGateway()`, which runs after pool close, was wrapped as well for
consistency; a failure there does not affect pool cleanup but is now
tolerated for symmetry with `cleanupOnFailedBoot`.

Test `262L-4` covers the property. It injects a throwing
`driftObserver.stop`, calls `shutdown()`, and asserts that shutdown
does not throw, `getPgClient() === null` after the failure, and a
repeated shutdown returns the memoized result without re-running
cleanup.

`PgClient.withTransaction` was also inspected during this review and
requires no change: it commits on success, rolls back on failure (with
rollback errors swallowed to preserve the original cause), and releases
the connection unconditionally in a `finally` block. `PgClient.close`
is idempotent (nulls the pool reference before awaiting `end()`).