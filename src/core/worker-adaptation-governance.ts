import Database from "better-sqlite3";

export class WorkerAdaptationGovernance {
  constructor(private db: Database.Database) {}

  freeze(parameterPath: string, reason: string): void {
    this.db.prepare(`
      INSERT INTO worker_learning_drift (drift_id, state, evidence, created_at)
      VALUES (?, 'FROZEN', ?, ?)
    `).run(`drift_${Date.now()}_${Math.random().toString(36).slice(2)}`, JSON.stringify({ parameterPath, reason }), Date.now());
  }

  isFrozen(): boolean {
    const row = this.db.prepare("SELECT 1 FROM worker_learning_drift WHERE state = 'FROZEN' ORDER BY created_at DESC LIMIT 1").get();
    return !!row;
  }
}
