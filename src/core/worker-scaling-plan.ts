import Database from "better-sqlite3";
import { ScalingStrategy } from "./worker-scaling-strategy";
import { ScalingRisk } from "./worker-scaling-risk";
import { ScalingSafetyDecision } from "./worker-scaling-safety-gate";

export interface ScalingPlanInput {
  planId: string;
  targetId: string;
  currentCapacity: number;
  targetCapacity: number;
  delta: number;
  strategy: ScalingStrategy;
  risk: ScalingRisk;
  confidence: number;
  safetyDecision: ScalingSafetyDecision;
  correlationId?: string;
  expiresAt: number;
}

export class WorkerScalingPlan {
  constructor(private db: Database.Database) {}

  create(input: ScalingPlanInput): boolean {
    try {
      this.db.prepare(`
        INSERT INTO scaling_plans (
          plan_id, target_id, current_capacity, target_capacity, delta,
          strategy, risk_level, confidence, safety_decision, status,
          idempotency_key, evidence, correlation_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)
      `).run(
        input.planId, input.targetId, input.currentCapacity, input.targetCapacity, input.delta,
        input.strategy, input.risk, input.confidence, input.safetyDecision,
        input.planId, JSON.stringify({}), input.correlationId, Date.now(), input.expiresAt
      );
      return true;
    } catch {
      return false;
    }
  }

  get(planId: string): any | undefined {
    return this.db.prepare("SELECT * FROM scaling_plans WHERE plan_id = ?").get(planId);
  }

  updateStatus(planId: string, status: string): void {
    this.db.prepare("UPDATE scaling_plans SET status = ? WHERE plan_id = ?").run(status, planId);
  }
}
