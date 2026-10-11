# Phase 261 — Transaction boundaries and atomicity audit

## Scope

This document traces every production call site that writes to
`engineering_run_events` or to `engineering_run_event_outbox`, classifies
each by its transaction boundary, and states what atomicity the outbox
actually provides. It does not claim universal atomicity for the
engineering-run event stream.

Phase 261a's atomicity audit (commit `0d2f4e9`) produced the raw
evidence; this document expands it into the form Phase 260's
`transaction-boundaries.md` used for its own scope.

## The atomic path — `markStageJob`

### Location

`src/core/engineering-stage-executor.ts:543` — `markStageJob` is the
`private` helper that applies a terminal transition to a stage's
`execution_jobs` row and (in Phase 261) writes the corresponding outbox
intent.

At line 564 it calls `this.deps.store.recoverJobAtomicAsync({...})` and
passes an `outboxEvent` payload alongside the CAS. It is the only
production caller that does so.

### Transaction structure

`execution-store.ts:895` — `recoverJobAtomicAsync` wraps its body in a
single `engine.transactionAsync(async (tx) => {...})`. Inside that
callback, in order:

    1. tx.prepareAsync(`UPDATE execution_jobs SET ...`).run(...)
         → CAS transition. If changes === 0, the callback returns early
           and the transaction commits with no writes.

    2. optional: tx.prepareAsync(`INSERT INTO execution_ownership_obligations ...`)

    3. await this.addEventOnEngine(tx, { ... })   // execution_events row

    4. tx.prepareAsync(`INSERT INTO engineering_run_event_outbox ...`).run(...)
         → only when input.outboxEvent is provided.

`PgAsyncEngine.transactionAsync` creates a per-transaction sub-engine
that routes every query through the same pool client
(`pg-async-engine.ts:47`). Because all four statements run through `tx`,
they share a single connection and a single transaction. Commit or
rollback applies to all of them.

### What this proves

- The job transition, the execution-layer audit row, and the outbox
  intent cannot diverge on commit. If the CAS succeeds, all three are
  durable. If the CAS rejects (concurrent worker took the row), none of
  the four writes happen.
- A crash after commit but before any drain leaves the outbox row in
  place. The next process delivers it under the at-least-once contract.
- The `execution_events` row and the outbox row are ordered the same
  way: both are written after the CAS succeeds, both inside the same
  transaction.

### Evidence

- Test `261A` — an undelivered outbox row is delivered by a fresh
  drain and the destination `engineering_run_events` row is created.
- Test `261B` — a second drain of the same row claims zero rows and
  produces no duplicate `engineering_run_events` row.

## The drainer's destination

### Location

`src/core/engineering-run-service.ts:481` —
`recordStageExecutionEventWithId`. This is called only by the drainer.
The `engineering_run_events` INSERT happens inside a `withPg` block on
a fresh `PgClient` connection, outside the job-transition transaction.

### Why this is correct

The outbox row is the durability handle. Once it commits, delivery can
happen on any later connection at any later time. The `event_id` field
makes the destination write idempotent:

    INSERT INTO engineering_run_events (...) VALUES (...)
    ON CONFLICT (event_id) DO NOTHING

If the drain retries because the destination committed but the ack did
not, the second attempt is a no-op at the destination. There is no
requirement for the destination write to be atomic with anything — the
atomicity was established at intent-creation time.

### What this does not prove

The destination write is not atomic with the `outbox` ack. Between a
successful destination INSERT and the corresponding `markDelivered`
UPDATE, the row is in a state where:

- `engineering_run_events` has the row.
- The outbox row is still undelivered and still claimed.

If the process crashes in this window, the lease expires, the row is
re-claimed, and delivery is re-attempted. The destination INSERT is a
no-op under `ON CONFLICT`. `markDelivered` then succeeds. Result: the
destination has exactly one row, the outbox eventually records
delivery. Correct.

## CAS-only callers of `recoverJobAtomicAsync`

These callers use `recoverJobAtomicAsync` without passing
`outboxEvent`. They write neither to `engineering_run_event_outbox` nor
to `engineering_run_events` in that call. The transaction still writes
`execution_jobs` and `execution_events` atomically, but no run-event
intent.

| Caller | File:line | Notes |
|---|---|---|
| `DistributedScheduler.tick` | `distributed-scheduler.ts:219` | Recovery scheduler; unrelated to engineering-run events |
| `ExecutionEngine` | `execution-engine.ts:814` | Passthrough wrapper — takes `input` and forwards it; whether an outbox row is written depends on the caller |
| `ExecutionFinalizer` | `execution-finalizer.ts:133` | Terminal-status writer for non-engineering jobs |

None of these are in scope for Phase 261. They neither depend on nor
produce engineering-run events. The `execution-engine.ts:814` passthrough
is worth noting because if a future caller passes `outboxEvent` through
it, the write path would be atomic — but no current caller does.

## Direct writers of `engineering_run_events`

These files emit `INSERT INTO engineering_run_events` outside any
`recoverJobAtomicAsync` transaction. They do not go through the outbox.
Their writes are not atomic with any job CAS because they do not
correspond to a job-status transition — they emit progress and audit
events.

| File:line | Event class |
|---|---|
| `engineering-build-executor.ts:210` | Build-stage progress |
| `engineering-diagnosis-executor.ts:110` | Diagnosis-stage progress |
| `engineering-implementation-orchestrator.ts:90` | Implementation progress |
| `engineering-planning-orchestrator.ts:534` | Planning progress |
| `engineering-release-ready-executor.ts:83` | Release-readiness progress |
| `engineering-repair-executor.ts:108` | Repair-stage progress |
| `engineering-security-review-executor.ts:107` | Security-review progress |
| `engineering-test-executor.ts:210` | Test-stage progress |

### Why these are not a Phase 261 defect

The outbox exists to close the partial-persistence gap for events that
must correspond to a job-status transition. If the transition commits
but the event does not, the reconciler sees `MISSING_RUN_EVENT` for a
stage whose job is terminal — a genuinely inconsistent durable state
that needs detection and, per Phase 260, eventual repair.

Progress events are a different shape. They have no corresponding
status transition. If a progress event is lost, no durable inconsistency
results: the stage's job status is unchanged, and the missing event is
an audit gap rather than a correctness gap. The reconciler does not look
for them.

Making progress events durable-at-least-once would require each
orchestrator step to own a transaction boundary that includes the
progress write. That is a broader refactor of the orchestrator step
lifecycle — out of scope for Phase 261, and not required to close the
Phase 260 §1 gap. See `phase260-handoff.md` for what portion of Phase
260's exposure this leaves open.

## Dead code

`src/core/engineering-run-service.ts:466` —
`recordStageExecutionEvent` (the non-`WithId` variant). It writes
`engineering_run_events` with a freshly generated `event_id`, but it has
no production caller. The drainer uses the `WithId` variant. The
non-`WithId` variant exists only as a legacy API surface.

A grep for `recordStageExecutionEvent(` (with the trailing paren and
without `WithId`) returns only the declaration. No caller exists.

## Summary table

| Path | Writes outbox? | Writes run_events? | Atomic with job CAS? | In scope? |
|---|---|---|---|---|
| `markStageJob` → `recoverJobAtomicAsync({outboxEvent})` | Yes | No (delegates to drainer) | Yes | Yes |
| Drainer → `recordStageExecutionEventWithId` | No | Yes | N/A (idempotent on `event_id`) | Yes |
| DistributedScheduler → `recoverJobAtomicAsync` (no outbox) | No | No | N/A | No |
| ExecutionEngine passthrough | Depends on caller | No | Depends on caller | No |
| ExecutionFinalizer → `recoverJobAtomicAsync` (no outbox) | No | No | N/A | No |
| Eight direct writers (executors/orchestrators) | No | Yes | No (no corresponding CAS) | No |
| `recordStageExecutionEvent` (non-WithId) | No | Yes (if called) | No | Dead code |

## What "atomic" means in Phase 261

Phase 261 claims atomicity for exactly one condition: **the job CAS,
its `execution_events` audit row, and its outbox intent commit as one
unit when `markStageJob` is the caller.** Nothing broader is claimed.

Phase 261 does not claim atomicity for:

- Progress events emitted by orchestrators.
- Delivery from the outbox to `engineering_run_events`.
- Any write outside `markStageJob`'s call to `recoverJobAtomicAsync`.

Any future extension of atomicity to the direct writers would need its
own design and its own audit.