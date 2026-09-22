import { NexusEngine, StoreName, SQLStatement } from "./db";
import Database from "better-sqlite3";
import { INDEXES } from "./db";
import { join } from "path";
import { Err } from "./errors";

// Derived from the single source of truth in db.ts so SQLite cannot
// drift from the IndexedDB / memory backends. Assumes each index name
// maps to the same field across every store -- true for INDEXES today.
const FIELD_OF: Record<string, string> = Object.fromEntries(
  Object.values(INDEXES).flat().map(([idx, field]) => [idx, field]),
);
export class SQLiteEngine implements NexusEngine {
  readonly kind = "sqlite" as const;
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Phase 181: production durability pragmas. Applied by both open() (the
   * normal kernel boot path) and fromDatabase() (callers who already hold a
   * better-sqlite3 instance, including every test in the repository). This
   * closes a real gap: before Phase 181, only open() set WAL, so tests and
   * embedders got SQLite defaults.
   */
  private static applyProductionPragmas(db: Database.Database): void {
    // journal_mode = WAL   concurrent readers during writers; crash-safe
    db.pragma("journal_mode = WAL");
    // busy_timeout = 5000  a second writer waits instead of failing instantly
    //                      with SQLITE_BUSY. Without this, run-server + the
    //                      recovery supervisor + any worker contend and lose
    //                      transactions.
    db.pragma("busy_timeout = 5000");
    // foreign_keys = ON    SQLite default is OFF; enforce declared REFERENCES
    db.pragma("foreign_keys = ON");
  }

  static fromDatabase(db: Database.Database): SQLiteEngine {
    SQLiteEngine.applyProductionPragmas(db);
    return new SQLiteEngine(db);
  }
  transaction<T>(fn: () => T): T {
  const tx = this.db.transaction(fn);
  return tx();
  
}

  getDatabase(): Database.Database {
    return this.db;
  }
  static async open(path: string): Promise<SQLiteEngine> {
    const db = new Database(path);
        // Run migrations before engine is ready
        const { MigrationRunner } = await import('./migration-runner');
        const migrationsDir = join(process.cwd(), 'src', 'db', 'migrations');
        const runner = new MigrationRunner(db, migrationsDir);
        runner.run();
    // Phase 181: production durability pragmas.
    //   journal_mode = WAL       concurrent readers during writers; crash-safe
    //   busy_timeout = 5000      a second writer waits up to 5s instead of
    //                            failing instantly with SQLITE_BUSY. Without
    //                            this, any concurrent writer (run-server +
    //                            recovery supervisor + worker) hits BUSY and
    //                            loses the transaction.
    //   foreign_keys = ON        SQLite default is OFF; enable FK enforcement
    //                            for any REFERENCES declared by migrations.
    SQLiteEngine.applyProductionPragmas(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS nexus_records (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (store, key)
      );
    `);
    return new SQLiteEngine(db);
  }

  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO nexus_records (store, key, value) VALUES (?, ?, ?)
       ON CONFLICT(store, key) DO UPDATE SET value = excluded.value`
    );
    stmt.run(store, key, JSON.stringify(value));
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const row = this.db
      .prepare(`SELECT value FROM nexus_records WHERE store = ? AND key = ?`)
      .get(store, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async all<T>(store: StoreName): Promise<T[]> {
    const rows = this.db
      .prepare(`SELECT value FROM nexus_records WHERE store = ? ORDER BY rowid`)
      .all(store) as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  async byIndex<T>(store: StoreName, index: string, key: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const field = FIELD_OF[index];
    if (!field) return [];
    const rows = await this.all<Record<string, unknown>>(store);
    return rows.filter((r) => r[field] === key) as T[];
  }

  async del(store: StoreName, key: string): Promise<void> {
    this.db.prepare(`DELETE FROM nexus_records WHERE store = ? AND key = ?`).run(store, key);
  }

  async clear(store: StoreName): Promise<void> {
    this.db.prepare(`DELETE FROM nexus_records WHERE store = ?`).run(store);
  }

  async maxSeq(store: StoreName): Promise<number> {
    const row = this.db
      .prepare(`SELECT MAX(CAST(json_extract(value, '$.seq') AS INTEGER)) as maxSeq FROM nexus_records WHERE store = ?`)
      .get(store) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? 0;
  }

  stores(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT store FROM nexus_records`).all() as { store: string }[];
    return rows.map((r) => r.store);
  }
  sqlQuery(sql: string, ...params: unknown[]): unknown[] {
    const isSelect = /^\s*(select|pragma|with)\b/i.test(sql);
    const stmt = this.db.prepare(sql);
    if (isSelect) {
      return stmt.all(...params) as unknown[];
    } else {
      stmt.run(...params);
      return [];
    }
  }

  prepare(sql: string): SQLStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => { const result = stmt.run(...params); return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }; },
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    (this.db as Database.Database).close();
  }
}
