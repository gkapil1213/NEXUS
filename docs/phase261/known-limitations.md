# Phase 261 — Known limitations

## 1. Progress/audit events remain non-transactional

### The limitation

Phase 261 closes the atomicity gap for **outcome** events — the terminal
transition of a stage from `RUNNING` to `SUCCEEDED`, `FAILED`, or
`BLOCKED`. That transition, its `execution_events` audit row, and its
outbox intent commit inside one transaction. See
`transaction-boundaries.md` for the full analysis.

Phase 261 does **not** cover progress/audit events. Eight files write
`INSERT INTO engineering_run_events` directly, outside any
`recoverJobAtomicAsync` transaction:

- `engineering-build-executor.ts:210`
- `engineering-diagnosis-executor.ts:110`
- `engineering-implementation-orchestrator.ts:90`
- `engineering-planning-orchestrator.ts:534`
- `engineering-release-ready-executor.ts:83`
- `engineering-repair-executor.ts:108`
- `engineering-security-review-executor.ts:107`
- `engineering-test-executor.ts:210`

If the process crashes after one of these writes but before the
surrounding orchestration step completes, the progress event is either
durable or not — there is no retry intent, because no outbox row is
written.

### Why this is not a correctness gap

The distinction is between:

- **Outcome events** — one row must correspond to a committed job-status
  transition. If the transition commits but the event is lost, the
  reconciler detects `MISSING_RUN_EVENT` for a stage whose job is
  terminal. That is the durable inconsistency Phase 260 §1 identified
  and Phase 261 closes.
- **Progress events** — no job-status transition corresponds to them. If
  one is lost, the stage's job status is unchanged and no consumer's
  correctness depends on the missing row. It is an audit gap, not a
  reconciliation gap. `reconcileEngineeringStage` does not look for
  progress events.

### What closing this would require

Each orchestrator step would need to own a transaction boundary that
includes the progress-event write. Because orchestrator steps are
long-lived (they call into executors, run sandbox commands, and interact
with the filesystem), the transaction would span work that cannot be
rolled back transactionally. The likely design is a second outbox
specific to progress events, or a batched write that commits progress
events at step boundaries.

Neither is in scope for Phase 261. The current design deliberately keeps
progress events best-effort.

### Classification

Not a defect. Documented here so no future reader assumes all
`engineering_run_events` writes are covered by the outbox contract.

## 2. Cross-process concurrency is unverified

Test `261F` runs two `EngineeringRunEventDrainer` instances inside a
single Node process and asserts that a shared pending row is claimed at
most once. The claim SQL uses
`UPDATE ... WHERE outbox_id IN (SELECT ...) RETURNING ...`, which is
row-lock-safe under PostgreSQL — a second worker racing for the same row
sees zero rows from `RETURNING` and moves on.

Two-process behavior has **not** been executed. No test spawns two
`tsx` children against the same database and asserts that the claim
race resolves to exactly one winner.

The correctness argument is:

- PostgreSQL row-level locking ensures the `UPDATE` on a given
  `outbox_id` serializes.
- The `IN (SELECT ...)` subquery is evaluated and the update applied
  under the same statement, so a second worker cannot slip in between
  the subquery and the update.
- The `RETURNING` clause reflects only rows actually updated by this
  statement.

This is the same pattern Phase 183a's test `E` uses for
`nexus_idempotency_keys` — which **is** exercised across processes. That
provides indirect evidence, but not direct evidence for the outbox
specifically.

Status: **NOT EXECUTED**. Reason: no multi-process harness for the
outbox exists. Closing it is a separate test-only phase.

## 3. `recordStageExecutionEvent` (non-`WithId`) has no caller

`src/core/engineering-run-service.ts:466` — `recordStageExecutionEvent`
writes an `engineering_run_events` row with a freshly generated
`event_id`. The drainer uses the `WithId` variant. Grepping for
`recordStageExecutionEvent(` (with a trailing paren) returns only the
declaration; no production or test code calls it.

Status: **dead code**. Not removed in Phase 261 to keep the change
narrow. A follow-up can delete it or leave it as a legacy API surface.

## 4. Claim-lease duration is a compile-time constant

`DEFAULT_LEASE_MS = 60_000` in `engineering-run-event-drainer.ts`. A
drainer whose delivery attempt takes longer than 60 seconds will have
its claim expire mid-flight, and another worker can re-claim the row.
Delivery is still correct (`ON CONFLICT (event_id) DO NOTHING`),
but the losing worker's ack is fenced out and it counts a
`lostClaims`.

There is no configuration knob to raise the lease. If a destination
write ever routinely takes >60s (e.g. a slow cross-region database),
the constant should be raised or made configurable. Today the drainer's
destination is a single-row INSERT, well under a second.

## 5. Malformed-payload policy is deliberate and strict

A row whose `payload` column cannot be parsed as JSON is permanently
failed. Its `last_error` records `MALFORMED_PAYLOAD: <first 200 chars>`,
its `payload` column is preserved byte-for-byte, and no
`engineering_run_events` row is created.

The alternative policy — deliver an empty `{}` and mark delivered — was
the behavior before Phase 261a. It was rejected because it fabricates a
payload for consumers and loses the malformation. The current policy is
strict by design.

If a legitimate write path ever produces non-JSON `payload` values, that
path is the bug — not the drainer.

## 6. Retry backoff is capped at 15 minutes

`backoffMs(attempts) = min(1000 * 4^(attempts-1), 15 * 60_000)`.
Interval sequence: 1s, 4s, 16s, 64s, 256s, then capped at 15 min per
attempt. After `MAX_ATTEMPTS = 5`, the row is terminal.

Under a sustained database outage, up to 5 attempts run within
approximately 20 minutes before a row goes permanently failed. There is
no mechanism to retry a permanently failed row automatically. Recovery
requires an operator to clear `permanently_failed_at` (and
`last_error`) manually.

## 7. No backfill for pre-existing `MISSING_RUN_EVENT` conditions

Phase 261 prevents new `MISSING_RUN_EVENT` conditions on the
`markStageJob` path, but does not backfill any that exist from before
the phase shipped. If a run's stage was transitioned to a terminal
state before Phase 261 and its `engineering_run_events` row is missing,
the outbox has no row for it. The reconciler will still detect the
condition (`MISSING_RUN_EVENT`), and no automated repair exists.

Status: out of scope. See `phase260-handoff.md` for how this relates to
the Phase 260 §1 deferral.

## 8. Startup drain failure does not fail the boot

`kernel.ts:610` runs one `drain()` at boot and logs failures as
`[engineering-outbox] Startup drain failed:`. Boot proceeds. A caller
that wants boot to fail on an outbox problem would need to change this
line explicitly.

This is intentional — an outbox with pending rows is not a reason to
refuse to serve. The rows remain durable and are retried on the next
interval tick.

## 9. Not production-grade verification

Phase 261 tests run against a local containerized PostgreSQL. They are
not a substitute for production-environment verification under real
network conditions, concurrent tenants, or sustained load. See
`test-results.md` for a parallel statement of this qualification.

## 10. `_bak/` contains development backups

Three backups from the phase261/261a development session:

- `_bak/engineering-run-event-drainer.pre-261A.bak`
- `_bak/test-phase261-outbox-drainer.pre-261A.bak`
- `_bak/test-phase261-outbox-drainer.pre-261J-isolation.bak`

The directory is gitignored. Nothing reads them. They exist purely as
recovery points and can be deleted at any time.