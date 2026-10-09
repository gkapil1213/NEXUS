# Phase 260 — Reconciliation contract

The read-only reconciliation service exposes a single function:

    reconcileEngineeringStage(input: {
      runId: string;
      stageType: EngineeringStageType;
      store: ExecutionStore;
      runService: EngineeringRunService;
    }): Promise<{ findings: StageReconciliationFinding[]; ok: boolean }>

It reads the three durable ledgers for one stage (see
`transaction-boundaries.md`) and returns a classified set of findings.
It never writes.

## Findings

Every finding is a discriminated union of the following shapes.

### `CONSISTENT`

The three ledgers agree:

    { kind: "CONSISTENT"; jobStatus: string; stageStatus: string }

Returned when:

- `execution_jobs.status` and `engineering_run_stages.capability_status`
  are in the compatible set (see below), and
- when the job is terminal, a matching `engineering_run_events` row exists.

`ok: true` is returned iff the findings array contains exactly one
`CONSISTENT` finding.

### `MISSING_JOB`

    { kind: "MISSING_JOB"; stageId: string; stageStatus: string }

The `execution_jobs` row for `stageId` does not exist. `stageStatus` is
`"UNKNOWN"` because the stage row is not read on this path (the job is
the authoritative starting point).

### `MISSING_STAGE`

    { kind: "MISSING_STAGE"; stageId: string; jobStatus: string }

The `execution_jobs` row exists but the `engineering_run_stages` row
for the same run + stage type does not. Indicates stage-row deletion or
a created job without a corresponding DAG row.

### `STAGE_JOB_MISMATCH`

    { kind: "STAGE_JOB_MISMATCH"; jobStatus: string; stageStatus: string }

The job is non-terminal but the stage row is in a capability status that
does not correspond to the job's in-flight state. Example: job is
`QUEUED` but stage is `AVAILABLE`.

### `TERMINAL_CONFLICT`

    { kind: "TERMINAL_CONFLICT"; jobStatus: string; stageStatus: string }

The job is in a terminal status and the stage row is in a capability
status incompatible with that terminal. Example: job is `SUCCEEDED` but
stage is `UNAVAILABLE` with no `artifact_ref`. Distinguishes genuine
data corruption from ordinary drift.

### `MISSING_RUN_EVENT`

    { kind: "MISSING_RUN_EVENT"; jobStatus: string; expectedEventTypes: string[] }

The job is in a terminal status, but the corresponding
`engineering_run_events` row is absent. This is the partial-persistence
case Phase 260 detects but does not repair — the job CAS committed
atomically with `execution_events`, but the separate write to
`engineering_run_events` did not complete.

`expectedEventTypes` is a non-empty list. For the current three terminals:

| `jobStatus` | expected `event_type` |
|---|---|
| `SUCCEEDED` | `engineering_run.stage_succeeded` |
| `FAILED` | `engineering_run.stage_failed` |
| `BLOCKED` | `engineering_run.stage_blocked` |

### `UNREADABLE`

    { kind: "UNREADABLE"; reason: string }

One of the ledgers could not be read. `reason` names the failing call
(`"getJobAsync:..."`, `"getEngineeringRunStages:..."`,
`"getEngineeringRunEvents:..."`). When this finding is present, `ok` is
always `false`.

## Compatibility table

The reconciler uses the following mapping to decide whether
`execution_jobs.status` and `engineering_run_stages.capability_status`
are compatible:

| `jobStatus` | compatible `stageStatus` values |
|---|---|
| `SUCCEEDED` | `AVAILABLE` |
| `FAILED` | `UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `BLOCKED` | `UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `CANCELLED` | `UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `DEAD_LETTER` | `UNAVAILABLE`, `NOT_IMPLEMENTED` |

Any terminal job status not in this table is treated as always
compatible (no finding emitted). Non-terminal job statuses (`QUEUED`,
`RUNNING`, `ADMITTED`, etc.) are not checked for compatibility; instead
the reconciler only validates that the stage row exists.

## Return value

- `findings`: one or more of the discriminated union above.
- `ok`: `true` iff `findings.length === 1 && findings[0].kind === "CONSISTENT"`.
  Every other combination returns `ok: false`.

## Read-only guarantee

`reconcileEngineeringStage` calls only:

- `store.getJobAsync(stageId)`
- `runService.getEngineeringRunStages(runId)`
- `runService.getEngineeringRunEvents(runId)`

No `UPDATE`, `INSERT`, `DELETE`, or event append. This makes the
operation idempotent and safe to invoke concurrently (test 260L
exercises three parallel calls and asserts identical findings).

## What this contract does not include

- **Repair.** The reconciler detects `MISSING_RUN_EVENT` but does not
  append the missing event. Fixing that would require either a shared
  transaction with `recoverJobAtomicAsync` (cross-service change) or a
  schema-level outbox (see `transaction-boundaries.md` and
  `known-limitations.md`).
- **Emission.** The reconciler does not write a
  `engineering_run.reconciliation_run` event or any other side effect.
  Callers who need to record that reconciliation ran must do so
  themselves, on their own path.
- **Background scheduling.** The reconciler is a pure function. There is
  no scheduler that invokes it; callers invoke it on demand.