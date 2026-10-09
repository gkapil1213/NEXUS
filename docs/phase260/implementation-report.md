# Phase 260 — Implementation report

## Root cause addressed

Phase 258 made the engineering-stage executor convert *dependency
throws* (a planning or implementation call throwing) into durable
`FAILED` outcomes. Phase 259 made the executor report *persistence
failures* honestly: when `markStageJob` could not write, the executor
returned `{ ok: false }` instead of the misleading `{ ok: true }`.

But two adjacent correctness gaps remained:

1. **CAS rejection was classified as a single failure.** `markStageJob`
   returned `{ ok: false, reason: "CAS_REJECTED" }` for every `{ ok: false }`
   from `recoverJobAtomicAsync`. That conflated three genuinely
   different cases:
   - the durable state already matches the requested target
     (a legitimate idempotent retry — should be `{ ok: true }`),
   - the durable state is a *different* terminal (a conflict — should
     be reported as such),
   - another writer won the race and the job is still non-terminal
     (a genuine CAS rejection).

2. **Terminal-preserve silently succeeded on a request that would
   change a terminal status.** When the job was already `FAILED` or
   `BLOCKED`, `markStageJob` returned `{ ok: true }` for a request that
   targeted `SUCCEEDED`. The caller then reported `{ ok: true,
   status: "SUCCEEDED" }` — a lie: the durable state said `FAILED`.

Phase 260 closes both:

- `markStageJob` now classifies CAS rejection into one of
  `IDEMPOTENT`, `TERMINAL_CONFLICT:<status>`, or `CAS_REJECTED`, based
  on a re-read of the durable job row.
- The terminal-preserve early return now returns
  `{ ok: false, reason: "TERMINAL_CONFLICT:" + current }`, not
  `{ ok: true }`.

Additionally, Phase 260 introduces a read-only reconciliation service
(`src/core/engineering-stage-reconciler.ts`) that classifies the state
of a single stage across the three durable ledgers. It detects the
partial-persistence condition (`MISSING_RUN_EVENT`) that Phase 259
surfaced but could not repair (see `known-limitations.md`).

## Files changed

### `src/core/engineering-stage-executor.ts` — modified

`markStageJob` changes:

- Return type unchanged: `Promise<{ ok: boolean; reason?: string }>`.
- Early return `current.status === targetStatus` → `{ ok: true, reason: "IDEMPOTENT" }`.
- Early return `JOB_TERMINAL.has(current.status) && targetStatus !== current.status` → `{ ok: false, reason: "TERMINAL_CONFLICT:" + current.status }`.
- Post-CAS `!result.ok` path now re-reads the job:
  - re-read throws → `{ ok: false, reason: "RECONCILIATION_UNAVAILABLE" }`
  - job missing → `{ ok: false, reason: "JOB_NOT_FOUND" }`
  - `after.status === targetStatus` → `{ ok: true }`
  - `JOB_TERMINAL.has(after.status)` → `{ ok: false, reason: "TERMINAL_CONFLICT:" + after.status }`
  - otherwise → `{ ok: false, reason: "CAS_REJECTED" }`

No other method in this file was changed by Phase 260. Phase 259's
changes to `applyStageOutcome`, `applyStageCompletion`, and the eight
call sites remain intact.

### `src/core/engineering-stage-reconciler.ts` — new file

~150 lines. Exports `StageReconciliationFinding` (a discriminated union)
and `reconcileEngineeringStage(input)`. Reads `store.getJobAsync`,
`runService.getEngineeringRunStages`, `runService.getEngineeringRunEvents`.
Classifies the state as one of `CONSISTENT`, `MISSING_JOB`,
`MISSING_STAGE`, `STAGE_JOB_MISMATCH`, `TERMINAL_CONFLICT`,
`MISSING_RUN_EVENT`, `UNREADABLE`. Never writes. See
`reconciliation-contract.md` for the full contract.

### `scripts/test-phase260-stage-reconciliation.ts` — new file

~360 lines. Fourteen tests (260A-260N) exercising the real code paths
against the shared Postgres backend. Uses the Phase 259 harness pattern
(`NexusKernel.boot()`, `EngineeringRunService`, `EngineeringStageExecutor`).
Wraps the real `ExecutionStore` with a `Proxy` that fails a single
`recoverJobAtomicAsync` call for the failure-injection tests, then
delegates. No in-memory fakes.

260G (partial-persistence repair) is registered as `NOT EXECUTED` with
an explicit reason, per the brief §7.

### `package.json` — modified

One line added:

    "test:phase260":  "tsx scripts/test-phase260-stage-reconciliation.ts",

### `docs/phase260/*` — new directory

Five markdown files documenting the transaction boundaries, the
reconciliation contract, the implementation report (this file), the
test results, and the known limitations.

### `artifacts/phase260/*` — new directory

`test-run.txt` capturing the exact command outputs from the verification
sweep.

## What was NOT changed

- **No schema migration.** `engineering_run_events`,
  `execution_jobs`, `engineering_run_stages`, and `execution_events`
  retain their existing shapes.
- **No new transaction semantics.** The store's existing transaction
  boundaries are unchanged.
- **No change to `EngineeringStageExecutorDeps`** (the public dependency
  shape) or `StageExecutionOutcome`.
- **No change to the DAG, registry, dispatch, or ownership model.**
- **No outbox, no saga, no distributed transaction.** The partial-
  persistence repair deferred by the brief §4C would require one of
  those; see `known-limitations.md`.

## Interaction with prior phases

| Phase | Behavior | Phase 260 effect |
|---|---|---|
| 214 | Engineering run DAG and stage rows | unchanged |
| 218 | Stage dispatch routing, ownership | unchanged |
| 258 | Dependency throws → durable `FAILED` | unchanged; new test 260N confirms |
| 259 | Persistence failures return `{ ok: false }` | partially superseded: `CAS_REJECTED` from 259 is now split into `IDEMPOTENT` / `TERMINAL_CONFLICT` / `CAS_REJECTED` |

The Phase 259 test suite `test:phase259` continues to pass (6/0/0). Its
259B assertion ("CAS rejected -> ok:false") now receives a
`TERMINAL_CONFLICT` or `CAS_REJECTED` reason but still returns
`{ ok: false }`, which is what the assertion checks.

## Verification summary

    npm run typecheck                 -> PASS (clean)
    npm run test:phase260             -> PASS 13, FAIL 0, BLOCKED 0, NOT EXECUTED 1
    npm run test:phase259             -> PASS 6,  FAIL 0
    npm run test:phase258             -> PASS 6,  FAIL 0
    npm run test:phase218             -> PASS 26, FAIL 0
    npm run test:phase257             -> PASS 69, FAIL 0
    npm run build                     -> PASS (vite, 166 modules, 6.56s)
    git diff --check                  -> PASS (silent)

See `test-results.md` for the full output blocks.