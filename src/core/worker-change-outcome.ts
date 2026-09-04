import Database from "better-sqlite3";

export class WorkerChangeOutcome {
  constructor(private db: Database.Database) {}

  persist(changeId: string, releaseId: string, classification: string, confidence: number): void {
    this.db.prepare(`
      INSERT INTO change_outcomes (outcome_id, change_id, release_id, classification, confidence, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`outcome_${Date.now()}_${Math.random().toString(36).slice(2)}`, changeId, releaseId, classification, confidence, JSON.stringify({}), Date.now());
  }
}
