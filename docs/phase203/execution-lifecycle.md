# Phase 203 Execution Lifecycle

## Per-stage sequence

    admission (dependency satisfied)
       ?
    acquireLease (CAS on execution_leases)
       ?
    transitionWithLease PENDING -> RUNNING
       ?
    createAttempt (status RUNNING, heartbeat seeded)
       ?
    adapter.execute(operation, context)
       ?
    transitionWithLease RUNNING -> SUCCEEDED | FAILED
       ?
    updateAttemptAsOwner (terminal status)
       ?
    releaseLease

## States used (existing StageStatus — unchanged)

`PENDING / RUNNING / SUCCEEDED / FAILED / CANCELLED / SKIPPED`

No new stage states were introduced. "Eligible" / "blocked" remain
derived concepts computed by `evaluateStageAdmission`.

## Adapter-throw handling

An adapter throw is treated as stage failure, not driver abort. The
driver catches, records the failure in the Summary, transitions the
stage to FAILED, finalizes the attempt, releases the lease, and
continues evaluating downstream stages. A flaky adapter cannot tear
down the whole graph.

## Cancellation

The driver reads the parent execution's `cancellation_requested` flag at
the top of every tick. If set, it returns `{ cancelled: true }` before
any dispatch. Cancellation mid-execution is not specially handled — the
adapter's outcome determines whether the stage is FAILED or SUCCEEDED,
and downstream admission then reflects that.

## Idempotency

Repeated `runStageGraphToCompletion` calls on a terminal graph produce
zero adapter calls and populate `skipped` with the terminal stage names
(203a S6, 203d S1, 203e S3/S4).