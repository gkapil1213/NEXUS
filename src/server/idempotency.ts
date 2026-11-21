// src/server/idempotency.ts
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

export interface IdempotencyClaimInput {
  idempotencyKey: string;
  principalId: string;
  method: string;
  path: string;
  requestHash: string;
  createdAt: number;
}

export type IdempotencyClaimResult =
  | { status: "CLAIMED" }
  | { status: "IN_PROGRESS" }
  | { status: "COMPLETED"; record: IdempotencyRecord }
  | { status: "CONFLICT" };

export interface IdempotencyBackend {
  lookup(key: string): Promise<IdempotencyRecord | undefined>;
  store(rec: IdempotencyRecord): Promise<void>;
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  complete(input: IdempotencyClaimInput, responseStatus: number, responseBody: string): Promise<void>;
  describe(): { backend: "sqlite" | "postgres"; detail: string };
}

type ClaimRow = {
  idempotency_key: string;
  principal_id: string;
  method: string;
  path: string;
  request_hash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: string | null;
  created_at: number;
};

function toRecord(row: {
  idempotency_key: string;
  principal_id: string;
  method: string;
  path: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
}): IdempotencyRecord {
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

function sameIdentity(
  row: Pick<IdempotencyRecord, "principalId" | "method" | "path" | "requestHash">,
  input: IdempotencyClaimInput,
): boolean {
  return row.principalId === input.principalId &&
    row.method === input.method &&
    row.path === input.path &&
    row.requestHash === input.requestHash;
}

export class IdempotencyStore implements IdempotencyBackend {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS http_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_idem_created
        ON http_idempotency_keys(created_at);
      CREATE TABLE IF NOT EXISTS http_idempotency_claims (
        idempotency_key TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
        response_status INTEGER,
        response_body TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'IN_PROGRESS' AND response_status IS NULL AND response_body IS NULL)
          OR
          (state = 'COMPLETED' AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_http_idem_claims_created
        ON http_idempotency_claims(created_at);
    `);
  }

  async lookup(key: string): Promise<IdempotencyRecord | undefined> {
    const claim = this.db.prepare(
      "SELECT * FROM http_idempotency_claims WHERE idempotency_key = ? AND state = 'COMPLETED'",
    ).get(key) as (ClaimRow & { response_status: number; response_body: string }) | undefined;
    if (claim) return toRecord(claim);

    const row = this.db.prepare(
      "SELECT * FROM http_idempotency_keys WHERE idempotency_key = ?",
    ).get(key) as {
      idempotency_key: string; principal_id: string; method: string; path: string;
      request_hash: string; response_status: number; response_body: string; created_at: number;
    } | undefined;
    return row ? toRecord(row) : undefined;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const legacy = await this.lookup(input.idempotencyKey);
    if (legacy) return sameIdentity(legacy, input)
      ? { status: "COMPLETED", record: legacy }
      : { status: "CONFLICT" };

    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO http_idempotency_claims
        (idempotency_key, principal_id, method, path, request_hash, state,
         response_status, response_body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', NULL, NULL, ?, ?)
    `).run(
      input.idempotencyKey, input.principalId, input.method, input.path,
      input.requestHash, input.createdAt, input.createdAt,
    );

    if (inserted.changes === 1) return { status: "CLAIMED" };

    const row = this.db.prepare(
      "SELECT * FROM http_idempotency_claims WHERE idempotency_key = ?",
    ).get(input.idempotencyKey) as ClaimRow | undefined;
    if (!row) throw new Error("IDEMPOTENCY_CLAIM_MISSING_AFTER_CONFLICT");
    if (!sameIdentity({
      principalId: row.principal_id, method: row.method, path: row.path, requestHash: row.request_hash,
    } as IdempotencyRecord, input)) return { status: "CONFLICT" };

    if (row.state === "COMPLETED") {
      if (row.response_status === null || row.response_body === null) {
        throw new Error("IDEMPOTENCY_COMPLETED_RECORD_INVALID");
      }
      return { status: "COMPLETED", record: toRecord({
        ...row, response_status: row.response_status, response_body: row.response_body,
      }) };
    }
    return { status: "IN_PROGRESS" };
  }

  async complete(
    input: IdempotencyClaimInput,
    responseStatus: number,
    responseBody: string,
  ): Promise<void> {
    if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus >= 300) {
      throw new Error("IDEMPOTENCY_COMPLETION_STATUS_INVALID");
    }
    const result = this.db.prepare(`
      UPDATE http_idempotency_claims
      SET state = 'COMPLETED', response_status = ?, response_body = ?, updated_at = ?
      WHERE idempotency_key = ? AND principal_id = ? AND method = ? AND path = ?
        AND request_hash = ? AND state = 'IN_PROGRESS'
    `).run(
      responseStatus, responseBody, Date.now(), input.idempotencyKey,
      input.principalId, input.method, input.path, input.requestHash,
    );
    if (result.changes !== 1) throw new Error("IDEMPOTENCY_CLAIM_COMPLETION_REJECTED");
  }

  async store(rec: IdempotencyRecord): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO http_idempotency_keys
        (idempotency_key, principal_id, method, path, request_hash,
         response_status, response_body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.idempotencyKey, rec.principalId, rec.method, rec.path,
      rec.requestHash, rec.responseStatus, rec.responseBody, rec.createdAt,
    );
  }

  describe(): { backend: "sqlite" | "postgres"; detail: string } {
    return { backend: "sqlite", detail: "better-sqlite3 atomic http_idempotency_claims" };
  }
}
