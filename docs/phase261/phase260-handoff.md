# Phase 261 — Handoff from Phase 260

## Why this document exists

Phase 260's `known-limitations.md` §1 documents a deferred repair for a
condition it can detect but cannot fix: a job whose terminal transition
committed but whose `engineering_run_events` row did not. It names two
viable repair paths and explicitly declines to implement either.

Phase 261 implements one of them. This document records the exact
correspondence, so a future reader of Phase 260's docs can find the
resolution and a future reader of Phase 261's docs can understand what
motivated the design.

## The Phase 260 §1 limitation, restated

> The engineering-stage executor composes two durable writes that are not
> in a shared transaction:
>
> 1. `execution_jobs.status` and `execution_events` — atomic with each
>    other inside `recoverJobAtomicAsync`.
> 2. `engineering_run_events` — written via a fresh `PgClient` connection
>    and its own auto-commit transaction, after the first write has
>    already committed.

If the process dies between (1) and (2), the durable state is:

- `execution_jobs.status` = terminal
- `execution_events` = has the audit row
- `engineering_run_events` = no corresponding row

Phase 260's reconciler classifies this as `MISSING_RUN_EVENT`.

## What Phase 260 proposed

Phase 260's `known-limitations.md` §1 considered two repair paths:

### Path A — Move the run-event write into the job-transition transaction

Thread a transaction handle from `execution-store` up to the executor
and back down into `engineering-run-service`. Would require:

- New API surface on `recoverJobAtomicAsync`.
- Rewriting `markStageJob` and every other writer of
  `engineering_run_events`.
- Coupling two subsystems that currently have clean boundaries.

Phase 260 characterized this as an architectural change to two subsystems
with cross-cutting callers, taking a full phase of its own.

### Path B — Introduce a transactional outbox

Add a new table. Have `markStageJob` write to the outbox **inside** the
same `recoverJobAtomicAsync` transaction. A separate worker drains the
outbox into `engineering_run_events`. The schema Phase 260 sketched:

    CREATE TABLE engineering_run_event_outbox (
      outbox_id   TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      stage_id    TEXT,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  BIGINT NOT NULL,
      drained_at  BIGINT
    );

Phase 260 characterized this as requiring a schema migration, a drain
worker with its own lifecycle, a decision about exactly-once semantics,
and a backfill strategy.

## What Phase 261 shipped

**Phase 261 implements Path B, with refinements over the Phase 260
sketch.**

### Schema

`src/db/migrations/174_phase261_engineering_run_event_outbox.sql` and
`src/core/pg-bootstrap.ts:850`.

The actual schema is larger than the Phase 260 sketch. Additional
columns beyond the sketch:

- `idempotency_key TEXT NOT NULL UNIQUE` — prevents duplicate outbox
  rows if the same logical transition is retried.
- `event_id TEXT NOT NULL` — the domain-event identity passed to the
  destination. Distinct from `outbox_id`.
- `job_id TEXT NOT NULL` — used by the cascade-delete helper.
- `attempts INTEGER NOT NULL DEFAULT 0` — retry counter.
- `next_attempt_at BIGINT` — backoff scheduling.
- `claimed_at BIGINT`, `claimed_by TEXT`, `claim_expires_at BIGINT` —
  lease-based claim so multiple drainer processes cannot both deliver
  the same row.
- `delivered_at BIGINT` — terminal success marker.
- `last_error TEXT` — most recent error, for observability.
- `permanently_failed_at BIGINT` — terminal failure marker.

Three indexes:
- `idx_outbox_idempotency_key` — unique.
- `idx_outbox_due` — partial, for the claim scan.
- `idx_outbox_expired_claims` — partial, for lease-recovery scans.

The `drained_at` column from the Phase 260 sketch is named
`delivered_at` in the shipped schema — a naming change, no semantic
difference.

### Transaction boundary

Phase 260's Path B proposal: "the outbox INSERT is added alongside the
`execution_events` INSERT in the store's transaction block."

Shipped exactly as proposed. `execution-store.ts:895` —
`recoverJobAtomicAsync` now accepts an optional `outboxEvent` parameter
and, when present, runs the `INSERT INTO engineering_run_event_outbox`
inside the same `engine.transactionAsync` block as the CAS UPDATE and
the `execution_events` INSERT.

`engineering-stage-executor.ts:564` — `markStageJob` is the caller that
passes `outboxEvent`. It is the **only** caller that does.

### Drain worker

Phase 260's Path B proposal: "a separate worker drains the outbox into
`engineering_run_events` on a loop or on demand."

Shipped as `EngineeringRunEventDrainer`
(`src/core/engineering-run-event-drainer.ts`). It runs from three call
sites in `kernel.ts`:

- `kernel.ts:400` — the periodic `executionReconcileTimer` tick.
- `kernel.ts:610` — a one-shot eager drain at boot.
- `kernel.ts:1251` — a best-effort drain at shutdown.

### Exactly-once semantics decision

Phase 260's Path B proposal: "a decision about exactly-once semantics:
the outbox row has to be marked drained atomically with the
`engineering_run_events` INSERT, or the drain becomes at-least-once and
needs idempotency keys."

Shipped: **at-least-once, with idempotency keys.** The destination
INSERT uses `ON CONFLICT (event_id) DO NOTHING`, so a redelivered row
cannot create a duplicate `engineering_run_events` row. The outbox ack
is a separate UPDATE after the destination commit — the two are not
transactional with each other, and the design does not require them to
be.

### Backfill strategy

Phase 260's Path B proposal listed a backfill strategy as a
requirement. Phase 261 ships **no backfill**.

Reasoning: pre-existing `MISSING_RUN_EVENT` conditions are a state the
reconciler already detects. There is no current way to reconstruct the
missing `engineering_run_events` row from the current durable state —
the `event_id`, `payload`, and `created_at` are all gone. A backfill
would need the event metadata to be recoverable from somewhere else,
and it is not.

The practical position is:

- New transitions are protected by the outbox.
- Pre-existing conditions remain detectable (reconciler) but not
  automatically repairable.
- Any repair of a pre-existing condition requires operator
  intervention.

This is documented as `known-limitations.md` §7 in this directory.

## What portion of the Phase 260 §1 exposure is now closed

Let me be precise, because the exact scope matters for anyone reasoning
about reconciliation coverage.

### Closed

**The `markStageJob` outcome-event path.** Every stage transition that
goes through `markStageJob` — that is, every terminal transition
(`SUCCEEDED`, `FAILED`, `BLOCKED`) driven by
`EngineeringStageExecutor` — now writes the outbox intent atomically
with the CAS. If the CAS commits, the intent is durable and will be
delivered. If the process dies before delivery, the next process picks
it up. The condition `MISSING_RUN_EVENT` for such a transition can no
longer be created by a crash between the job-CAS and the run-event
write.

### Still open

**Progress events from the eight direct writers.** The Phase 260 §1
limitation was specifically about outcome events (the transitions the
reconciler classifies). Phase 261 closes the outcome-event path. The
progress-event path — the eight executors/orchestrators that emit
`INSERT INTO engineering_run_events` directly — was never part of the
Phase 260 §1 concern and remains non-transactional.

See `known-limitations.md` §1 in this directory for the full
discussion.

## Correspondence table

| Phase 260 §1 proposal | Phase 261 shipped |
|---|---|
| New table `engineering_run_event_outbox` | Yes — `migrations/174_*.sql` |
| Outbox INSERT inside the CAS transaction | Yes — `recoverJobAtomicAsync({outboxEvent})` |
| Separate drain worker | Yes — `EngineeringRunEventDrainer` |
| Exactly-once decision | At-least-once + `ON CONFLICT (event_id) DO NOTHING` |
| Backfill strategy for existing rows | No backfill; documented in `known-limitations.md` §7 |
| `drained_at` column | Shipped as `delivered_at` |
| Additional columns (attempts, claimed_*, next_attempt_at, last_error, permanently_failed_at, idempotency_key, event_id, job_id) | Added to support lease-based claims, bounded retry, and terminal-failure semantics |

## What Phase 260's test 260G says now

Phase 260's test `260G` reads:

    [N/E ] 260G partial-persistence repair -- Phase 260 scope excludes §4C
    repair (transaction-boundary mismatch requires cross-service
    transaction or outbox schema); see docs/phase260/known-limitations.md

The reason string mentions "outbox schema" — that schema now exists, and
the outcome-event path that was the source of the §4C condition is
covered. But `260G` itself is about **repair by the reconciler**, which
Phase 261 did not add. The reconciler still detects `MISSING_RUN_EVENT`;
it still does not repair.

So `260G` remains **NOT EXECUTED**, but the underlying condition is
narrower than when Phase 260 shipped:

- Before Phase 261: `markStageJob` transitions could produce
  `MISSING_RUN_EVENT` on crash. Reconciler detects it. Repair is
  deferred.
- After Phase 261: `markStageJob` transitions can no longer produce
  `MISSING_RUN_EVENT` on crash. Reconciler's detection is now a
  backstop for pre-existing conditions and for the progress-event path.
  Repair remains deferred.

Phase 260's `known-limitations.md` is worth annotating to record this.
The specific insertion is at the top of §1:

> **Update (Phase 261):** the outcome-event path described below is
> closed by the transactional outbox shipped in Phase 261. See
> `docs/phase261/phase260-handoff.md`. The limitation remains in force
> for the progress-event path (eight direct writers).

This is a documentation-only change; it does not touch Phase 260 source
or tests.

## What to read next

- `implementation-report.md` — what Phase 261 and 261a shipped, in
  detail.
- `outbox-contract.md` — the durability guarantees.
- `transaction-boundaries.md` — the atomicity audit.
- `test-results.md` — the test coverage and results.
- `known-limitations.md` — remaining gaps.