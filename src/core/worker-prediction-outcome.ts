import Database from "better-sqlite3";

export class WorkerPredictionOutcome {
  constructor(private db: Database.Database) {}

  recordOutcome(outcome: {
    predictionId: string;
    actualState: string;
    correctness: "CORRECT" | "INCORRECT" | "UNKNOWN";
    errorMagnitude?: number;
    falsePositive?: boolean;
    falseNegative?: boolean;
  }): void {
    this.db.prepare(`
      INSERT INTO worker_prediction_outcomes (
        outcome_id, prediction_id, actual_state, correctness, error_magnitude,
        false_positive, false_negative, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `outcome_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      outcome.predictionId,
      outcome.actualState,
      outcome.correctness,
      outcome.errorMagnitude,
      outcome.falsePositive ? 1 : 0,
      outcome.falseNegative ? 1 : 0,
      Date.now(),
      Date.now()
    );
  }
}
