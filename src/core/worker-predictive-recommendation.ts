import Database from "better-sqlite3";

export type PredictiveRecommendationType =
  | "SCALE_OUT_NOW"
  | "SCALE_OUT_PREPARE"
  | "REBALANCE"
  | "PROACTIVE_RESERVATION"
  | "PREPARE_RECOVERY"
  | "HOLD";

export class WorkerPredictiveRecommendation {
  constructor(private db: Database.Database) {}

  create(recommendation: {
    recommendationId: string;
    recommendationType: PredictiveRecommendationType;
    targetId?: string;
    riskLevel: string;
    confidence: string;
    policyVersion?: number;
    state: string;
    correlationId?: string;
    evidence?: any;
  }): void {
    this.db.prepare(`
      INSERT INTO worker_predictive_control_recommendations (
        recommendation_id, recommendation_type, target_id, risk_level,
        confidence, policy_version, state, evidence, correlation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recommendation.recommendationId,
      recommendation.recommendationType,
      recommendation.targetId,
      recommendation.riskLevel,
      recommendation.confidence,
      recommendation.policyVersion,
      recommendation.state,
      recommendation.evidence ? JSON.stringify(recommendation.evidence) : null,
      recommendation.correlationId,
      Date.now()
    );
  }

  get(recommendationId: string): any | undefined {
    return this.db.prepare("SELECT * FROM worker_predictive_control_recommendations WHERE recommendation_id = ?").get(recommendationId);
  }
}
