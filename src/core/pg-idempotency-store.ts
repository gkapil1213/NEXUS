// src/core/pg-idempotency-store.ts
import type { PgClient } from "./pg-client";
import type {
  IdempotencyBackend,
  IdempotencyRecord,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
} from "../server/idempotency";

type ClaimRow = {
  idempotency_key: string;
  principal_id: string;
  method: string;
  path: string;
  request_hash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: string | null;
  created_at: number | string;
};

function toRecord(row: {
  idempotency_key: string;
  principal_id: string;
  method: string;
  path: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number | string;
}): IdempotencyRecord {
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

function sameIdentity(
  row: { principalId: string; method: string; path: string; requestHash: string },
  input: IdempotencyClaimInput,
): boolean {
  return row.principalId === input.principalId &&
    row.method === input.method &&
    row.path === input.path &&
    row.requestHash === input.requestHash;
}

export class PgIdempotencyStore implements IdempotencyBackend {
  constructor(private readonly pg: PgClient) {}

  async lookup(key: string): Promise<IdempotencyRecord | undefined> {
    const claim = await this.pg.query<ClaimRow>(
      "SELECT * FROM nexus_idempotency_claims WHERE idempotency_key = $1 AND state = 'COMPLETED'",
      [key],
    );
    if (claim.rows.length > 0) {
      const row = claim.rows[0];
      if (row.response_status === null || row.response_body === null) {
        throw new Error("IDEMPOTENCY_COMPLETED_RECORD_INVALID");
      }
      return toRecord({
        ...row,
        response_status: row.response_status,
        response_body: row.response_body,
      });
    }

    const legacy = await this.pg.query<{
      idempotency_key: string;
      principal_id: string;
      method: string;
      path: string;
      request_hash: string;
      response_status: number;
      response_body: string;
      created_at: number | string;
    }>(
      "SELECT idempotency_key, principal_id, method, path, request_hash, " +
      "response_status, response_body, created_at " +
      "FROM nexus_idempotency_keys WHERE idempotency_key = $1",
      [key],
    );
    return legacy.rows.length ? toRecord(legacy.rows[0]) : undefined;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const existing = await this.lookup(input.idempotencyKey);
    if (existing) {
      return sameIdentity(existing, input)
        ? { status: "COMPLETED", record: existing }
        : { status: "CONFLICT" };
    }

    const inserted = await this.pg.query<{ idempotency_key: string }>(`
      INSERT INTO nexus_idempotency_claims
        (idempotency_key, principal_id, method, path, request_hash, state,
         response_status, response_body, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', NULL, NULL, $6, $6)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `, [
      input.idempotencyKey, input.principalId, input.method,
      input.path, input.requestHash, input.createdAt,
    ]);

    if (inserted.rowCount === 1) return { status: "CLAIMED" };

    const result = await this.pg.query<ClaimRow>(
      "SELECT * FROM nexus_idempotency_claims WHERE idempotency_key = $1",
      [input.idempotencyKey],
    );
    if (result.rows.length !== 1) {
      throw new Error("IDEMPOTENCY_CLAIM_MISSING_AFTER_CONFLICT");
    }

    const row = result.rows[0];
    if (!sameIdentity({
      principalId: row.principal_id,
      method: row.method,
      path: row.path,
      requestHash: row.request_hash,
    }, input)) return { status: "CONFLICT" };

    if (row.state === "COMPLETED") {
      if (row.response_status === null || row.response_body === null) {
        throw new Error("IDEMPOTENCY_COMPLETED_RECORD_INVALID");
      }
      return {
        status: "COMPLETED",
        record: toRecord({
          ...row,
          response_status: row.response_status,
          response_body: row.response_body,
        }),
      };
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
    const result = await this.pg.query(
      `UPDATE nexus_idempotency_claims
       SET state = 'COMPLETED', response_status = $1, response_body = $2, updated_at = $3
       WHERE idempotency_key = $4 AND principal_id = $5 AND method = $6
         AND path = $7 AND request_hash = $8 AND state = 'IN_PROGRESS'`,
      [
        responseStatus, responseBody, Date.now(), input.idempotencyKey,
        input.principalId, input.method, input.path, input.requestHash,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("IDEMPOTENCY_CLAIM_COMPLETION_REJECTED");
    }
  }

  async store(rec: IdempotencyRecord): Promise<void> {
    await this.pg.query(
      "INSERT INTO nexus_idempotency_keys " +
      "(idempotency_key, principal_id, method, path, request_hash, response_status, response_body, created_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING",
      [
        rec.idempotencyKey, rec.principalId, rec.method, rec.path,
        rec.requestHash, rec.responseStatus, rec.responseBody, rec.createdAt,
      ],
    );
  }

  describe(): { backend: "sqlite" | "postgres"; detail: string } {
    return { backend: "postgres", detail: "postgres atomic nexus_idempotency_claims" };
  }
}
