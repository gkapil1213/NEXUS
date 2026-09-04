import Database from "better-sqlite3";

export interface ReliabilityScoreInput {
  availability: number;
  latency: number;
  errorRate: number;
  recoveryRate: number;
  healingEffectiveness: number;
  workerHealth: number;
  failureDomainConcentration: number;
  confidence: number;
}

export class WorkerReliabilityScore {
  constructor(private db: Database.Database) {}

  calculate(input: ReliabilityScoreInput): number {
    if (input.confidence < 0.5) return 0;
    const score =
      input.availability * 0.25 +
      (1 - input.errorRate) * 0.2 +
      input.recoveryRate * 0.2 +
      input.healingEffectiveness * 0.15 +
      input.workerHealth * 0.1 +
      (1 - input.failureDomainConcentration) * 0.1;
    return Math.max(0, Math.min(1, score));
  }

  persist(scope: string, score: number, confidence: number, correlationId?: string): void {
    this.db.prepare(`
      INSERT INTO reliability_scores (score_id, scope, score, confidence, evidence, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `rel_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      scope,
      score,
      confidence,
      JSON.stringify({}),
      correlationId,
      Date.now()
    );
  }
}
