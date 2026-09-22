// src/core/pg-async-engine.ts
// Phase 183b: AsyncNexusEngine over the real PostgreSQL PgClient.
//
// This is the async persistence backend for shared mode. It is NOT a
// synchronous engine -- it is the async contract. Callers that need
// PostgreSQL's real concurrency semantics (row locks, SERIALIZABLE,
// conditional UPDATE ... WHERE) write the async methods against this.
//
// Placeholder translation: async methods write `?`; this engine rewrites
// to `$1, $2, ...` via sql-dialect. No other dialect branching.

import { AsyncNexusEngine, AsyncSQLStatement } from "./db";
import type { PgClient } from "./pg-client";
import { toPostgresPlaceholders } from "./sql-dialect";

export class PgAsyncEngine implements AsyncNexusEngine {
  readonly kind = "postgres" as const;

  constructor(private readonly client: PgClient) {}

  prepareAsync(sql: string): AsyncSQLStatement {
    const pgSql = toPostgresPlaceholders(sql);
    const client = this.client;
    return {
      run: async (...params: unknown[]) => {
        const r = await client.query(pgSql, params);
        return { changes: r.rowCount, lastInsertRowid: 0 };
      },
      get: async <T = unknown>(...params: unknown[]) => {
        const r = await client.query<T>(pgSql, params);
        return r.rows[0];
      },
      all: async <T = unknown>(...params: unknown[]) => {
        const r = await client.query<T>(pgSql, params);
        return r.rows;
      },
    };
  }

  async execAsync(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    return this.client.withTransaction(async () => fn());
  }
}