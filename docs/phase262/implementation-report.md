# Phase 262 — Outbox claim concurrency and shutdown durability

## Status

Implementation complete. All defined checks pass against local
containerized PostgreSQL. Not committed, not pushed. Awaiting review.

Baseline: `98aa32b` (`docs(phase261): record the test:core full-suite failure`).

## Objective

Two confirmed defects in the Phase 261 transactional outbox:

1. The outbox claim was not safely atomic across PostgreSQL connections
   under multi-row contention.
2. The kernel shutdown drain emitted its completion signal with `void`,
   so persistence was not awaited before the pool closed, and errors
   were swallowed.

Both are corrected. All other Phase 261 behavior — eligibility rules,
retry/backoff, the five-attempt limit, malformed-payload handling,
worker fencing, idempotent destination delivery, and `finalRecoveryPass`
semantics — is preserved.

## Files changed

| File | Change |
|---|---|
| `src/core/engineering-run-event-drainer.ts` | `claimBatch` replaced with a single-transaction claim using `SELECT ... FOR UPDATE SKIP LOCKED` followed by `UPDATE ... WHERE outbox_id = ANY(...)`. Throws `OutboxClaimError` when the async backend is missing instead of silently returning an empty batch. |
| `src/core/kernel.ts` | Import of `EngineeringRunEventDrainer` extended with `type DrainReport`. Drainer construction now guarded by `engStore.hasAsyncBackend()`. Shutdown drain block rewritten: `drain()` is awaited, its report is checked for pending work, the emit is awaited, and both drain and emit failures are logged via `console.error` instead of being swallowed. Pool close and gateway stop continue unconditionally. |
| `scripts/test-phase261-outbox-drainer.ts` | The 261I stub was updated to provide `transactionAsync` on the fake `store.asyncDb`, so the injected claim failure surfaces through the new code path. No assertions weakened. |
| `scripts/test-phase262-outbox-claim-concurrency.ts` | New file. 12 checks covering multi-row claim concurrency and shutdown durability. See `test-results.md`. |
| `package.json` | Added `test:phase262a`. UTF-8 BOM removed; only the new script line added. |

## The claim transaction

`EngineeringRunEventDrainer.claimBatch` now runs entirely inside one
`engine.transactionAsync` block, which routes every statement through a
single pooled connection:

    BEGIN
      SELECT outbox_id
        FROM engineering_run_event_outbox
       WHERE delivered_at IS NULL
         AND permanently_failed_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         AND (claimed_at IS NULL OR claim_expires_at < $1)
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED;

      UPDATE engineering_run_event_outbox
         SET claimed_at = $3, claimed_by = $4, claim_expires_at = $5
       WHERE outbox_id = ANY($6)
       RETURNING outbox_id, event_id, run_id, stage_id, event_type, payload, attempts;
    COMMIT

The `SELECT ... FOR UPDATE SKIP LOCKED` partitions the eligible set
across concurrent workers: a row locked by another transaction is
skipped, not waited for. The subsequent `UPDATE ... WHERE outbox_id =
ANY(...)` targets exactly the rows this transaction locked.

The transaction commits when the callback returns, before any delivery
attempt runs. Delivery is separate: the caller iterates the returned
rows and calls `recordStageExecutionEventWithId`, which is idempotent
on `event_id` and safe under redelivery.

Eligibility conditions, ordering (`created_at ASC`), and batch size are
unchanged from Phase 261.

## The shutdown sequence

`NexusKernel.shutdown` now:

1. Runs the shutdown drain (when `finalRecoveryPass` is false and a
   drainer is wired) and captures the `DrainReport`. A thrown drain is
   caught and logged as
   `[engineering-outbox] Shutdown drain failed: <message>`.
2. If the report shows `claimed > 0` or `delivered > 0`, awaits
   `services.events.emit({ type: "outbox_drain_on_shutdown", ... })`.
   A thrown emit is caught and logged as
   `[engineering-outbox] Shutdown drain event persist failed: <message>`.
3. Closes the PostgreSQL pool and stops the worker gateway
   unconditionally. Neither a drain failure nor an emit failure can
   skip these cleanup steps.

The previous code used `void this.services?.events?.emit?.(...)` inside
`try { ... } catch { /* best-effort */ }`, which neither awaited
persistence nor recorded failures.

## Backend boundary

`FOR UPDATE SKIP LOCKED` and `= ANY(array)` are PostgreSQL-specific.
`ExecutionStore.asyncDb` is undefined in SQLite mode, and the
drainer is only constructed when `engStore.hasAsyncBackend()` is true
(`kernel.ts`). If a caller invokes `claimBatch` without an async
backend, it throws `OutboxClaimError` with an explicit
PostgreSQL-only reason rather than returning an empty batch.

## What was not changed

- Phase 261 retry and backoff logic, MAX_ATTEMPTS=5, malformed-payload
  handling, `lostClaims` accounting.
- Destination idempotency (`ON CONFLICT (event_id) DO NOTHING`).
- Outbox schema, migrations, or bootstrap.
- Any other phase's tests or code.

## Verification

See `test-results.md`. All checks pass. No commits made.