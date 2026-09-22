// src/core/pg-async-engine.ts
// Phase 183b: AsyncNexusEngine over the real PostgreSQL PgClient.
//
// When run inside transactionAsync, a per-transaction sub-engine is created
// that routes every query through the same pool client. This is required for
// atomicity: without it, each prepareAsync(...).run() would acquire a
// different pool client and execute outside the transaction.
//
// Placeholder translation: async methods write `?`; this engine rewrites to
// `$1, $2, ...` via sql-dialect. No other dialect branching.

import { AsyncNexusEngine, AsyncSQLStatement } from "./db";
import type { PgClient } from "./pg-client";
import { toPostgresPlaceholders } from "./sql-dialect";

type TxQueryFn = (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

export class PgAsyncEngine implements AsyncNexusEngine {
  readonly kind = "postgres" as const;

  constructor(
    private readonly client: PgClient,
    private readonly txQuery?: TxQueryFn,
  ) {}

  private async run(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (this.txQuery) return this.txQuery(sql, params);
    const r = await this.client.query<unknown>(sql, params);
    return { rows: r.rows, rowCount: r.rowCount };
  }

  prepareAsync(sql: string): AsyncSQLStatement {
    const pgSql = toPostgresPlaceholders(sql);
    return {
      run: async (...params: unknown[]) => {
        const r = await this.run(pgSql, params);
        return { changes: r.rowCount, lastInsertRowid: 0 };
      },
      get: async <T = unknown>(...params: unknown[]) => {
        const r = await this.run(pgSql, params);
        return r.rows[0] as T | undefined;
      },
      all: async <T = unknown>(...params: unknown[]) => {
        const r = await this.run(pgSql, params);
        return r.rows as T[];
      },
    };
  }

  async execAsync(sql: string): Promise<void> {
    if (this.txQuery) { await this.txQuery(sql, []); return; }
    await this.client.exec(sql);
  }

  async transactionAsync<T>(fn: (tx: AsyncNexusEngine) => Promise<T>): Promise<T> {
    return this.client.withTransaction(async (rawClient) => {
      const txQuery: TxQueryFn = async (sql: string, params: unknown[]) => {
        const r = await rawClient.query(sql, params);
        return { rows: r.rows as unknown[], rowCount: r.rowCount ?? 0 };
      };
      const txEngine = new PgAsyncEngine(this.client, txQuery);
      return fn(txEngine);
    });
  }
}