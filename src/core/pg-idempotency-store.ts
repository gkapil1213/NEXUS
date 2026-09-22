// src/core/pg-idempotency-store.ts
// Phase 183: PostgreSQL implementation of the async idempotency backend.
//
// Persists to nexus_idempotency_keys in the shared Postgres database so
// multiple NEXUS instances converge on a single authoritative record for
// the same Idempotency-Key. No fallback to SQLite: the caller selects the
// backend explicitly from the persistence mode.

import type { PgClient } from "./pg-client";
import type { IdempotencyBackend, IdempotencyRecord } from "../server/idempotency";

export class PgIdempotencyStore implements IdempotencyBackend {
  constructor(private readonly pg: PgClient) {}

  async lookup(key: string): Promise<IdempotencyRecord | undefined> {
    const r = await this.pg.query<{
      idempotency_key: string;
      principal_id: string;
      method: string;
      path: string;
      request_hash: string;
      response_status: number;
      response_body: string;
      created_at: string | number;
    }>(
      "SELECT idempotency_key, principal_id, method, path, request_hash, " +
      "response_status, response_body, created_at " +
      "FROM nexus_idempotency_keys WHERE idempotency_key = $1",
      [key],
    );
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    return {
      idempotencyKey: row.idempotency_key,
      principalId: row.principal_id,
      method: row.method,
      path: row.path,
      requestHash: row.request_hash,
      responseStatus: Number(row.response_status),
      responseBody: row.response_body,
      createdAt: Number(row.created_at),
    };
  }

  async store(rec: IdempotencyRecord): Promise<void> {
    await this.pg.query(
      "INSERT INTO nexus_idempotency_keys " +
      "(idempotency_key, principal_id, method, path, request_hash, response_status, response_body, created_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING",
      [
        rec.idempotencyKey,
        rec.principalId,
        rec.method,
        rec.path,
        rec.requestHash,
        rec.responseStatus,
        rec.responseBody,
        rec.createdAt,
      ],
    );
  }

  describe(): { backend: "sqlite" | "postgres"; detail: string } {
    return { backend: "postgres", detail: "postgres nexus_idempotency_keys" };
  }
}