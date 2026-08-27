import Database from "better-sqlite3";
import { NexusEngine, StoreName } from "./db";
import { Err } from "./errors";

export class SQLiteEngine implements NexusEngine {
  readonly kind = "sqlite" as const;
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async open(path: string): Promise<SQLiteEngine> {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
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
      .prepare(`SELECT value FROM nexus_records WHERE store = ?`)
      .all(store) as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  async byIndex<T>(store: StoreName, index: string, key: IDBValidKey | IDBKeyRange): Promise<T[]> {
    // Generic fallback: not used in minimal SQLite tests
    const rows = await this.all<Record<string, unknown>>(store);
    const fieldMap: Record<string, string> = {
      byProject: "project_id",
      byExecution: "execution_id",
      byArtifact: "artifact_digest",
      byEvidence: "evidence_id",
      byFinding: "finding_id",
      byRelease: "release_id",
    };
    const field = fieldMap[index];
    if (!field) return [];
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

  close(): void {
    this.db.close();
  }
}