# Phase 304b - Evidence-Based Review

Generated: 2026-11-16 09:44:09
This report is READ-ONLY. No script was executed. No file was modified or deleted.
All recommendations are advisory only.

Scope: 42 UNKNOWN + 112 DORMANT_TEST + 10 BACKUP + 8 DEBUG_SCRATCH = 172 files reviewed.

## Section 1: UNKNOWN files (42) - purpose discovery

### _phase182_child.ts
- **Path**: scripts/_phase182_child.ts
- **Purpose (from comments)**: scripts/_phase182_child.ts Phase 182 child worker. Dispatches one command against a shared SQLite database and prints one JSON line to stdout. Used by the Phase 182 harness to exercise real multi-process coordination on a shared file.
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/migration-runner, ../src/core/release-deployment-intent, ../src/core/sqlite-engine, ../src/server/idempotency
- **Phase**: 182
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase183a_child.ts
- **Path**: scripts/_phase183a_child.ts
- **Purpose (from comments)**: scripts/_phase183a_child.ts Phase 183a child: one idempotency operation against real shared Postgres.
- **Imports (first 5)**: ../src/core/pg-bootstrap, ../src/core/pg-client, ../src/core/pg-idempotency-store
- **Phase**: 183a
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase183b_intents_child.ts
- **Path**: scripts/_phase183b_intents_child.ts
- **Purpose (from comments)**: scripts/_phase183b_intents_child.ts Phase 183b child: one release-intent operation against real Postgres.
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/release-deployment-intent, ../src/core/sqlite-engine
- **Phase**: 183b
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase183b_jobs_child.ts
- **Path**: scripts/_phase183b_jobs_child.ts
- **Purpose (from comments)**: scripts/_phase183b_jobs_child.ts Phase 183b child: exercises async job/recovery methods against real Postgres.
- **Imports (first 5)**: ../src/core/execution-recovery-operation-store, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Phase**: 183b
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase183c_attempts_child.ts
- **Path**: scripts/_phase183c_attempts_child.ts
- **Purpose (from comments)**: scripts/_phase183c_attempts_child.ts Phase 183c child: one attempts/workers operation against real Postgres.
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Phase**: 183c
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase183d_child.ts
- **Path**: scripts/_phase183d_child.ts
- **Purpose (from comments)**: scripts/_phase183d_child.ts Phase 183d child: cross-process read of Postgres-persisted attempt state.
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Phase**: 183d
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### _phase263f_child.ts
- **Path**: scripts/_phase263f_child.ts
- **Purpose (from comments)**: scripts/_phase263f_child.ts Child worker for the phase 263f event-sequence atomicity test. Allocates N sequence values from the given SQLite store via the real SQLiteEngine, then prints them as a JSON array on stdout. Usage: tsx _phase263f_child.ts <dbPath> <store> <count>
- **Imports (first 5)**: ../src/core/sqlite-engine
- **Phase**: 263f
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### boot-once.ts
- **Path**: scripts/boot-once.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ./src/core/kernel
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### diag-137-10.ts
- **Path**: scripts/diag-137-10.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/execution-adapter, ../src/core/execution-dispatch-port, ../src/core/execution-engine, ../src/core/execution-store
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### diag-clean-migrations.ts
- **Path**: scripts/diag-clean-migrations.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/sqlite-engine, node:fs, node:os, node:path
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### diag-migration-180.ts
- **Path**: scripts/diag-migration-180.ts
- **Purpose (from comments)**: Scenario A: fresh DB — apply all migrations including 180
- **Imports (first 5)**: better-sqlite3, fs, path
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### diag-schema.ts
- **Path**: scripts/diag-schema.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: better-sqlite3, fs, path
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### diag-smoke.ts
- **Path**: scripts/diag-smoke.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: better-sqlite3
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### host-bridge-node.ts
- **Path**: scripts/host-bridge-node.ts
- **Purpose (from comments)**: scripts/host-bridge-node.ts Shared Node-side implementation of HostBridge (src/core/runtime.ts). Same contract the browser host satisfies via window.__NEXUS_HOST__. Extracted from the pattern already used by: scripts/run-canonical-deployment-e2e.ts scripts/run-docker-engineering-e2e.ts scripts/test-phase191-deployment-execution.ts Not a parallel architecture: a faithful Node implementation of the same HostBridge interface (real filesystem, real process spawn).
- **Imports (first 5)**: ../src/core/runtime, node:child_process, node:fs/promises, node:path
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### nexus-host-bridge.mjs.phase298-backup
- **Path**: scripts/nexus-host-bridge.mjs.phase298-backup
- **Purpose (from comments)**: NEXUS Windows Host Bridge (Phase 3 Pass 5 -> connection layer). Connects the browser RuntimeBridge (src/core/runtime.ts) to the REAL host without ever exposing arbitrary command execution: NEXUS UI (served from dist/ at http://localhost:3000) ->  window.__NEXUS_HOST__ (injected shim, Bearer-token authenticated) POST /v1/exec  -> structured { tool, args } ONLY; no free-form commands
- **Imports (first 5)**: ./nexus-host-bridge-redaction.mjs, fs, node:child_process, node:crypto, node:fs
- **Phase**: 298
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: BACKUP_REVIEW_REQUIRED

### nexus-host-bridge.mjs.phase298-hardening-backup
- **Path**: scripts/nexus-host-bridge.mjs.phase298-hardening-backup
- **Purpose (from comments)**: NEXUS Windows Host Bridge (Phase 3 Pass 5 -> connection layer). Connects the browser RuntimeBridge (src/core/runtime.ts) to the REAL host without ever exposing arbitrary command execution: NEXUS UI (served from dist/ at http://localhost:3000) ->  window.__NEXUS_HOST__ (injected shim, Bearer-token authenticated) POST /v1/exec  -> structured { tool, args } ONLY; no free-form commands
- **Imports (first 5)**: ./nexus-host-bridge-redaction.mjs, fs, node:child_process, node:crypto, node:fs
- **Phase**: 298
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: BACKUP_REVIEW_REQUIRED

### nexus-host-bridge.mjs.phase298-preflight-backup
- **Path**: scripts/nexus-host-bridge.mjs.phase298-preflight-backup
- **Purpose (from comments)**: NEXUS Windows Host Bridge (Phase 3 Pass 5 -> connection layer). Connects the browser RuntimeBridge (src/core/runtime.ts) to the REAL host without ever exposing arbitrary command execution: NEXUS UI (served from dist/ at http://localhost:3000) ->  window.__NEXUS_HOST__ (injected shim, Bearer-token authenticated) POST /v1/exec  -> structured { tool, args } ONLY; no free-form commands
- **Imports (first 5)**: ./nexus-host-bridge-redaction.mjs, fs, node:child_process, node:crypto, node:fs
- **Phase**: 298
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: BACKUP_REVIEW_REQUIRED

### nexus-host-bridge-redaction.d.mts
- **Path**: scripts/nexus-host-bridge-redaction.d.mts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: (none)
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: SMALL_SCRIPT_REVIEW

### phase202-evidence.ts
- **Path**: scripts/phase202-evidence.ts
- **Purpose (from comments)**: scripts/phase202-evidence.ts Produces artifacts/phase202/phase202-evidence.json from actual test runs.
- **Imports (first 5)**: child_process, fs
- **Phase**: 202
- **Phase artifacts**: artifacts/phase202/, docs/phase202/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase203-evidence.ts
- **Path**: scripts/phase203-evidence.ts
- **Purpose (from comments)**: scripts/phase203-evidence.ts Runs each Phase 203 slice, parses PASS/FAIL/BLOCKED, writes artifacts/phase203/phase203-evidence.json.
- **Imports (first 5)**: child_process, fs
- **Phase**: 203
- **Phase artifacts**: artifacts/phase203/, docs/phase203/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase205-evidence.ts
- **Path**: scripts/phase205-evidence.ts
- **Purpose (from comments)**: scripts/phase205-evidence.ts Runs Phase 205 reconciliation suite, writes artifacts/phase205/phase205-evidence.json.
- **Imports (first 5)**: child_process, fs
- **Phase**: 205
- **Phase artifacts**: artifacts/phase205/, docs/phase205/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase206-evidence.ts
- **Path**: scripts/phase206-evidence.ts
- **Purpose (from comments)**: scripts/phase206-evidence.ts
- **Imports (first 5)**: child_process, fs
- **Phase**: 206
- **Phase artifacts**: artifacts/phase206/, docs/phase206/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase207-evidence.ts
- **Path**: scripts/phase207-evidence.ts
- **Purpose (from comments)**: scripts/phase207-evidence.ts
- **Imports (first 5)**: node:child_process, node:fs, node:path
- **Phase**: 207
- **Phase artifacts**: artifacts/phase207/, docs/phase207/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase208-evidence.ts
- **Path**: scripts/phase208-evidence.ts
- **Purpose (from comments)**: scripts/phase208-evidence.ts
- **Imports (first 5)**: node:child_process, node:fs, node:path
- **Phase**: 208
- **Phase artifacts**: artifacts/phase208/, docs/phase208/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase209-evidence.ts
- **Path**: scripts/phase209-evidence.ts
- **Purpose (from comments)**: scripts/phase209-evidence.ts Phase 209: evidence generator. Derives from artifacts/phase209/verification-run.json (produced by scripts/verify-phase.ts). No hardcoded counts. Fails if the verification run is missing or its digests do not match.
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 209
- **Phase artifacts**: artifacts/phase209/, docs/phase209/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase210-evidence.ts
- **Path**: scripts/phase210-evidence.ts
- **Purpose (from comments)**: scripts/phase210-evidence.ts Phase 210: evidence generator. Derives from artifacts/phase210/verification-run.json. No hardcoded counts. Fails if digests do not match.
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 210
- **Phase artifacts**: artifacts/phase210/, docs/phase210/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase211-evidence.ts
- **Path**: scripts/phase211-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 211
- **Phase artifacts**: artifacts/phase211/, docs/phase211/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase212-evidence.ts
- **Path**: scripts/phase212-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 212
- **Phase artifacts**: artifacts/phase212/, docs/phase212/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase214-evidence.ts
- **Path**: scripts/phase214-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 214
- **Phase artifacts**: artifacts/phase214/, docs/phase214/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase215-evidence.ts
- **Path**: scripts/phase215-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 215
- **Phase artifacts**: artifacts/phase215/, docs/phase215/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase216-evidence.ts
- **Path**: scripts/phase216-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 216
- **Phase artifacts**: artifacts/phase216/, docs/phase216/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase218-evidence.ts
- **Path**: scripts/phase218-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 218
- **Phase artifacts**: artifacts/phase218/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase219-evidence.ts
- **Path**: scripts/phase219-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 219
- **Phase artifacts**: artifacts/phase219/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase221-evidence.ts
- **Path**: scripts/phase221-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 221
- **Phase artifacts**: artifacts/phase221/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase222-evidence.ts
- **Path**: scripts/phase222-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 222
- **Phase artifacts**: artifacts/phase222/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase223-evidence.ts
- **Path**: scripts/phase223-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 223
- **Phase artifacts**: artifacts/phase223/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### phase224-evidence.ts
- **Path**: scripts/phase224-evidence.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, node:child_process, node:fs, node:path
- **Phase**: 224
- **Phase artifacts**: artifacts/phase224/
- **Mentioned in docs**: True
- **Recommendation**: PHASE_ARTIFACT_EXISTS

### record-approval.ts
- **Path**: scripts/record-approval.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/approval-service.ts
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### workspace (7).tar
- **Path**: scripts/workspace (7).tar
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: (none)
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### wp2-claim-worker.ts
- **Path**: scripts/wp2-claim-worker.ts
- **Purpose (from comments)**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### wp3-cancel-worker.ts
- **Path**: scripts/wp3-cancel-worker.ts
- **Purpose (from comments)**: Child process for test-phase300-wp3-cross-process.ts. Exercises the production DispatchService.cancelDetailed() path.
- **Imports (first 5)**: ../src/core/dispatch-service, ../src/core/execution-store, ../src/core/job-dispatcher, ../src/core/pg-async-engine, ../src/core/pg-client
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

### wp3-result-worker.ts
- **Path**: scripts/wp3-result-worker.ts
- **Purpose (from comments)**: Child process for test-phase300-wp3-cross-process.ts. Reads a JSON payload from WP3_PAYLOAD env var. Calls persistRemoteExecutionResultAndDispatchAsOwnerAsync once, with the result and dispatch described by the payload. Emits the outcome as JSON on stdout. The payload fields: dispatchId, jobId, workerId, leaseId, resultId, resultSha256, dispatchStatus ("COMPLETED" | "FAILED") No other behavior. This keeps the child's contribution to the test
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Mentioned in docs**: True
- **Recommendation**: REVIEW_FURTHER

## Section 2: DORMANT_TEST files (112) - wire-up candidates

### nexus-host-bridge-redaction.mjs
- **Path**: scripts/nexus-host-bridge-redaction.mjs
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: (none)
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: LOW_CONTENT_REQUIRES_REVIEW

### pin-actions.mjs
- **Path**: scripts/pin-actions.mjs
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: node:child_process, node:fs
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-failure-detection.ts
- **Path**: scripts/test-failure-detection.ts
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/alerting.ts, ../src/core/failure-detection.ts, ../src/core/observability.ts
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-pg-bootstrap-focused.ts
- **Path**: scripts/test-pg-bootstrap-focused.ts
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/pg-bootstrap, ../src/core/pg-client
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase117-rollback.ts
- **Path**: scripts/test-phase117-rollback.ts
- **Phase**: 117
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/worker-deployment-adapter, ../src/core/worker-phase25-autonomous-release-deployment-control-plane
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase118-rollback-recovery.ts
- **Path**: scripts/test-phase118-rollback-recovery.ts
- **Phase**: 118
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/config, ../src/core/db, ../src/core/execution-store, ../src/core/worker-deployment-adapter, ../src/core/worker-phase25-autonomous-release-deployment-control-plane
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase119-rollback-recovery.ts
- **Path**: scripts/test-phase119-rollback-recovery.ts
- **Phase**: 119
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/execution-store, ../src/core/release-deployment-intent, ../src/core/release-recovery, ../src/core/release-recovery-executor
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase120-production-rollback-verification.ts
- **Path**: scripts/test-phase120-production-rollback-verification.ts
- **Phase**: 120
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/execution-store, ../src/core/release-deployment-intent, ../src/core/release-recovery, ../src/core/release-recovery-executor
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase121-rollback-verification-evidence.ts
- **Path**: scripts/test-phase121-rollback-verification-evidence.ts
- **Phase**: 121
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/events, ../src/core/execution-store, ../src/core/release-deployment-intent, ../src/core/release-recovery
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase122-recovery-evidence-reconciliation.ts
- **Path**: scripts/test-phase122-recovery-evidence-reconciliation.ts
- **Phase**: 122
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/db, ../src/core/events, ../src/core/execution-store, ../src/core/release-deployment-intent
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase123-production-recovery-evidence-integration.ts
- **Path**: scripts/test-phase123-production-recovery-evidence-integration.ts
- **Phase**: 123
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/db, ../src/core/events, ../src/core/execution-store, ../src/core/release-deployment-intent
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase124-durable-recovery-required.ts
- **Path**: scripts/test-phase124-durable-recovery-required.ts
- **Phase**: 124
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/execution-store, ../src/core/release-deployment-intent, ../src/core/release-recovery, ../src/core/release-recovery-evidence-reconciliation
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase125-recovery-supervisor.ts
- **Path**: scripts/test-phase125-recovery-supervisor.ts
- **Phase**: 125
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/config, ../src/core/db, ../src/core/events, ../src/core/release-recovery-executor
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase126-execution-lifecycle.ts
- **Path**: scripts/test-phase126-execution-lifecycle.ts
- **Phase**: 126
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/config, ../src/core/db, ../src/core/execution-dispatch-port, ../src/core/execution-engine, ../src/core/execution-models
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase127-execution-state-machine.ts
- **Path**: scripts/test-phase127-execution-state-machine.ts
- **Phase**: 127
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/execution-dispatch-port, ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-state-machine
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase128-execution-completion.ts
- **Path**: scripts/test-phase128-execution-completion.ts
- **Phase**: 128
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-dispatch-port, ../src/core/execution-engine, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/migration-runner
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase135-ci-reconciliation-integrity.ts.phase135-backup
- **Path**: scripts/test-phase135-ci-reconciliation-integrity.ts.phase135-backup
- **Phase**: 135
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/ci-artifact-reconciliation.service, ../src/core/cicd, ../src/core/cicd-reconciliation.service, ../src/core/ci-reconciliation-ownership.service, ../src/core/github
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: POSSIBLE_DUPLICATE_REQUIRES_COMPARISON

### test-phase136-execution-recovery.ts
- **Path**: scripts/test-phase136-execution-recovery.ts
- **Phase**: 136
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/artifact-store, ../src/core/db, ../src/core/execution-adapter, ../src/core/execution-dispatch-port, ../src/core/execution-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase137-cancellation-timeout.ts
- **Path**: scripts/test-phase137-cancellation-timeout.ts
- **Phase**: 137
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/dispatch-service, ../src/core/execution-adapter, ../src/core/execution-dispatch-port, ../src/core/execution-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase140-attempt-binding.ts
- **Path**: scripts/test-phase140-attempt-binding.ts
- **Phase**: 140
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/deployment-release-bridge, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/production-release-enforcement
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase143-transactional-execution-recovery.ts
- **Path**: scripts/test-phase143-transactional-execution-recovery.ts
- **Phase**: 143
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase144-durable-recovery-operations.ts
- **Path**: scripts/test-phase144-durable-recovery-operations.ts
- **Phase**: 144
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase145-reconciliation-integrity.ts
- **Path**: scripts/test-phase145-reconciliation-integrity.ts
- **Phase**: 145
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase146-retry-budget-recovery.ts
- **Path**: scripts/test-phase146-retry-budget-recovery.ts
- **Phase**: 146
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase147-durable-retry-scheduling.ts
- **Path**: scripts/test-phase147-durable-retry-scheduling.ts
- **Phase**: 147
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase147-retry-scheduling-integrity.ts
- **Path**: scripts/test-phase147-retry-scheduling-integrity.ts
- **Phase**: 147
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/retry-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase148-atomic-attempt-allocation.ts
- **Path**: scripts/test-phase148-atomic-attempt-allocation.ts
- **Phase**: 148
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase149-attempt-lifecycle-integrity.ts
- **Path**: scripts/test-phase149-attempt-lifecycle-integrity.ts
- **Phase**: 149
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase150-job-attempt-terminal-consistency.ts
- **Path**: scripts/test-phase150-job-attempt-terminal-consistency.ts
- **Phase**: 150
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase151-recovery-finalization.ts
- **Path**: scripts/test-phase151-recovery-finalization.ts
- **Phase**: 151
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase152-recovery-concurrency.ts
- **Path**: scripts/test-phase152-recovery-concurrency.ts
- **Phase**: 152
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase153-recovery-lease-fencing.ts
- **Path**: scripts/test-phase153-recovery-lease-fencing.ts
- **Phase**: 153
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase154-recovery-cancellation-shutdown.ts
- **Path**: scripts/test-phase154-recovery-cancellation-shutdown.ts
- **Phase**: 154
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase155-strict-recovery-cancellation-fencing.ts
- **Path**: scripts/test-phase155-strict-recovery-cancellation-fencing.ts
- **Phase**: 155
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase156-recovery-lifecycle-integrity.ts
- **Path**: scripts/test-phase156-recovery-lifecycle-integrity.ts
- **Phase**: 156
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase157-recovery-operation-idempotency.ts
- **Path**: scripts/test-phase157-recovery-operation-idempotency.ts
- **Phase**: 157
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase158-recovery-worker-heartbeat-lease.ts
- **Path**: scripts/test-phase158-recovery-worker-heartbeat-lease.ts
- **Phase**: 158
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase159-recovery-admission-control.ts
- **Path**: scripts/test-phase159-recovery-admission-control.ts
- **Phase**: 159
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase160-recovery-scheduling-fairness.ts
- **Path**: scripts/test-phase160-recovery-scheduling-fairness.ts
- **Phase**: 160
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase161-recovery-scheduler-capacity.ts
- **Path**: scripts/test-phase161-recovery-scheduler-capacity.ts
- **Phase**: 161
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase162-worker-execution-authority.ts
- **Path**: scripts/test-phase162-worker-execution-authority.ts
- **Phase**: 162
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase163-execution-recovery-handoff.ts
- **Path**: scripts/test-phase163-execution-recovery-handoff.ts
- **Phase**: 163
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase164-execution-outcome-authority.ts
- **Path**: scripts/test-phase164-execution-outcome-authority.ts
- **Phase**: 164
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase165-execution-evidence-provenance.ts
- **Path**: scripts/test-phase165-execution-evidence-provenance.ts
- **Phase**: 165
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase167-audit-provenance-control-plane.ts
- **Path**: scripts/test-phase167-audit-provenance-control-plane.ts
- **Phase**: 167
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/errors, ../src/core/events, ../src/core/execution-audit-provenance-service, ../src/core/execution-models
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase169-project-membership-administration.ts
- **Path**: scripts/test-phase169-project-membership-administration.ts
- **Phase**: 169
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/errors, ../src/core/events, ../src/core/migration-runner, ../src/core/project-membership-service
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase170-project-resource-authorization.ts
- **Path**: scripts/test-phase170-project-resource-authorization.ts
- **Phase**: 170
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/errors, ../src/core/events, ../src/core/migration-runner, ../src/core/project-membership-service
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase171-project-scoped-cicd-release-integrity.ts
- **Path**: scripts/test-phase171-project-scoped-cicd-release-integrity.ts
- **Phase**: 171
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/cicd, ../src/core/devops, ../src/core/errors, ../src/core/events
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase183-final.ts
- **Path**: scripts/test-phase183-final.ts
- **Phase**: 183
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/job-dispatcher, ../src/core/lease-manager, ../src/core/pg-async-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase184-distributed-coordination.ts
- **Path**: scripts/test-phase184-distributed-coordination.ts
- **Phase**: 184
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/lease-manager, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase185-distributed-scheduler.ts
- **Path**: scripts/test-phase185-distributed-scheduler.ts
- **Phase**: 185
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/distributed-scheduler, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase186-distributed-dispatch.ts
- **Path**: scripts/test-phase186-distributed-dispatch.ts
- **Phase**: 186
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/distributed-scheduler, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase187-attempt-lifecycle.ts
- **Path**: scripts/test-phase187-attempt-lifecycle.ts
- **Phase**: 187
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/distributed-scheduler, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase187-attempt-recovery.ts
- **Path**: scripts/test-phase187-attempt-recovery.ts
- **Phase**: 187
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/distributed-scheduler, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase188-attempt-completion.ts
- **Path**: scripts/test-phase188-attempt-completion.ts
- **Phase**: 188
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase189-result-integrity.ts
- **Path**: scripts/test-phase189-result-integrity.ts
- **Phase**: 189
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase190-release-integrity.ts
- **Path**: scripts/test-phase190-release-integrity.ts
- **Phase**: 190
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase192-restart-safety.ts
- **Path**: scripts/test-phase192-restart-safety.ts
- **Phase**: 192
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/cicd-reconciliation.service, ../src/core/ci-reconciliation-ownership.service, better-sqlite3, node:fs, node:os
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase192-scheduler-lifecycle.ts
- **Path**: scripts/test-phase192-scheduler-lifecycle.ts
- **Phase**: 192
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/cicd-reconciliation-scheduler, ../src/core/ci-reconciliation-ownership.service, better-sqlite3, node:fs, node:path
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase193-boot-failure.ts
- **Path**: scripts/test-phase193-boot-failure.ts
- **Phase**: 193
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/audit, ../src/core/db, ../src/core/events, ../src/core/kernel, ../src/core/sqlite-engine
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase193-concurrent-boot.ts
- **Path**: scripts/test-phase193-concurrent-boot.ts
- **Phase**: 193
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/kernel
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase194-concurrent-lease.ts
- **Path**: scripts/test-phase194-concurrent-lease.ts
- **Phase**: 194
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/lease-manager, ../src/core/sqlite-engine, node:child_process, node:fs
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase194-execution-continuity.ts
- **Path**: scripts/test-phase194-execution-continuity.ts
- **Phase**: 194
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/lease-manager, ../src/core/sqlite-engine, node:fs, node:os
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase195-migration-integrity.ts
- **Path**: scripts/test-phase195-migration-integrity.ts
- **Phase**: 195
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/lease-manager, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase196-execution-supervision.ts
- **Path**: scripts/test-phase196-execution-supervision.ts
- **Phase**: 196
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/retry-engine, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase197-stall-recovery.ts
- **Path**: scripts/test-phase197-stall-recovery.ts
- **Phase**: 197
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/retry-engine, ../src/core/sqlite-engine
- **Boots kernel**: True  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase198-ownership.ts
- **Path**: scripts/test-phase198-ownership.ts
- **Phase**: 198
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/pg-bootstrap, ../src/core/pg-client
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase199-recovery-operation-reclaim.ts
- **Path**: scripts/test-phase199-recovery-operation-reclaim.ts
- **Phase**: 199
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-recovery-operation-store, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/pg-async-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase200-recovery-finalization.ts
- **Path**: scripts/test-phase200-recovery-finalization.ts
- **Phase**: 200
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/pg-async-engine, ../src/core/pg-bootstrap
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase201-orchestrator-deps.ts
- **Path**: scripts/test-phase201-orchestrator-deps.ts
- **Phase**: 201
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/lease-manager, ../src/core/migration-runner, ../src/core/sqlite-engine, ../src/core/worker-autonomous-cicd-orchestrator
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase201-stage-dag.ts
- **Path**: scripts/test-phase201-stage-dag.ts
- **Phase**: 201
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/migration-runner, ../src/core/pg-async-engine, ../src/core/pg-bootstrap, ../src/core/pg-client
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase204-execution-lifecycle.ts
- **Path**: scripts/test-phase204-execution-lifecycle.ts
- **Phase**: 204
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-finalizer, ../src/core/execution-store, ../src/core/lease-manager, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase209-verification-integrity.ts
- **Path**: scripts/test-phase209-verification-integrity.ts
- **Phase**: 209
- **Phase artifacts**: artifacts/phase209/, docs/phase209/
- **Imports (first 5)**: ../src/core/verification-evidence, ../src/core/verification-integrity, ../src/core/verification-manifest, node:fs, node:os
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase210-release-safety.ts
- **Path**: scripts/test-phase210-release-safety.ts
- **Phase**: 210
- **Phase artifacts**: artifacts/phase210/, docs/phase210/
- **Imports (first 5)**: ../src/core/release-safety-gate, ../src/core/verification-integrity
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase212-release-recovery.ts
- **Path**: scripts/test-phase212-release-recovery.ts
- **Phase**: 212
- **Phase artifacts**: artifacts/phase212/, docs/phase212/
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/kernel, ../src/core/release-deployment-intent, ../src/core/release-recovery
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase213-lifecycle-integrity.ts
- **Path**: scripts/test-phase213-lifecycle-integrity.ts
- **Phase**: 213
- **Phase artifacts**: artifacts/phase213/
- **Imports (first 5)**: ../src/core/execution-finalizer, ../src/core/kernel, ../src/core/pg-client
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase214-engineering-run.ts
- **Path**: scripts/test-phase214-engineering-run.ts
- **Phase**: 214
- **Phase artifacts**: artifacts/phase214/, docs/phase214/
- **Imports (first 5)**: ../src/core/engineering-capability-registry, ../src/core/engineering-run-service, ../src/core/kernel, ../src/core/pg-client
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase215-planning-architecture.ts
- **Path**: scripts/test-phase215-planning-architecture.ts
- **Phase**: 215
- **Phase artifacts**: artifacts/phase215/, docs/phase215/
- **Imports (first 5)**: ../src/core/artifact-store, ../src/core/engineering-capability-registry, ../src/core/engineering-planning-contracts, ../src/core/engineering-planning-orchestrator, ../src/core/engineering-plan-validator
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase216-ai-provider.ts
- **Path**: scripts/test-phase216-ai-provider.ts
- **Phase**: 216
- **Phase artifacts**: artifacts/phase216/, docs/phase216/
- **Imports (first 5)**: ../src/core/ai-planning-provider, ../src/core/ai-provider-contracts, ../src/core/ai-provider-gateway, ../src/core/ai-provider-openai-compatible, ../src/core/ai-provider-redaction
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase217-external-provider.ts
- **Path**: scripts/test-phase217-external-provider.ts
- **Phase**: 217
- **Phase artifacts**: artifacts/phase217/, docs/phase217/
- **Imports (first 5)**: ../src/core/ai-provider-gateway, ../src/core/ai-provider-openai-compatible, ../src/core/ai-provider-redaction, ../src/core/pg-client
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase217-implementation.ts
- **Path**: scripts/test-phase217-implementation.ts
- **Phase**: 217
- **Phase artifacts**: artifacts/phase217/, docs/phase217/
- **Imports (first 5)**: ../src/core/ai-implementation-provider, ../src/core/ai-provider-contracts, ../src/core/ai-provider-gateway, ../src/core/ai-provider-redaction, ../src/core/artifact-store
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase246-release-review-enforcement.ts
- **Path**: scripts/test-phase246-release-review-enforcement.ts
- **Phase**: 246
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/production-release-decision, ../src/core/production-release-enforcement, ../src/core/security-api, ../src/core/security-release-gate, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase247-boundaries.ts
- **Path**: scripts/test-phase247-boundaries.ts
- **Phase**: 247
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/security-api, ../src/core/security-release-gate, ../src/core/sqlite-engine, node:fs, node:os
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase252-authorization-cas.ts
- **Path**: scripts/test-phase252-authorization-cas.ts
- **Phase**: 252
- **Phase artifacts**: artifacts/phase252/, docs/phase252/
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase264-retry-eligibility.ts
- **Path**: scripts/test-phase264-retry-eligibility.ts
- **Phase**: 264
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-recovery-operation-store, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/pg-async-engine, ../src/core/pg-client
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase265-recovery-reconciliation-integrity.ts
- **Path**: scripts/test-phase265-recovery-reconciliation-integrity.ts
- **Phase**: 265
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-models, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase266-recovery-reconciliation-concurrency.ts
- **Path**: scripts/test-phase266-recovery-reconciliation-concurrency.ts
- **Phase**: 266
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase268-remote-result-integrity.ts
- **Path**: scripts/test-phase268-remote-result-integrity.ts
- **Phase**: 268
- **Phase artifacts**: artifacts/phase268/, docs/phase268/
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, node:crypto
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase269-failure-injection.ts
- **Path**: scripts/test-phase269-failure-injection.ts
- **Phase**: 269
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase269-recovery-observability.ts
- **Path**: scripts/test-phase269-recovery-observability.ts
- **Phase**: 269
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/execution-engine, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/sqlite-engine, better-sqlite3
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase286-worker-gateway-real-handler.ts
- **Path**: scripts/test-phase286-worker-gateway-real-handler.ts
- **Phase**: 286
- **Phase artifacts**: artifacts/phase286/
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/remote-worker-store, ../src/core/sqlite-engine, ../src/core/sqlite-worker-auth-store, ../src/core/worker-authentication
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase290b-worker-gateway-failure-modes.ts
- **Path**: scripts/test-phase290b-worker-gateway-failure-modes.ts
- **Phase**: 290b
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/execution-store, ../src/core/integrity, ../src/core/remote-worker-store, ../src/core/sqlite-engine
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase290-worker-gateway-concurrency.ts
- **Path**: scripts/test-phase290-worker-gateway-concurrency.ts
- **Phase**: 290
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/execution-store, ../src/core/remote-worker-store, ../src/core/sqlite-engine, ../src/core/worker-authentication
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase291-migration-upgrade.ts
- **Path**: scripts/test-phase291-migration-upgrade.ts
- **Phase**: 291
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/migration-runner, better-sqlite3, node:assert/strict, node:fs, node:os
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase291-worker-gateway-recovery-acceptance.ts
- **Path**: scripts/test-phase291-worker-gateway-recovery-acceptance.ts
- **Phase**: 291
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/execution-store, ../src/core/remote-worker-store, ../src/core/sqlite-engine, ../src/core/worker-authentication
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase291-worker-gateway-recovery-safety.ts
- **Path**: scripts/test-phase291-worker-gateway-recovery-safety.ts
- **Phase**: 291
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/execution-store, ../src/core/remote-worker-store, ../src/core/sqlite-engine, ../src/core/worker-authentication
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase293c-persistent-sanitization.ts
- **Path**: scripts/test-phase293c-persistent-sanitization.ts
- **Phase**: 293c
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/ci-artifact-reconciliation.service, ../src/core/cicd-reconciliation.service, ../src/core/db, ../src/core/error-sanitizer, ../src/core/health-agent
- **Boots kernel**: True  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase294-security-integrity.ts
- **Path**: scripts/test-phase294-security-integrity.ts
- **Phase**: 294
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/security-api, ../src/core/security-release-gate, ../src/core/sqlite-engine, ../src/core/types
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase295-security-mapping-integrity.ts
- **Path**: scripts/test-phase295-security-mapping-integrity.ts
- **Phase**: 295
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/security-scan-mapping, ../src/core/security-scanners
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-phase300-sqlite-race.ts
- **Path**: scripts/test-phase300-sqlite-race.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/migration-runner, better-sqlite3, node:crypto, node:fs
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp1-dispatch-persistence.ts
- **Path**: scripts/test-phase300-wp1-dispatch-persistence.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-models, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, node:crypto
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp2-atomic-claiming.ts
- **Path**: scripts/test-phase300-wp2-atomic-claiming.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, node:child_process, node:crypto
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp3-cross-process.ts
- **Path**: scripts/test-phase300-wp3-cross-process.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/pg-client, node:child_process, node:crypto, node:path, node:url
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp4-gateway-routing.ts
- **Path**: scripts/test-phase300-wp4-gateway-routing.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/envelope-hmac-key-provider, ../src/core/execution-store, ../src/core/integrity, ../src/core/pg-async-engine, ../src/core/pg-client
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp5-reconciliation.ts
- **Path**: scripts/test-phase300-wp5-reconciliation.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-adapter, ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-client, ../src/core/remote-execution-adapter
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp5-sqlite-fallback.ts
- **Path**: scripts/test-phase300-wp5-sqlite-fallback.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-adapter, ../src/core/execution-store, ../src/core/migration-runner, ../src/core/remote-execution-adapter, ../src/core/remote-execution-manager
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp6-cancellation-status.ts
- **Path**: scripts/test-phase300-wp6-cancellation-status.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/dispatch-service, ../src/core/execution-adapter, ../src/core/execution-models, ../src/core/execution-store, ../src/core/job-dispatcher
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-phase300-wp8-fresh-bootstrap.ts
- **Path**: scripts/test-phase300-wp8-fresh-bootstrap.ts
- **Phase**: 300
- **Phase artifacts**: artifacts/phase300/
- **Imports (first 5)**: ../src/core/execution-store, ../src/core/pg-async-engine, ../src/core/pg-bootstrap, ../src/core/pg-client, node:crypto
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_PHASE_HAS_ARTIFACTS

### test-security-scan-policy-adapter.ts
- **Path**: scripts/test-security-scan-policy-adapter.ts
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/security-policy.ts, ../src/core/security-scanners.ts
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### test-worker-handler-schema-gate.ts
- **Path**: scripts/test-worker-handler-schema-gate.ts
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: ../src/core/db, ../src/core/sqlite-engine, ../src/core/worker-transport-security, better-sqlite3, node:assert/strict
- **Boots kernel**: False  **Requires env**: False
- **Recommendation**: WIRE_UP_CANDIDATE

### verify-pass5.backup.mjs
- **Path**: scripts/verify-pass5.backup.mjs
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: node:child_process, node:fs, node:os, node:path
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

### verify-pass5.mjs
- **Path**: scripts/verify-pass5.mjs
- **Phase**: (none)
- **Phase artifacts**: (none)
- **Imports (first 5)**: node:child_process, node:fs, node:os, node:path
- **Boots kernel**: False  **Requires env**: True
- **Recommendation**: WIRE_UP_CANDIDATE

## Section 3: BACKUP and DEBUG_SCRATCH (18) - retention review

### apply-phase277.ps1
- **Path**: scripts/apply-phase277.ps1
- **Size**: 21 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: REVIEW_FURTHER

### debug-phase4-pass4.ts
- **Path**: scripts/debug-phase4-pass4.ts
- **Size**: 1846 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: ARCHIVE_REVIEW_REQUIRED

### diagnose-security-detection.ts
- **Path**: scripts/diagnose-security-detection.ts
- **Size**: 1842 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: ARCHIVE_REVIEW_REQUIRED

### diagnose-security-scans.ts
- **Path**: scripts/diagnose-security-scans.ts
- **Size**: 3688 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: ARCHIVE_REVIEW_REQUIRED

### nexus-host-bridge.mjs.before-explicit-cmd-block-20261107-102809.bak
- **Path**: scripts/nexus-host-bridge.mjs.before-explicit-cmd-block-20261107-102809.bak
- **Size**: 33788 bytes
- **Appears to back up**: nexus-host-bridge.mjs.before-explicit-cmd-block-20261107-102809
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### run-host-workspace-materialization-tests.mjs.before-cmd-block-test-20261107-102826.bak
- **Path**: scripts/run-host-workspace-materialization-tests.mjs.before-cmd-block-test-20261107-102826.bak
- **Size**: 22591 bytes
- **Appears to back up**: run-host-workspace-materialization-tests.mjs.before-cmd-block-test-20261107-102826
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### run-safe-regression.ts.before-v3-20261115085329
- **Path**: scripts/run-safe-regression.ts.before-v3-20261115085329
- **Size**: 7415 bytes
- **Appears to back up**: run-safe-regression.ts
- **Original still exists**: True
- **Recommendation**: POSSIBLE_ORIGINAL_EXISTS

### test-phase300-wp5-reconciliation.ts.phase300-wp5-before-corrections.bak
- **Path**: scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-corrections.bak
- **Size**: 18548 bytes
- **Appears to back up**: test-phase300-wp5-reconciliation.ts.phase300-wp5-before-corrections
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### test-phase300-wp5-reconciliation.ts.phase300-wp5-before-race-test.bak
- **Path**: scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-race-test.bak
- **Size**: 17564 bytes
- **Appears to back up**: test-phase300-wp5-reconciliation.ts.phase300-wp5-before-race-test
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### test-phase300-wp5-reconciliation.ts.phase300-wp5-before-retry-test.bak
- **Path**: scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-retry-test.bak
- **Size**: 20097 bytes
- **Appears to back up**: test-phase300-wp5-reconciliation.ts.phase300-wp5-before-retry-test
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### test-phase300-wp5-reconciliation.ts.phase300-wp5-before-terminal-expansion.bak
- **Path**: scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-terminal-expansion.bak
- **Size**: 17097 bytes
- **Appears to back up**: test-phase300-wp5-reconciliation.ts.phase300-wp5-before-terminal-expansion
- **Original still exists**: False
- **Recommendation**: POSSIBLE_ORIGINAL_NOT_FOUND

### verify-pass5-fixed-windows.mjs.before-port-fix
- **Path**: scripts/verify-pass5-fixed-windows.mjs.before-port-fix
- **Size**: 23050 bytes
- **Appears to back up**: verify-pass5-fixed-windows.mjs
- **Original still exists**: True
- **Recommendation**: POSSIBLE_ORIGINAL_EXISTS

### verify-pass5-fixed-windows.mjs.before-stage-logging-20261024-091230
- **Path**: scripts/verify-pass5-fixed-windows.mjs.before-stage-logging-20261024-091230
- **Size**: 23227 bytes
- **Appears to back up**: verify-pass5-fixed-windows.mjs
- **Original still exists**: True
- **Recommendation**: POSSIBLE_ORIGINAL_EXISTS

### verify-phase.ts
- **Path**: scripts/verify-phase.ts
- **Size**: 5247 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: REVIEW_FURTHER

### verify-phase1.mjs
- **Path**: scripts/verify-phase1.mjs
- **Size**: 1836 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: REVIEW_FURTHER

### verify-phase208-evidence.ts
- **Path**: scripts/verify-phase208-evidence.ts
- **Size**: 1700 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: REVIEW_FURTHER

### verify-phase3-rollback.ps1
- **Path**: scripts/verify-phase3-rollback.ps1
- **Size**: 10074 bytes
- **Appears to back up**: (not determinable)
- **Original still exists**: False
- **Recommendation**: REVIEW_FURTHER

### verify-phase3-rollback.ps1.backup
- **Path**: scripts/verify-phase3-rollback.ps1.backup
- **Size**: 11684 bytes
- **Appears to back up**: verify-phase3-rollback.ps1
- **Original still exists**: True
- **Recommendation**: POSSIBLE_ORIGINAL_EXISTS

## Summary

**No file is approved or recommended for deletion or archiving. All 172 entries require human review before any action. Recommendation labels are heuristic triage signals, not verified decisions.**

- UNKNOWN: 42 files
- DORMANT_TEST: 112 files
- BACKUP: 10 files
- DEBUG_SCRATCH: 8 files
- Total: 172 files reviewed
