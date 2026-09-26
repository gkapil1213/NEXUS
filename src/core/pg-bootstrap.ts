// src/core/pg-bootstrap.ts
// Phase 183: apply the shared-backend schema on connect.
//
// Prepares the Postgres coordination tables introduced by Phase 183. Runs
// under a transaction-scoped advisory lock so concurrent NEXUS instances
// starting simultaneously do not race the DDL.

import type { PgClient } from "./pg-client";

export async function bootstrapPgSchema(pg: PgClient): Promise<void> {
  await pg.withTransaction(async (client) => {
    // Deterministic lock key avoids collisions with user-defined locks.
    await client.query("SELECT pg_advisory_xact_lock($1)", [1766873678]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS nexus_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        principal_id    TEXT NOT NULL,
        method          TEXT NOT NULL,
        path            TEXT NOT NULL,
        request_hash    TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body   TEXT NOT NULL,
        created_at      BIGINT NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_nexus_idem_created
        ON nexus_idempotency_keys (created_at)
    `);

    // Phase 183b: authoritative execution job state.
    // Translated from src/db/migrations/020_phase13_execution.sql.
    // INTEGER timestamps -> BIGINT (epoch ms exceeds 32-bit range).
    // cancellation_* stay INTEGER (callers pass 0/1).
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        job_type TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL,
        retry_policy TEXT,
        timeout_ms BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_attempt_at BIGINT,
        next_attempt_at BIGINT,
        current_lease_id TEXT,
        cancellation_requested INTEGER DEFAULT 0,
        cancellation_acknowledged INTEGER DEFAULT 0
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exec_jobs_status
        ON execution_jobs (status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exec_jobs_retry
        ON execution_jobs (status, next_attempt_at)
    `);

    // Phase 185: scheduler priority + admission bookkeeping.
    // ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent -- safe on both
    // fresh databases and existing Phase 183/184 databases.
    //   priority: 0=CRITICAL, 1=HIGH, 2=NORMAL, 3=LOW (matches JobPriority enum)
    //   admitted_at / admission_owner / admission_epoch: durable scheduler ownership
    await client.query(`ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 2`);
    await client.query(`ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS admitted_at BIGINT`);
    await client.query(`ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS admission_owner TEXT`);
    await client.query(`ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS admission_epoch BIGINT DEFAULT 0`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exec_jobs_admissible
        ON execution_jobs (priority, created_at) WHERE status = 'QUEUED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exec_jobs_active_capacity
        ON execution_jobs (status) WHERE status IN ('ADMITTED', 'CLAIMED', 'RUNNING', 'VERIFYING')
    `);


    // Phase 183c: execution_attempts. INTEGER timestamps -> BIGINT.
    // No FOREIGN KEY declaration -- production code enforces the parent
    // relationship at the application layer, same as execution_leases.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT,
        lease_id TEXT,
        started_at BIGINT,
        completed_at BIGINT,
        error TEXT,
        evidence TEXT,
        created_at BIGINT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attempts_job ON execution_attempts (job_id, attempt_number)`);
    // Phase 187: attempt-level heartbeat. Independent of worker last_heartbeat_at
    // so a stuck executor thread on a live worker is still detectable.
    await client.query(`ALTER TABLE execution_attempts ADD COLUMN IF NOT EXISTS heartbeat_at BIGINT`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attempts_stale_running
        ON execution_attempts (status, heartbeat_at) WHERE status = 'RUNNING'
    `);

    // Phase 183b: durable recovery operations.
    // Translated from src/db/migrations/154_phase144_durable_execution_recovery_operations.sql.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_recovery_operations (
        operation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        lease_id TEXT,
        worker_id TEXT,
        operation_type TEXT NOT NULL,
        state TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claim_owner TEXT,
        claim_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        completed_at BIGINT
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ero_idempotency_key
        ON execution_recovery_operations (idempotency_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ero_job_type
        ON execution_recovery_operations (job_id, operation_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ero_state_updated
        ON execution_recovery_operations (state, updated_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ero_claim_expires
        ON execution_recovery_operations (state, claim_expires_at)
    `);

    // Phase 183b: execution_leases -- required by updateJobAsOwnerAsync /
    // transitionExecutionAsync ownership fences. Schema translated from
    // src/db/migrations/020_phase13_execution.sql.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_leases (
        lease_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        acquired_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        renewed_at BIGINT,
        released_at BIGINT,
        status TEXT NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leases_status
        ON execution_leases (status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leases_job
        ON execution_leases (job_id)
    `);
    // Phase 184: enforce invariant I01 -- at most one ACTIVE lease per job.
    // Partial unique index; only ACTIVE rows participate, so historical
    // RELEASED/EXPIRED leases may coexist freely.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_one_active_per_job
        ON execution_leases (job_id) WHERE status = 'ACTIVE'
    `);

    // execution_events -- written inside transition/recovery transactions.
    // Schema translated from src/db/migrations/020_phase13_execution.sql.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT,
        deployment_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at BIGINT NOT NULL
      )
    `);

    // execution_ownership_obligations -- durable ownership-loss record.
    // Schema translated from src/db/migrations/149_phase126_execution_ownership_obligations.sql.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_ownership_obligations (
        obligation_id TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL,
        lease_id      TEXT NOT NULL,
        worker_id     TEXT NOT NULL,
        reason        TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'OPEN',
        created_at    BIGINT NOT NULL,
        resolved_at   BIGINT,
        resolution    TEXT,
        UNIQUE (job_id, lease_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_eoo_open
        ON execution_ownership_obligations (job_id)
        WHERE state = 'OPEN'
    `);

    // Phase 183b: release/deployment intents.
    // 42 columns translated from the post-migration SQLite schema (base
    // migration 146 + all ALTER TABLE additions). INTEGER timestamps ->
    // BIGINT. Nullable fields stay nullable. intent_kind defaults to
    // 'DEPLOY'. recovery_attempts defaults to 0.
    await client.query(`
      CREATE TABLE IF NOT EXISTS release_deployment_intents (
        intent_key TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        environment TEXT NOT NULL,
        image_repository TEXT NOT NULL,
        image_tag TEXT NOT NULL,
        image_id TEXT,
        image_digest TEXT NOT NULL,
        container_name TEXT NOT NULL,
        container_port INTEGER NOT NULL,
        status TEXT NOT NULL,
        deployment_id TEXT,
        failure_reason TEXT,
        recovery_reason TEXT,
        leased_by TEXT,
        lease_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        project_id TEXT,
        intent_kind TEXT DEFAULT 'DEPLOY',
        rollback_target_release_id TEXT,
        rollback_job_id TEXT,
        attempt_id TEXT,
        provider TEXT,
        provider_status TEXT,
        provider_deployment_id TEXT,
        started_at BIGINT,
        completed_at BIGINT,
        timeout_at BIGINT,
        cancel_requested_at BIGINT,
        cancel_acknowledged_at BIGINT,
        verification_state TEXT,
        reconciled_at BIGINT,
        recovery_attempts INTEGER DEFAULT 0,
        next_retry_at BIGINT,
        last_failure_class TEXT,
        reconciliation_evidence TEXT,
        last_recovery_decision TEXT,
        last_recovery_decision_at BIGINT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_status ON release_deployment_intents (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_reconciled ON release_deployment_intents (reconciled_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_next_retry ON release_deployment_intents (next_retry_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_reconcile ON release_deployment_intents (status, reconciled_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_provider_deployment ON release_deployment_intents (provider_deployment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_rollback_job ON release_deployment_intents (rollback_job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_rollback_target ON release_deployment_intents (rollback_target_release_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_kind ON release_deployment_intents (intent_kind)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_release_intents_release_environment ON release_deployment_intents (release_id, environment)`);


    // Phase 183c: execution_workers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_workers (
        worker_id TEXT PRIMARY KEY,
        hostname TEXT,
        capabilities TEXT,
        status TEXT NOT NULL,
        last_heartbeat_at BIGINT,
        current_job_id TEXT,
        registered_at BIGINT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_workers_status ON execution_workers (status)`);

    // Phase 188: execution_artifacts is now a first-class PG table so that
    // artifact publication is transactional with attempt completion.
    // Columns mirror the SQLite base (020) plus 025 integrity additions
    // plus the Phase 188 attempt_id binding.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_artifacts (
        artifact_id TEXT PRIMARY KEY,
        job_id TEXT,
        release_id TEXT,
        attempt_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size_bytes BIGINT,
        checksum TEXT NOT NULL,
        storage_ref TEXT,
        metadata TEXT,
        integrity_verified_at BIGINT,
        integrity_status TEXT DEFAULT 'PENDING',
        immutable INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_artifacts_job ON execution_artifacts (job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON execution_artifacts (attempt_id)`);

    // Phase 183d: execution_outcome_provenance. Written inside the same
    // transaction as completeAttemptAndTransitionJob -- attempt + job +
    // event + provenance commit or roll back together.
    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_outcome_provenance (
        provenance_id          TEXT PRIMARY KEY,
        job_id                 TEXT NOT NULL,
        attempt_id             TEXT NOT NULL,
        attempt_number         INTEGER NOT NULL,
        outcome                TEXT NOT NULL,
        previous_state         TEXT NOT NULL,
        worker_id              TEXT NOT NULL,
        lease_id               TEXT NOT NULL,
        recovery_operation_id  TEXT,
        predecessor_attempt_id TEXT,
        reason                 TEXT,
        evidence_json          TEXT,
        evidence_hash          TEXT NOT NULL,
        terminalized_at        BIGINT NOT NULL,
        created_at             BIGINT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_provenance_job ON execution_outcome_provenance (job_id, attempt_number)`);
  });
}
