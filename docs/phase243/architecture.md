# Phase 243 — Architecture

## Scope
Phase 243 adds a verifier (and no production code) proving that the existing
durable recovery-operation pipeline can be driven end-to-end against real
PostgreSQL with real child processes, and that it survives concurrent claims,
stale owners, worker/scheduler crashes, and a container restart.

## Layer boundaries preserved
- SQLite (in-process sync): local execution state, no coordination authority.
- PostgreSQL (async): authoritative durable recovery-operation state.
- No silent fallback: shared mode requires Postgres; missing Postgres
  surfaces as SHARED_PERSISTENCE_UNREACHABLE at kernel boot.

## Component map
- ExecutionEngine.reconcileExecutionRecoveryOperations(now, limit)
  - pulls due ops via store.recoveryOpsAsync.listResumableOperations(now)
  - claims via CAS (claimOperation)
  - dispatches via runRecoveryOperationAsync (Phase 241 watchdog included)
  - escalates to RECOVERY_REQUIRED at attemptCount >= 5
- AsyncExecutionRecoveryOperationStore — durable CRUD + CAS claims + retry metadata
- operation-failure-classification (Phase 242) — RETRYABLE | NON_RETRYABLE | PERSISTENCE_UNAVAILABLE
- RetryEngine.calculateNextAttempt — deterministic bounded backoff
