import Database from "better-sqlite3";

export type ResourceOptimizationOutcome = "EFFECTIVE" | "INEFFECTIVE" | "REGRESSION" | "NEUTRAL" | "UNKNOWN";

export class WorkerResourceOptimizationOutcome {
  constructor(private db: Database.Database) {}

  classify(expectedCost: number, actualCost: number, expectedReliability: number, actualReliability: number, telemetryFresh: boolean): ResourceOptimizationOutcome {
    if (!telemetryFresh || !Number.isFinite(expectedCost) || !Number.isFinite(actualCost) || !Number.isFinite(expectedReliability) || !Number.isFinite(actualReliability)) return "UNKNOWN";
    const costDelta = actualCost - expectedCost;
    const relDelta = actualReliability - expectedReliability;
    if (relDelta < -0.05) return "REGRESSION";
    if (costDelta < 0 && relDelta >= 0) return "EFFECTIVE";
    if (costDelta === 0 && relDelta === 0) return "NEUTRAL";
    return "INEFFECTIVE";
  }

  persist(optimizationId: string, actualCost: number, expectedCost: number, actualReliability: number, expectedReliability: number, savingsRealized: number, savingsConfidence: number, classification: ResourceOptimizationOutcome): void {
    this.db.prepare(`
      INSERT INTO resource_optimization_outcomes (
        outcome_id, optimization_id, actual_cost, expected_cost, actual_reliability,
        expected_reliability, savings_realized, savings_confidence, classification,
        evidence, correlation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`outcome_${optimizationId}_${Date.now()}`, optimizationId, actualCost, expectedCost, actualReliability, expectedReliability, savingsRealized, savingsConfidence, classification, JSON.stringify({}), null, Date.now());
  }
}
