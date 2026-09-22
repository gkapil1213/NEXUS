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
  });
}