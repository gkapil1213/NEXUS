# Phase 259 — Findings

**Baseline**: commit `0933dea` (Phase 258 merge), branch `master`, working tree clean.
**Date**: 2026-10-09
**Scope**: engineering-stage executor persistence honesty.

## Defect

`EngineeringStageExecutor.markStageJob` returned `Promise<void>` and swallowed
every persistence failure in a bare `catch {}`. Its callers
(`applyStageOutcome`, `applyStageCompletion`, `execute`) ignored the return
value and unconditionally returned `{ ok: true, status: "<STAGE_STATUS>" }`.

Consequence: when a durable write failed —
- `store.recoverJobAtomicAsync` threw,
- `store.recoverJobAtomicAsync` returned `{ ok: false }` (CAS rejected),
- `runService.transitionStage` returned `{ ok: false, updated: false }`,
- or `runService.recordStageExecutionEvent` threw —

`execute()` still returned `{ ok: true }` with a `SUCCEEDED` / `FAILED` /
`BLOCKED` status. The caller (dispatch boundary, monitoring, or an
operator reading the return value) saw a state that was never persisted.

This is a truthfulness violation: a status reported as executed when it
was not persisted. It reintroduced, on the persistence-throw path, the
class of bug Phase 258 closed for the dependency-throw path.

## Evidence

The new test file `scripts/test-phase259-stage-executor-persistence-honesty.ts`
failed 4/6 assertions against the unfixed baseline:

    [FAIL] 259A store throws -> ok:false
      got {"ok":true,...,"status":"BLOCKED","reason":"PROVIDER_NOT_CONFIGURED"}
    [FAIL] 259B CAS rejected -> ok:false
      got {"ok":true,...,"status":"BLOCKED","reason":"PROVIDER_NOT_CONFIGURED"}
    [FAIL] 259C transitionStage rejected -> ok:false
      got {"ok":true,...,"status":"SUCCEEDED","reason":"OK"}
    [FAIL] 259F BLOCKED not persisted -> ok:false
      got {"ok":true,...,"status":"BLOCKED","reason":"UPSTREAM_NOT_SUCCEEDED:PLANNING:QUEUED"}

259D (happy path) and 259E (Phase 258 dependency throw) passed, confirming the
existing behavior was otherwise correct.

## Fix

Four method-body rewrites and eight call-site guards in
`src/core/engineering-stage-executor.ts`:

1. `markStageJob` now returns `{ ok: boolean; reason?: string }`. The bare
   `catch {}` is replaced with `catch { return { ok: false, reason:
   "PERSISTENCE_FAILED" }; }`. A rejected CAS returns
   `{ ok: false, reason: "CAS_REJECTED" }`. A missing stage row after a
   successful job CAS returns `{ ok: false, reason: "STAGE_ROW_MISSING" }`.
   Intentional idempotent skips (`current.status === targetStatus`, terminal
   status preserved) still return `{ ok: true }`.

2. `applyStageOutcome` checks `markStageJob`'s result. On failure, returns
   `{ ok: false, reason: "PERSISTENCE_FAILED_AFTER_<OUTCOME>:<DETAIL>" }`
   instead of `{ ok: true, status: "<OUTCOME>" }`.

3. `applyStageCompletion` now returns `{ ok: boolean; reason?: string }`. It
   inspects `transitionStage`'s return value; if the transition was rejected
   (`!t.ok && !t.updated`), it returns
   `{ ok: false, reason: "STAGE_TRANSITION_REJECTED:<reason>" }` and does not
   proceed to mark the job SUCCEEDED. It then checks `markStageJob` and
   propagates failure.

4. `execute()` inspects the two `markStageJob` calls on its BLOCKED paths
   (`STAGE_NOT_WIRED`, `UPSTREAM_NOT_SUCCEEDED`) and returns
   `{ ok: false, reason: "PERSISTENCE_FAILED_AFTER_BLOCKED:<DETAIL>" }` on
   failure.

5. The eight `applyStageCompletion` call sites in `executePlanning` /
   `executeArchitecture` / `executeImplementation` / `executeBuild` /
   `executeTest` / `executeDiagnosis` / `executeRepair` /
   `executeSecurityReview` now capture `completion` and return
   `{ ok: false, reason: completion.reason ?? "PERSISTENCE_FAILED_AFTER_SUCCEEDED" }`
   if it failed.

## Verification

    npm run typecheck                 → clean
    npm run test:phase259             → PASS: 6, FAIL: 0
    npm run test:phase258             → PASS: 6, FAIL: 0
    npm run test:phase218             → PASS: 26, FAIL: 0
    npm run test:phase257             → PASS: 69, FAIL: 0
    npm run build                     → ✓ built in 7.03s
    git diff --check                  → clean

## Non-goals

- No database schema change.
- No new dependency.
- No change to `EngineeringStageExecutorDeps` public shape.
- No change to the DAG, the stage registry, or the dispatch boundary.
- No new state machine. The existing `execution_jobs` lifecycle and the
  `JOB_TERMINAL` guard are preserved.