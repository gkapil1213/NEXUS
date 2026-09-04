import Database from "better-sqlite3";

export type PreventiveAction =
  | "SCALE_OUT"
  | "REDISTRIBUTE"
  | "RESERVE_CAPACITY"
  | "ADMISSION_REDUCE"
  | "PREPARE_RECOVERY"
  | "ISOLATE_WORKER"
  | "REBALANCE_DOMAIN"
  | "DEFER_OPTIMIZATION";

export class WorkerPreventiveControl {
  constructor(private db: Database.Database) {}

  recommend(reliabilityScore: number, burnRate: number, capacityRisk: string): PreventiveAction | "NO_ACTION" {
    if (reliabilityScore < 0.3 || burnRate > 5) return "PREPARE_RECOVERY";
    if (capacityRisk === "CRITICAL" || capacityRisk === "HIGH") return "SCALE_OUT";
    if (burnRate > 2) return "REDISTRIBUTE";
    if (reliabilityScore < 0.5) return "DEFER_OPTIMIZATION";
    return "NO_ACTION";
  }

  persist(recommendationId: string, type: PreventiveAction, confidence: number, riskLevel: string): void {
    this.db.prepare(`
      INSERT INTO preventive_recommendations (recommendation_id, recommendation_type, confidence, risk_level, state, evidence, created_at)
      VALUES (?, ?, ?, ?, 'RECOMMENDED', ?, ?)
    `).run(recommendationId, type, confidence, riskLevel, JSON.stringify({}), Date.now());
  }
}
