// src/server/idempotency.ts
// Phase 179: request-level idempotency store.
//
// Uses the existing SQLite connection the kernel already holds. One new
// table (http_idempotency_keys) created by migration
// 163_phase179_http_idempotency.sql. No second database.
//
// Semantics:
//   lookup(key) -> existing record or undefined
//   store(rec)  -> INSERT OR IGNORE (concurrent safety: first writer wins)
//
// Replay decision lives at the caller (withIdempotency helper in the
// recovery router). This module only persists and reads.

import type Database from "better-sqlite3";

export interface IdempotencyRecord {
  idempotencyKey: string;
  principalId: string;
  method: string;
  path: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  createdAt: number;
}

export class IdempotencyStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS http_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        principal_id    TEXT NOT NULL,
        method          TEXT NOT NULL,
        path            TEXT NOT NULL,
        request_hash    TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body   TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_idem_created
        ON http_idempotency_keys(created_at);
    `);
  }

  lookup(key: string): IdempotencyRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM http_idempotency_keys WHERE idempotency_key = ?")
      .get(key) as
      | {
          idempotency_key: string;
          principal_id: string;
          method: string;
          path: string;
          request_hash: string;
          response_status: number;
          response_body: string;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      principalId: row.principal_id,
      method: row.method,
      path: row.path,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      createdAt: row.created_at,
    };
  }

  store(rec: IdempotencyRecord): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO http_idempotency_keys " +
          "(idempotency_key, principal_id, method, path, request_hash, response_status, response_body, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        rec.idempotencyKey,
        rec.principalId,
        rec.method,
        rec.path,
        rec.requestHash,
        rec.responseStatus,
        rec.responseBody,
        rec.createdAt,
      );
  }
}