# Phase 203 Architecture

## Overview

Phase 203 adds the durable execution layer on top of Phase 202's
dependency-aware admission. The central new component is
`runStageGraphToCompletion` in `src/core/stage-dispatch-driver.ts`.

## Layers

    caller (test / orchestrator)
       ?
    runStageGraphToCompletion (203a)
       ? topological order (worker-recovery-dependency)
    evaluateStageAdmission / Async (202a/202d)
       ?
    LeaseManager.acquireLease (Phase 194)
       ?
    StageExecutionStoreAdapter.transitionWithLease (Phase 201)
       ?
    ExecutionAdapter.execute (existing)
       ?
    createAttempt + recordAttemptHeartbeatAsOwner (203b)
       ?
    updateAttemptAsOwner + releaseLease

## Reused primitives (no new system introduced)

- `LeaseManager.acquireLease` — the atomic claim (Phase 194)
- `StageExecutionStoreAdapter.transitionWithLease` — CAS-fenced state moves (Phase 201)
- `evaluateStageAdmission` / `evaluateStageAdmissionAsync` — dependency gate (202a/202d)
- `detectCycle` / `orderDependencies` — graph primitive (worker-recovery-dependency)
- `ExecutionAdapter.execute` — the existing stage executor interface
- `recoverStalledAttemptsTick` + `fenceStaleAttempt` — stall recovery (Phase 197)
- `ExecutionStore.createAttempt` / `updateAttemptAsOwner` / `recordAttemptHeartbeatAsOwner`

## Non-goals

- Retry scheduling (`RETRY_SCHEDULED`) — the driver fails the stage and
  blocks downstream; retry policy belongs to the caller.
- Async driver path — the driver's write path is sync-only today, so
  shared-mode Postgres dispatch would require async plumbing not present
  in 203a–203e.
- Intra-tick parallel dispatch — the driver processes admitted stages
  sequentially within one invocation. Concurrent branch execution is
  achieved via multiple driver invocations with distinct workerIds,
  serialized by the lease CAS (see 203a S7, 203c S5, 203e S1).