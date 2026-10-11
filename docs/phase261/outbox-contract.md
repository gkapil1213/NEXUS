# Phase 261 — Outbox durability contract

## Purpose

This document states the guarantees the transactional outbox provides,
and the guarantees it deliberately does not provide. It is the reference
for anyone writing against `EngineeringRunEventDrainer`,
`recoverJobAtomicAsync`, or the `engineering_run_event_outbox` table.

## Guarantee 1 — Atomic intent

When a caller passes `outboxEvent` to `recoverJobAtomicAsync`, the
following three writes commit in a single transaction:

1. `UPDATE execution_jobs` — the CAS transition.
2. `INSERT INTO execution_events` — the execution-layer audit row.
3. `INSERT INTO engineering_run_event_outbox` — the delivery intent.

If the transaction commits, all three are durable. If the process
crashes after commit and before any drain has run, the intent survives
and is delivered by the next process. If the transaction rolls back, none
of the three are durable and the caller observes the CAS as rejected.

The transaction boundary is `engine.transactionAsync` in
`execution-store.ts`. See `transaction-boundaries.md` for the full
analysis.

## Guarantee 2 — At-least-once delivery

A row in `engineering_run_event_outbox` with `delivered_at IS NULL` and
`permanently_failed_at IS NULL` will be claimed and delivered at least
once. Delivery is not exactly-once.

This guarantee holds under:

- Process crash between the atomic write (guarantee 1) and the first
  drain.
- Process crash between a claim and the corresponding ack UPDATE. The
  claim expires after `DEFAULT_LEASE_MS = 60_000` ms and the row becomes
  re-claimable.
- Two workers claiming the same row concurrently. Row-level locking in
  the claim UPDATE ensures exactly one wins; the other sees zero rows
  from the `RETURNING` clause and moves on.

The guarantee does not hold if:

- The outbox row is deleted by an operator or by
  `deleteEngineeringRunCascade` before delivery. Both are explicit
  destructive operations, not normal flow.
- `permanently_failed_at` has been set (guarantee 4).

## Guarantee 3 — Idempotent destination

`EngineeringRunService.recordStageExecutionEventWithId` performs:

    INSERT INTO engineering_run_events
      (event_id, run_id, stage_id, event_type, payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (event_id) DO NOTHING

Redelivering the same outbox row produces at most one
`engineering_run_events` row. This makes at-least-once delivery safe for
consumers: they may see the same `event_id` more than once at the outbox
level, but the `engineering_run_events` table contains exactly one row
per `event_id`.

The `event_id` is the caller-supplied identity from
`markStageJob` (`"eevt-" + jobId + "__" + eventType`), not the outbox
row's `outbox_id`. The two are deliberately distinct so that a change to
the outbox-id format cannot accidentally collide with a domain event.

## Guarantee 4 — Bounded retry with a terminal state

Delivery failure increments `attempts` and schedules a retry via
`next_attempt_at` with exponential backoff:

    backoff(attempts) = min(1000 * 4^(attempts-1), 15 * 60_000)

Resulting intervals: 1s, 4s, 16s, 64s, 256s, then capped at 15 min.

After `MAX_ATTEMPTS = 5`, the row is marked with
`permanently_failed_at = <now>` and `last_error = <truncated error>`.
`permanently_failed_at` excludes the row from future claims
(`claimBatch`'s WHERE clause requires `permanently_failed_at IS NULL`).
The terminal state is idempotent — re-running the drain does not change
it.

## Guarantee 5 — Malformed payloads fail terminally

A row whose `payload` column cannot be parsed as JSON is not delivered.
It is marked `permanently_failed_at` with
`last_error = "MALFORMED_PAYLOAD: <first 200 chars of parse error>"`. The
original `payload` column is untouched, so operators can inspect the raw
bytes. No `engineering_run_events` row is created for the failed
`event_id`.

The intent is that a malformed payload is a bug in the writer, not a
transient condition. Retrying it would spin forever. Failing it
terminally surfaces the bug once, in a row operators can query with:

    SELECT * FROM engineering_run_event_outbox
     WHERE permanently_failed_at IS NOT NULL
       AND last_error LIKE 'MALFORMED_PAYLOAD:%'

## Guarantee 6 — Fencing on every ack

Every ack UPDATE — `markDelivered`, `scheduleRetry`,
`markPermanentlyFailed` — is fenced by `WHERE outbox_id = ? AND
claimed_by = ?`. If the fence matches zero rows (because the lease
expired and another worker re-claimed the row), the method returns
`false` and the drain loop increments `DrainReport.lostClaims` rather
than `delivered` / `retried` / `permanentlyFailed`.

A `lostClaims` count greater than zero is not an error. It means the
worker's lease was allowed to expire between the claim and the ack —
likely because the process was slow or the DB was slow. The row will be
re-claimed by whichever worker wins the next claim, and delivery proceeds
under guarantees 2 and 3.

## Guarantee 7 — Claim errors are observable

`drain()` throws `OutboxClaimError` when the claim query fails. It does
not return `{claimed: 0, delivered: 0, ...}` on a database error.
Callers must distinguish "no work available" from "database
unreachable", and the drain contract requires them to do so explicitly.

`OutboxClaimError` preserves the original cause on its `cause` property.

## Guarantee 8 — Startup and shutdown drains are best-effort

At startup, the drainer runs exactly one `drain()` call immediately
after the kernel wires it (kernel.ts:610). Failures are logged as
`[engineering-outbox] Startup drain failed:` but do not abort boot.

At shutdown, when `finalRecoveryPass` is false, the kernel runs one
further `drain()` and emits `outbox_drain_on_shutdown` if anything was
claimed or delivered. This is a visibility feature, not a correctness
feature: the correctness guarantee is that the intent remains in the
table and will be picked up on the next boot.

## What the outbox does not guarantee

- **Exactly-once delivery.** At-least-once (guarantee 2) plus idempotent
  destination (guarantee 3) is the actual contract. Consumers must be
  prepared for the destination write to be attempted more than once.
- **Ordering across events.** Rows are claimed in `created_at` order
  within a batch, but concurrent workers can deliver out of order, and a
  retry can deliver a later row before an earlier one succeeds. If
  consumers require per-run ordering, they must reconstruct it from
  `engineering_run_events.created_at`.
- **Atomicity with any event not written by `markStageJob`.** The eight
  direct writers listed in `transaction-boundaries.md` bypass the outbox
  and are not covered.
- **Delivery SLA.** There is no upper bound on delivery latency when the
  system is under sustained load, only on the interval between retries.
- **Concurrency across processes proven by test.** The claim SQL is
  row-lock-safe by construction. The behavior has not been exercised by
  a two-process integration test.

## Reference

- Schema: `src/db/migrations/174_phase261_engineering_run_event_outbox.sql`
- Writer: `src/core/execution-store.ts` — `recoverJobAtomicAsync`, around
  line 895.
- Caller: `src/core/engineering-stage-executor.ts` — `markStageJob`,
  around line 543.
- Drainer: `src/core/engineering-run-event-drainer.ts`
- Destination: `src/core/engineering-run-service.ts` —
  `recordStageExecutionEventWithId`, around line 481.
- Wiring: `src/core/kernel.ts` — lines 400, 608, 610, 1251.
- Tests: `scripts/test-phase261-outbox-drainer.ts`