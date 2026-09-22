// src/core/pg-client.ts
// Phase 183: real PostgreSQL client for shared-backend coordination.
//
// One Pool per process. Lifecycle is owned by kernel.boot() / kernel.shutdown().

import { Pool, type PoolClient } from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface PgProbeResult {
  ok: boolean;
  detail: string;
  latencyMs: number | null;
}

export class PgClient {
  private pool: Pool | null = null;
  private lastError: string | null = null;

  async connect(connectionString: string): Promise<void> {
    if (this.pool) return;
    const pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    this.pool = pool;
    this.lastError = null;
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  async probe(): Promise<PgProbeResult> {
    if (!this.pool) return { ok: false, detail: "not connected", latencyMs: null };
    const t0 = Date.now();
    try {
      const r = await this.pool.query("SELECT 1 AS ok");
      const ok = (r.rowCount ?? 0) === 1;
      return { ok, detail: ok ? "SELECT 1 ok" : "unexpected rowCount", latencyMs: Date.now() - t0 };
    } catch (e) {
      this.lastError = (e as Error).message;
      return { ok: false, detail: this.lastError, latencyMs: Date.now() - t0 };
    }
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.pool) throw new Error("PgClient: not connected");
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    if (!this.pool) throw new Error("PgClient: not connected");
    await this.pool.query(sql);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("PgClient: not connected");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const r = await fn(client);
        await client.query("COMMIT");
        return r;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    try { await p.end(); } catch { /* ignore */ }
  }
}

let singleton: PgClient | null = null;
export function getPgClient(): PgClient | null { return singleton; }
export function setPgClient(c: PgClient | null): void { singleton = c; }