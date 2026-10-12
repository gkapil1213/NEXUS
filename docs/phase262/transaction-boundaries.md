# Phase 262 — Transaction boundaries

## Scope

This document describes the transaction boundaries touched by Phase
262. It does not re-document the broader engineering-run transaction
model, which is covered in `docs/phase260/transaction-boundaries.md`.

## The outbox claim transaction

`EngineeringRunEventDrainer.claimBatch` in
`src/core/engineering-run-event-drainer.ts` runs entirely inside one
`engine.transactionAsync` block. Every statement in the block goes
through the same pooled PostgreSQL connection, obtained once at the
start of the transaction.

Two statements execute:

1. `SELECT outbox_id ... FOR UPDATE SKIP LOCKED` — acquires a row lock
   on each eligible row, skipping any row already locked by another
   concurrent transaction. Returns the ids of the rows this
   transaction locked.
2. `UPDATE ... WHERE outbox_id = ANY(...) RETURNING ...` — updates
   exactly those rows (setting `claimed_at`, `claimed_by`,
   `claim_expires_at`) and returns their claim-eligible columns.

The transaction commits when the callback returns. No statement after
the commit depends on the transaction handle.

## Why one connection matters

`PgAsyncEngine.transactionAsync` in `src/core/pg-async-engine.ts`
creates a per-transaction sub-engine that routes every `prepareAsync`
call through the same `pool.connect()` client. If the two statements
ran on different connections, `SELECT ... FOR UPDATE SKIP LOCKED` would
hold locks in one session, and the `UPDATE` would run in another. The
`SKIP LOCKED` semantics require that both statements see the same
transaction view; without the shared connection, the design breaks.

## What is not atomic

The claim transaction does not include delivery. After the claim
commits, the caller iterates the claimed rows and invokes
`recordStageExecutionEventWithId` for each one. That call runs against
a fresh `PgClient` connection (see
`EngineeringRunService.recordStageExecutionEventWithId` and its
`withPg` helper).

The consequence: if the process dies between the claim commit and the
destination insert, the row remains `claimed_by = <worker>` with
`claim_expires_at` in the future. Once the lease expires, another
drainer can re-claim the row and attempt delivery. This is the Phase
261 at-least-once contract, and it is preserved.

The destination write is idempotent on `event_id`:

    INSERT INTO engineering_run_events (...) VALUES (...)
    ON CONFLICT (event_id) DO NOTHING

A redelivery after a partial failure produces exactly one destination
row.

## The ack operations

`markDelivered`, `scheduleRetry`, and `markPermanentlyFailed` each run
a single `UPDATE` against `engineering_run_event_outbox` with
`WHERE outbox_id = ? AND claimed_by = ?`. They are not part of any
transaction that includes a delivery. Each is a single-statement
autocommit operation, and each inspects the affected row count to
detect a lost claim (returns `false` to the caller, which increments
`lostClaims` in the drain report rather than `delivered`).

## The shutdown sequence

`NexusKernel.shutdown` executes its steps in a fixed order, with no
shared transaction across them:

1. `stopDistributedScheduler()`.
2. Clear `executionReconcileTimer`.
3. `stopCicdReconciliationScheduler()`.
4. `stopDriftObserver()`.
5. `stopRecoverySupervisor({ finalPass })`.
6. Phase 262 shutdown drain:
   - `await engineeringOutboxDrainer.drain(Date.now())`. Any throw is
     caught and logged. The `DrainReport` (or `null`) is retained.
   - If the report has pending work, `await services.events.emit(...)`.
     Any throw is caught and logged.
7. Close the PostgreSQL pool if one was opened.
8. `stopGateway()`.

Step 6 runs before step 7 so the emit's persistence is awaited before
the pool closes. This is the Phase 262 fix: previously the emit was
`void`-fired and could still be in flight when step 7 ran.

The emit itself writes to the SQLite-backed `EventService`, not to
PostgreSQL, so closing the pool does not literally lose the event.
Awaited emit ensures a subsequent reader of `services.events.list()`
sees the event immediately after `shutdown()` returns, which the
tests rely on.

Steps 3–8 run unconditionally. A failure in step 6 does not skip
steps 7 or 8.

## What Phase 262 does not claim

- Atomicity between claim and delivery. Not claimed. The claim is
  durable; delivery is at-least-once.
- Cross-process atomicity beyond PostgreSQL's row locks. The claim is
  safe across processes because the two statements run in one
  PostgreSQL transaction. This is the guarantee the design relies on.
- Ordering of deliveries. Rows are claimed in `created_at ASC` order
  within a batch, but concurrent workers can complete deliveries out
  of order, and retries can deliver later rows first. No per-run
  ordering guarantee is asserted.
- Exactly-once delivery. Not claimed. The contract is at-least-once
  plus idempotent destination.

## Reference

- Claim: `src/core/engineering-run-event-drainer.ts`, `claimBatch`.
- Transaction handle: `src/core/pg-async-engine.ts`,
  `transactionAsync`.
- Connection pool: `src/core/pg-client.ts`, `PgClient`.
- Destination: `src/core/engineering-run-service.ts`,
  `recordStageExecutionEventWithId`.
- Shutdown: `src/core/kernel.ts`, `shutdown`.