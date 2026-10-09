# Phase 260 — Verified transaction boundaries

This document records the durable-write boundaries that Phase 260
reconciliation is built on. Every claim here was verified by reading
the current source, not inferred from comments or earlier phases.

## The three durable ledgers for one engineering stage

For a single stage (e.g. `runId__PLANNING`), the system maintains state
in three separate places:

1. **`execution_jobs`** — the authoritative job-status ledger. Column
   `status` is the canonical truth for whether a stage has run, is
   running, or has reached a terminal status.
2. **`engineering_run_stages`** — the DAG-progression ledger. Column
   `capability_status` (`AVAILABLE` / `UNAVAILABLE` / `NOT_IMPLEMENTED`)
   plus `artifact_ref` records whether the stage row is advanced.
3. **`engineering_run_events`** — the audit/timeline ledger. Each
   transition of a stage should append a row (`engineering_run.stage_succeeded`,
   `engineering_run.stage_failed`, `engineering_run.stage_blocked`, etc.).

## Which writes are atomic with each other

### `ExecutionStore.recoverJobAtomicAsync` — single transaction

Source: `src/core/execution-store.ts` lines ~895-980.

    BEGIN
      UPDATE execution_jobs SET status = ?, updated_at = ?, ...
      WHERE id = ? AND status = ? AND (lease predicate)
      -- only if the UPDATE affected > 0 rows:
      [optional] INSERT INTO execution_ownership_obligations (...)
      INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at)
    COMMIT

- `execution_jobs` (the CAS UPDATE) and `execution_events` (the INSERT)
  are **in the same transaction**.
- If the INSERT fails, the UPDATE rolls back. If the UPDATE affects zero
  rows, the INSERT is skipped and the whole transaction commits with no
  side effect.
- Return value: `{ ok: true }` iff the UPDATE affected > 0 rows.

**Consequence**: the authoritative job status and its `execution_events`
audit row are always consistent. There is no partial write between them.

### `ExecutionStore.transitionExecutionAsync` — single transaction

Same pattern. `UPDATE execution_jobs` and `INSERT INTO execution_events`
in one `engine.transactionAsync`.

### `EngineeringRunService.transitionStage` — NOT one transaction

Source: `src/core/engineering-run-service.ts` lines ~337-388.

    -- call 1: this.withPg(async (pg) => {
      UPDATE engineering_run_stages SET capability_status = ?, ...
      WHERE id = ? AND run_id = ? AND capability_status = ?
    -- close connection
    -- call 2 (only if call 1 updated > 0 rows):
      this.appendEvent(runId, stageId, "engineering_run.stage_updated", { ... })
    -- close connection

Each `withPg` call opens a fresh `PgClient`, runs its statement, and
closes. There is **no shared transaction** between the two calls.

**Consequence**: if the `UPDATE engineering_run_stages` commits and the
`appendEvent` then fails (network drop, Postgres restart, process kill),
the stage row is advanced but no `engineering_run_events` row exists.

### `EngineeringRunService.recordStageExecutionEvent` — separate connection

Source: `src/core/engineering-run-service.ts` lines ~466-490.

    async recordStageExecutionEvent(runId, stageId, eventType, payload) {
      await this.appendEvent(runId, stageId, eventType, payload);
    }

    private async appendEvent(runId, stageId, eventType, payload) {
      const pg = new PgClient();
      await pg.connect(this.dbUrl);
      try {
        await pg.query(
          "INSERT INTO engineering_run_events (...) VALUES (...)",
          [...]
        );
      } finally { await pg.close(); }
    }

`engineering_run_events` is written via a **fresh connection**, in its
own auto-commit transaction. It is not in any shared transaction with
`execution_jobs` or `engineering_run_stages`.

## The composite write in `markStageJob`

`EngineeringStageExecutor.markStageJob` (in `src/core/engineering-stage-executor.ts`)
composes the two independent writes in sequence:

    1. await store.recoverJobAtomicAsync({ ... })
          -> atomic: execution_jobs + execution_events
    2. if (result.ok):
       a. stages = await runService.getEngineeringRunStages(runId)
       b. stage = stages.find(...)
       c. await runService.recordStageExecutionEvent(runId, stage.id, ...)
          -> separate connection: engineering_run_events

Between step 1 committing and step 2c committing, the process could be
interrupted, the network could drop, or the DB could become
unreachable. In that window:

- `execution_jobs.status` reflects the transition (committed).
- `execution_events` reflects the transition (committed, same transaction).
- `engineering_run_events` does **not** reflect the transition (missing).

Phase 259 made `markStageJob` return `{ ok: false, reason: "PERSISTENCE_FAILED" }`
when step 2c throws, so the caller knows something went wrong. But the
job status and `execution_events` remain committed — the failure did
**not** roll back step 1.

## The whole-DAG picture

For a single stage execution attempt, the durable writes land in this
order:

| # | Ledger | Writer | Transaction scope |
|---|---|---|---|
| 1 | `execution_jobs` (status) | `recoverJobAtomicAsync` | txn with `execution_events` |
| 2 | `execution_events` (audit) | `recoverJobAtomicAsync` | same txn as #1 |
| 3 | `engineering_run_stages` (capability_status, artifact_ref) | `transitionStage` UPDATE | own txn |
| 4 | `engineering_run_events` (`stage_updated`) | `transitionStage` appendEvent | own txn, separate connection |
| 5 | `engineering_run_events` (`stage_succeeded` / `stage_failed` / `stage_blocked`) | `recordStageExecutionEvent` | own txn, separate connection |

Any interruption between #2 and #3, #3 and #4, or #4 and #5 produces a
partial state. The Phase 260 reconciler (`src/core/engineering-stage-reconciler.ts`)
reads all three ledgers and classifies such partial states without
attempting to repair them.

## What Phase 260 does NOT claim

- It does **not** claim any of the writes are atomic with each other.
- It does **not** attempt to repair partial writes. Doing so safely
  requires either (a) moving the `engineering_run_events` INSERT into
  `recoverJobAtomicAsync`'s transaction — an architectural change across
  two services — or (b) a new `engineering_run_event_outbox` table
  drained by a worker — a schema migration.

  See `docs/phase260/known-limitations.md` for the full rationale.

- It does **not** introduce a distributed transaction, two-phase commit,
  or saga. The brief §4C explicitly permits deferring such a change if
  it cannot be implemented as a smallest-safe-change.