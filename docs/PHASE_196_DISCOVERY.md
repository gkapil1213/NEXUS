# NEXUS Phase 196 — Discovery

## Baseline

    HEAD:  f9f2f91648750d2feed9335275a4fe29b0ef1c93
    tag:   nexus-phase195-complete
    branch: master == origin/master

## Existing capabilities (reuse, do not rebuild)

### Kernel / lifecycle
- Phase 193 boot + shutdown with single-flight bootPromise
- Phase 192 kernel restart safety

### Execution state machine
- `execution-state-machine.ts` — explicit VALID_TRANSITIONS, `canTransition`
- `ExecutionEngine.applyTransition` — the single entry point for every durable job transition
- 15 classification-like constants already present

### Leases / fencing
- Phase 194 atomic expired-lease takeover in `ExecutionStore.acquireLease`
- `LeaseManager` sync + async surfaces
- `execution_leases` table, partial unique index on `(job_id) WHERE status='ACTIVE'`

### Recovery operations (durable)
- `execution_recovery_operations` (migration 154) — durable, idempotent per `(job_id, lease_id, operation_type)`
- `execution_ownership_obligations` (migration 149) — durable ownership-loss records
- `ExecutionRecoveryOperationStore` (608 lines) — create/get/claim/renew/mark*
- `ExecutionEngine.recoverStaleJobs` (from L1371) — expired-lease discovery, orphan, timeout, cancellation branches

### Supervisor loop
- `release-recovery-supervisor.ts` (343 lines) — `start()`, `stop()`, `runNow()`, `status()`
- Runs `ReleaseRecoveryExecutor.runOnce()` on a schedule with backoff
- Already produces `ReleaseRecoverySupervisor` status

### Events / audit
- `execution_events` append-only log
- `AuditService` — every durable transition records audit

### Operator HTTP (partial)
- `src/api/recovery/routes.ts` — reconciliation + cancellation requests for **release deployment intents**
- `src/api/reliability.ts`

### Worker-level heartbeat
- `last_heartbeat_at` on worker/session/lease tables (020, 021, 024, 026, 030, 036, 113)
- `WorkerRegistry.heartbeat(workerId, ...)`
- `heartbeatIntervalMs` config on `worker-config.ts` and `worker-enrollment.ts`

## Missing capabilities (Phase 196's actual scope)

### 1. Per-attempt heartbeat and progress
No `heartbeat_at` and no `last_progress_at` on `execution_attempts`. The lease carries `expires_at`, but a worker that is alive-but-stuck (long GC, deadlock, infinite loop) still renews its lease — there is no way to distinguish "worker process dead" from "worker process alive but making no meaningful progress".

### 2. HEARTBEAT_TIMEOUT vs PROGRESS_TIMEOUT classification
`recoverStaleJobs` only fires on expired lease. There is no code path that classifies a running job by elapsed time since last heartbeat vs elapsed time since last progress.

### 3. Durable supervision state on the job
No column or table records SUSPECTED_STALL / RECOVERY_PENDING / OPERATOR_REQUIRED at the job level. Release intents have `lastFailureClass`, `recoveryAttempts`, `nextRetryAt` (migration 160); execution jobs do not have equivalents.

### 4. Config surface for supervision
- `heartbeatIntervalMs` — exists (worker scope only)
- `heartbeatTimeoutMs` — exists only in worker-phase71
- `progressTimeoutMs` — absent
- `supervisorIntervalMs` — absent for execution-level supervision
- `maxRecoveryAttempts` — exists in worker-policy (worker scope only)

### 5. Job-level operator actions
`RecoveryControlService` accepts intent keys. There is no equivalent for job IDs. Operator cannot request recovery / retry / cancellation of an individual execution job from the control plane.

## Phase 196 implementation boundary

In scope:

1. Migration 165 — add `heartbeat_at`, `last_progress_at` to `execution_attempts`
2. Migration 166 — add `supervision_state`, `failure_class`, `supervision_updated_at` to `execution_jobs`
3. `ExecutionEngine.recordHeartbeat(jobId, attemptId, workerId, leaseId)` — durable, fenced
4. `ExecutionEngine.recordProgress(jobId, attemptId, workerId, leaseId)` — durable, fenced
5. `ExecutionEngine.classifySupervision(jobId)` — returns HEALTHY | HEARTBEAT_TIMEOUT | PROGRESS_TIMEOUT
6. Extend `recoverStaleJobs` to classify heartbeat/progress timeouts (in addition to lease-expired) and to set `supervision_state`
7. Config keys in `config.ts`: `execution.heartbeatTimeoutMs`, `execution.progressTimeoutMs`, `execution.supervisorIntervalMs`, `execution.maxRecoveryAttempts` — with documented defaults
8. Extend `RecoveryControlService` with `requestJobRecovery(jobId)`, `requestJobRetry(jobId)`, `requestJobCancellation(jobId)` — each durable, each event + audit
9. `scripts/test-phase196-execution-supervision.ts`
10. `docs/PHASE_196_EXECUTION_SUPERVISION_EVIDENCE.md`

Out of scope (documented, not implemented):

- A new supervision state machine enum. Supervision states map onto existing `ExecutionJobStatus` plus a small string column.
- Postgres parity for the new columns. SQLite first. `pg-bootstrap.ts` would need parallel DDL; marked as follow-on.
- A UI. The spec says "where the repository already has an operational/control-plane UI". No such UI exists in the repo. The backend HTTP route is the deliverable.
- Any change to `ExecutionStore.acquireLease` (Phase 194 is preserved).

## Preserved

- All Phase 126–195 behavior
- `nexus-phase195-complete` tag untouched
- No published migration is modified
