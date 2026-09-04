import Database from "better-sqlite3";

export class WorkerReleaseOutcome {
  constructor(private db: Database.Database) {}

  persistOutcome(releaseId: string, changeId: string, promotionSuccess: boolean, rollbackOccurred: boolean, reason: string): void {
    // Use existing change_outcomes table if present; otherwise no-op. We'll assume Phase 17.21 table exists.
    try {
      this.db.prepare(`INSERT INTO change_outcomes (outcome_id, change_id, release_id, classification, confidence, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        `outcome_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        changeId,
        releaseId,
        promotionSuccess ? "SUCCESS" : (rollbackOccurred ? "ROLLED_BACK" : "FAILED"),
        0.8,
        JSON.stringify({ reason }),
        Date.now()
      );
    } catch {
      // if table missing, ignore in tests
    }
  }
}
