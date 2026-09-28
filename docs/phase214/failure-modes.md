# Phase 214 - Failure Modes

## Explicit statuses

| Condition | Status |
|---|---|
| stage capability not available | BLOCKED (persisted with reason) |
| underlying execution_jobs -> FAILED | stage is FAILED, run remains non-terminal until finalized |
| underlying execution_jobs -> SUCCEEDED | stage SUCCEEDED |
| unauthorized transition | rejected (WORKER_OWNERSHIP_LOST / CAS_LOST) |
| stale worker CAS | rejected, durable status unchanged |
| terminal parent execution_jobs | reconcile reports TERMINAL_SAFE or INCONSISTENT |
| duplicate submission | idempotent, one run |
| concurrent duplicate submission | one winner, others read the winner |
| second cancellation | ALREADY_CANCELLED_OR_TERMINAL |

## Never fabricated

- A stage record existing does NOT mean execution succeeded.
- capability_status cannot move to SUCCEEDED; only the underlying
  execution_jobs row carries success, and it moves only via
  recoverJobAtomicAsync or the state machine.
- No LLM or AI capability is asserted in this phase.
