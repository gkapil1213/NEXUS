# Phase 202 Runtime Semantics

## Eligibility reasons

| Reason | Meaning |
|--------|---------|
| `ELIGIBLE` | All dependencies satisfied; stage PENDING; execution active. |
| `STAGE_NOT_FOUND` | Stage name not present in the execution's durable stage set. |
| `STAGE_TERMINAL` | Stage status is SUCCEEDED/FAILED/CANCELLED/SKIPPED. |
| `STAGE_NOT_PENDING` | Stage exists but is not PENDING (e.g. RUNNING). |
| `DEPENDENCY_NOT_SUCCEEDED` | A dependency exists but has not been created or is PENDING. |
| `DEPENDENCY_IN_FLIGHT` | A dependency is RUNNING/CLAIMED/VERIFYING/ADMITTED. |
| `DEPENDENCY_RETRY_PENDING` | A dependency's underlying job status is `RETRY_SCHEDULED`. |
| `DEPENDENCY_TERMINAL_FAILURE` | A dependency's stage status is FAILED/CANCELLED/SKIPPED and job status is not RETRY_SCHEDULED. |
| `EXECUTION_CANCELLED` | The parent execution job has `cancellation_requested=1`. |

Priority when multiple dependencies have different states:
`TERMINAL_FAILURE` > `RETRY_PENDING` > `IN_FLIGHT` > `NOT_SUCCEEDED`.

## Events

Emitted by the orchestrator dependency gate via `store.addEvent`:

- `execution.dependency.satisfied` — the gate passed. Payload: `{executionId, stageName}`.
- `execution.dependency.blocked` — the gate rejected. Payload includes the
  reason and the classified dependency lists (missing/failing/in-flight/retry-pending).

## What admission does NOT do

- It does not transition the stage. Transition happens later via the
  existing adapter `transitionWithLease` path.
- It does not acquire leases. Lease acquisition stays under
  `LeaseManager.acquireLease` / `atomicClaimJob`.
- It does not persist readiness. Eligibility is recomputed from durable
  state on every tick.