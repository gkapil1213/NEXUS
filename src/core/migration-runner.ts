import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

export interface MigrationRecord {
    id: string;
    filename: string;
    checksum: string;
    applied_at: string;
}

export class MigrationRunner {
    private db: Database.Database;
    private migrationsDir: string;
    private tableName: string = 'nexus_schema_migrations';

    constructor(db: Database.Database, migrationsDir: string) {
        this.db = db;
        this.migrationsDir = migrationsDir;
        this.ensureHistoryTable();
    }

    private ensureHistoryTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
        `);
    }

    private getMigrations(): { filename: string; id: string; sql: string; checksum: string }[] {
        const files = readdirSync(this.migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort(); // deterministic lexicographic order

        const migrations = [];
        const seenIds = new Set<string>();
        for (const filename of files) {
            const sql = readFileSync(join(this.migrationsDir, filename), 'utf8');
            const checksum = createHash('sha256').update(sql).digest('hex');
            const id = filename.replace(/\.sql$/, '');
            if (seenIds.has(id)) {
                throw new Error(`Duplicate migration filename ${filename}`);
            }
            seenIds.add(id);
            migrations.push({ filename, id, sql, checksum });
        }
        return migrations;
    }

    public run(): void {
        const migrations = this.getMigrations();
        for (const mig of migrations) {
            const existing = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(mig.id) as MigrationRecord | undefined;
            if (existing) {
                if (existing.checksum !== mig.checksum) {
                    throw new Error(`Checksum mismatch for migration ${mig.filename}`);
                }
                continue;
            }
            const hasExplicitTransaction = /^\s*BEGIN\b/im.test(mig.sql);
            const insertHistory = () => {
                this.db.prepare(`INSERT OR IGNORE INTO ${this.tableName} (id, filename, checksum, applied_at) VALUES (?, ?, ?, ?)`).run(
                    mig.id,
                    mig.filename,
                    mig.checksum,
                    new Date().toISOString()
                );
            };
            if (hasExplicitTransaction) {
                // Execute as-is; the migration file manages its own transaction.
                this.db.exec(mig.sql);
                insertHistory();
            } else {
                const apply = this.db.transaction(() => {
                    // Phase 182: BEGIN IMMEDIATE + in-transaction recheck.
                    //
                    // The previous deferred transaction read the history under a snapshot
                    // and only upgraded to a write lock at the first DDL statement. Two
                    // processes could both observe an empty history, then the first
                    // committed; the second's upgrade saw a stale snapshot and SQLite
                    // returned SQLITE_BUSY_SNAPSHOT immediately (busy_timeout does not
                    // retry it -- that would risk deadlock). The loser threw.
                    //
                    // IMMEDIATE acquires the write lock at BEGIN, so concurrent runners
                    // serialize. The winner applies; the losers' recheck inside the
                    // transaction sees the committed history row and skips.
                    const recheck = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(mig.id) as MigrationRecord | undefined;
                    if (recheck) {
                        if (recheck.checksum !== mig.checksum) {
                            throw new Error(`Checksum mismatch for migration ${mig.filename}`);
                        }
                        return;
                    }
                    this.db.exec(mig.sql);
                    insertHistory();
                });
                apply.immediate();
            }
        }
    }

    public verifyIntegrity(): void {
        const migrations = this.getMigrations();
        for (const mig of migrations) {
            const existing = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(mig.id) as MigrationRecord | undefined;
            if (existing && existing.checksum !== mig.checksum) {
                throw new Error(`Checksum mismatch for applied migration ${mig.filename}`);
            }
        }
    }

    public getAppliedMigrations(): MigrationRecord[] {
        return this.db.prepare(`SELECT * FROM ${this.tableName} ORDER BY id`).all() as MigrationRecord[];
    }
}
