import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, 'phase9.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply base migrations (016 and 017)
const migrationDir = path.join(process.cwd(), 'src/db/migrations');
const baseMigration = fs.readFileSync(path.join(migrationDir, '016_phase9_reliability.sql'), 'utf8');
db.exec(baseMigration);

// Check and add missing columns from 017 that are not already present
const columns = db.pragma('table_info(reliability_runs)') as any[];
const columnNames = columns.map(c => c.name);

if (!columnNames.includes('summary')) {
  db.exec('ALTER TABLE reliability_runs ADD COLUMN summary TEXT;');
}
if (!columnNames.includes('updated_at')) {
  db.exec('ALTER TABLE reliability_runs ADD COLUMN updated_at TEXT;');
}

// Create additional tables/indexes from 017
const additionalMigration = `
CREATE TABLE IF NOT EXISTS reliability_audit_refs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_reliability_runs_status ON reliability_runs(status);
CREATE INDEX IF NOT EXISTS idx_reliability_runs_created_at ON reliability_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_performance_runs_run_id ON performance_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_load_test_runs_run_id ON load_test_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_stress_test_runs_run_id ON stress_test_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_failure_injections_run_id ON failure_injections(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_recovery_runs_run_id ON recovery_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_slo_evaluations_run_id ON slo_evaluations(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_error_budget_run_id ON error_budget_snapshots(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_performance_regressions_run_id ON performance_regressions(reliability_run_id);
`;
db.exec(additionalMigration);

export { db };
