# Phase 261 — Transactional outbox for engineering_run_events

## Status

Shipped. Verified against local containerized PostgreSQL. Committed on
`master` and pushed to `origin/master`.

- Phase 261: `6f5aa17` — transactional outbox, drainer, startup/shutdown recovery.
- Phase 261 acceptance test: `edc5826` — `scripts/test-phase261-outbox-drainer.ts`.
- Phase 261a: `0d2f4e9` — failure-visibility hardening (claim errors throw,
  malformed payload permanent-failure, fence-miss accounting).

## Purpose

Phase 260 §1 identified a partial-persistence gap: `execution_jobs.status`
and `execution_events` committed atomically inside `recoverJobAtomicAsync`,
but the corresponding `engineering_run_events` row was written afterward
via a separate connection. A crash between the two writes produced a
durable state the reconciler classified as `MISSING_RUN_EVENT`. Phase 260
detected the condition but deferred repair, listing two viable paths.
Phase 261 implements Path B: the transactional outbox.

The outbox closes the gap by committing the *intent* to write
`engineering_run_events` inside the same transaction as the job CAS. A
drainer delivers the intent asynchronously with at-least-once semantics.
If the process dies before the drain runs, the intent is durable and the
next process picks it up on boot.

## Scope

Outcome events only. The transition from a stage's `RUNNING` state to a
terminal state (`SUCCEEDED`, `FAILED`, `BLOCKED`) is the load-bearing
event the reconciler and downstream consumers depend on. The eight
direct writers listed in `transaction-boundaries.md` emit progress/audit
events with no associated job transition; those are out of scope and
remain non-transactional.

## Phase 261 — what shipped

### Schema

`src/db/migrations/174_phase261_engineering_run_event_outbox.sql` and the
matching bootstrap in `src/core/pg-bootstrap.ts` (around line 850) create:

    engineering_run_event_outbox (
      outbox_id        TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,
      event_id         TEXT NOT NULL,
      job_id           TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      stage_id         TEXT,
      event_type       TEXT NOT NULL,
      payload          TEXT,
      created_at       INTEGER NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  INTEGER,
      claimed_at       INTEGER,
      claimed_by       TEXT,
      claim_expires_at INTEGER,
      delivered_at     INTEGER,
      last_error       TEXT,
      permanently_failed_at INTEGER
    );

Three indexes:
- `idx_outbox_idempotency_key` — unique on `idempotency_key`.
- `idx_outbox_due` — partial on `next_attempt_at` where undelivered and not failed.
- `idx_outbox_expired_claims` — partial on `claim_expires_at` where undelivered.

### Atomic write

`src/core/execution-store.ts:895` — `recoverJobAtomicAsync` gains an
optional `outboxEvent` parameter. When provided, the outbox INSERT runs
inside the same `engine.transactionAsync(async (tx) => {...})` block as
the CAS UPDATE and the `execution_events` INSERT. All three commit or
roll back together.

`ON CONFLICT (idempotency_key) DO NOTHING` makes a retried transition
produce at most one outbox row.

### Caller

`src/core/engineering-stage-executor.ts:564` — `markStageJob` is the sole
caller that passes `outboxEvent`. It computes:

    outboxId       = "outbox-" + jobId + "__" + eventType
    idempotencyKey = jobId + "__" + eventType
    eventId        = "eevt-" + jobId + "__" + eventType

The `eventId` is deliberately distinct from the `outboxId`. Row identity
in the outbox and identity of the domain event in `engineering_run_events`
are not aliased, so a future change to the outbox-id format cannot
accidentally deduplicate against an unrelated `engineering_run_events`
row.

### Drainer

`src/core/engineering-run-event-drainer.ts`. Reads pending rows,
delivers them to `EngineeringRunService.recordStageExecutionEventWithId`,
and marks each terminal.

Claim algorithm (single UPDATE with RETURNING so concurrent workers
cannot both win):

    UPDATE engineering_run_event_outbox
       SET claimed_at = ?, claimed_by = ?, claim_expires_at = ?
     WHERE outbox_id IN (
       SELECT outbox_id FROM engineering_run_event_outbox
        WHERE delivered_at IS NULL
          AND permanently_failed_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (claimed_at IS NULL OR claim_expires_at < ?)
        ORDER BY created_at ASC LIMIT ?
     )
     RETURNING outbox_id, event_id, run_id, stage_id, event_type, payload, attempts

Retry policy: exponential backoff 1s, 4s, 16s, 64s, 256s, capped at
15 min. Terminal after `MAX_ATTEMPTS = 5`.

### Kernel wiring

`src/core/kernel.ts:608` — the drainer is constructed and stored on the
kernel as `engineeringOutboxDrainer`. It is used at three call sites:

- `kernel.ts:400` — inside the periodic `executionReconcileTimer` tick.
- `kernel.ts:610` — eager startup drain, once, immediately after
  construction.
- `kernel.ts:1251` — shutdown drain, when `finalRecoveryPass` is false.

### Shutdown observability

`kernel.ts:1249` emits `outbox_drain_on_shutdown` if the shutdown drain
claims or delivers anything. The event type was added to
`NexusEventType` in `src/core/types.ts`. When `finalRecoveryPass` is
false, the shutdown drain still runs once and reports what it found —
turning silent orphaned rows into a queryable event.

### Cleanup helper

`src/core/execution-store.ts:6123` — `deleteEngineeringRunCascade(runId)`
removes the run, its stages, its jobs, and any pending outbox rows keyed
by `run_id` or `job_id` prefix. Used by tests and probes; not called from
production code.

## Phase 261a — what shipped

Three defects observed in the 261 drainer, each fixed with a
corresponding test in `scripts/test-phase261-outbox-drainer.ts`.

### Defect 1 — claim errors reported as empty success

Before: `drain()` wrapped `claimBatch` in `try { ... } catch { return
report; }`. A database error was indistinguishable from "no work".

After: `drain()` throws `OutboxClaimError` with the original cause
preserved. Callers at kernel.ts:400, 610, and 1251 already have
`.catch()` or `try/catch`, so the change surfaces the failure without
destabilizing the kernel.

Test: `261I` injects a claim-query failure and asserts the throw.

### Defect 2 — malformed payload silently delivered as `{}`

Before: `JSON.parse` failure fell back to `{}` and the row was delivered
and marked successful. The original bytes were lost to consumers.

After: malformed payload is a **permanent** failure. The row is marked
`permanently_failed_at` with `last_error = "MALFORMED_PAYLOAD: <first
200 chars of parse error>"`. Nothing is delivered to
`engineering_run_events`. The original `payload` column is untouched.

Test: `261H` inserts `payload = "{invalid json"` and asserts the row is
permanently failed, the payload column is byte-identical, and no
`engineering_run_events` row was created.

### Defect 3 — ack updates counted as success on fence miss

Before: `markDelivered`, `scheduleRetry`, and `markPermanentlyFailed`
returned `void`. The drain loop incremented `report.delivered` (or
`retried`, or `permanentlyFailed`) regardless of whether the UPDATE
matched any row. A worker whose claim expired mid-flight could report
delivery of a row another worker had already reclaimed.

After: each ack method returns `boolean` based on `changes > 0`. The
drain loop increments the corresponding counter only on `true`. A
`false` result increments the new `DrainReport.lostClaims` field
instead.

Test: `261J` forces the fence clause to match zero rows and asserts
`delivered === 0`, `lostClaims === 1`, and `delivered_at IS NULL`.

## Files changed

| File | Phase | Change |
|---|---|---|
| `src/db/migrations/174_phase261_engineering_run_event_outbox.sql` | 261 | New table + indexes |
| `src/core/pg-bootstrap.ts` | 261 | Bootstrap mirrors migration |
| `src/core/execution-store.ts` | 261 | `recoverJobAtomicAsync` accepts `outboxEvent`; `deleteEngineeringRunCascade` added |
| `src/core/engineering-run-event-drainer.ts` | 261 / 261a | Drainer; hardening in 261a |
| `src/core/engineering-stage-executor.ts` | 261 | `markStageJob` passes `outboxEvent` |
| `src/core/kernel.ts` | 261 | Drainer wiring; startup and shutdown drains; shutdown emit |
| `src/core/types.ts` | 261 | `outbox_drain_on_shutdown` added to `NexusEventType` |
| `src/core/engineering-run-service.ts` | 261 | `recordStageExecutionEventWithId` (drainer destination) |
| `src/core/engineering-stage-reconciler.ts` | 261 | Reads outbox state for reconciliation findings |
| `src/core/engineering-run-service.ts` | 261 | `getLatestOutboxStateForStage` |
| `scripts/test-phase261-outbox-drainer.ts` | 261 / 261a | Acceptance test; extended in 261a |
| `package.json` | 261 | `test:phase261` registered |
| `.gitattributes` | 261 | LF for `.ts`/`.sql`/`.json` |

## Acceptance

`npm run test:phase261` — 11 checks, 0 failed.

Test-to-requirement mapping is in `test-results.md`.

## Remaining limitations

See `known-limitations.md`. Summary:

1. Progress/audit events from eight orchestrators remain direct writers
   of `engineering_run_events` and are not durable-at-least-once.
2. Concurrent-worker behavior is verified only within a single Node
   process (`261F`); no two-process integration test exists.
3. `recordStageExecutionEvent` (non-`WithId`) has no production caller.

## Handoff from Phase 260

Phase 260 `known-limitations.md` §1 explicitly named the transactional
outbox as repair Path B and deferred it. Phase 261 implements it. See
`phase260-handoff.md` for the cross-reference and an explanation of what
portion of Phase 260's `MISSING_RUN_EVENT` exposure is now closed versus
still open.