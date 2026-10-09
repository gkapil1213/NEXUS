# Phase 259 — Engineering stage executor persistence honesty

## Summary

Fixes a truthfulness gap in `EngineeringStageExecutor`: when a durable write
failed (store throw, CAS rejection, stage transition rejection), the executor
returned `{ ok: true }` with a `SUCCEEDED` / `FAILED` / `BLOCKED` status as if
the write had succeeded.

## Files changed

- `src/core/engineering-stage-executor.ts` — 91 lines
  - `markStageJob` returns `{ ok: boolean; reason?: string }`
  - `applyStageOutcome` propagates `markStageJob` failure
  - `applyStageCompletion` inspects `transitionStage` and `markStageJob`
  - `execute()` inspects both BLOCKED-path `markStageJob` calls
  - Eight `applyStageCompletion` call sites capture and check the result
- `scripts/test-phase259-stage-executor-persistence-honesty.ts` — 231 lines
  - 259A–259F: throws, CAS rejection, transition rejection, happy path,
    Phase 258 regression, BLOCKED not persisted
- `package.json` — one line registering `test:phase259`

## Verification

See `artifacts/phase259/test-run.txt`.

All tests green:

| Suite | PASS | FAIL | BLOCKED | NOT EXECUTED |
|---|---|---|---|---|
| phase259 | 6 | 0 | 0 | 0 |
| phase258 | 6 | 0 | 0 | 0 |
| phase218 | 26 | 0 | 0 | 0 |
| phase257 | 69 | 0 | 0 | 0 |

TypeScript clean, production build succeeds, `git diff --check` clean.

## Design notes

- The fix is deliberately narrow: no new state machine, no schema change,
  no new dependency, no change to the `EngineeringStageExecutorDeps` public
  shape, no change to the DAG, no change to the dispatch boundary.
- `markStageJob`'s intentional idempotent skips (already in target status,
  terminal status preserved) still return `{ ok: true }`.
- Only actual failures — persistence throw, CAS rejection, missing stage
  row, rejected transition — return `{ ok: false }`.
- The reason strings are namespaced by cause so a caller can distinguish
  "the stage execution failed" (`STAGE_TRANSITION_REJECTED:...`,
  `PERSISTENCE_FAILED_AFTER_SUCCEEDED:...`) from "the stage execution
  succeeded but its durable record could not be written."

## Related phases

- Phase 218 — engineering-stage executor wiring and BLOCKED semantics
- Phase 258 — dependency throws become durable FAILED outcomes
- Phase 259 — persistence failures no longer masquerade as success