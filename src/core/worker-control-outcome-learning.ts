import Database from "better-sqlite3";

export type ControlOutcomeClassification = "SUCCESS" | "PARTIAL_SUCCESS" | "REGRESSION" | "ROLLBACK_SUCCESS" | "ROLLBACK_FAILURE" | "RECOVERED" | "NO_DATA" | "UNKNOWN";

export class WorkerControlOutcomeLearning {
  constructor(private db: Database.Database) {}

  record(outcome: {
    outcomeId: string;
    decisionId: string;
    service: string;
    changeId: string;
    releaseId?: string;
    expectedOutcome: string;
    actualOutcome: string;
    classification: ControlOutcomeClassification;
    confidence: number;
    correlationId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO control_decision_outcomes (outcome_id, decision_id, service, change_id, release_id, expected_outcome, actual_outcome, classification, confidence, evidence, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.outcomeId, outcome.decisionId, outcome.service, outcome.changeId, outcome.releaseId,
      outcome.expectedOutcome, outcome.actualOutcome, outcome.classification, outcome.confidence,
      JSON.stringify({}), outcome.correlationId, Date.now()
    );
  }

  getSuccessRate(strategy: string): number {
    // This is illustrative; actual implementation should aggregate by strategy
    const rows = this.db.prepare("SELECT classification FROM control_decision_outcomes WHERE service = ?").all(strategy) as any[];
    if (rows.length === 0) return 0;
    const success = rows.filter(r => r.classification === "SUCCESS" || r.classification === "RECOVERED").length;
    return success / rows.length;
  }
}
