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
  });
}