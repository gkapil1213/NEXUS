import Database from "better-sqlite3";

export interface ResourceOptimizationPlanInput {
  optimizationId: string;
  resourceId: string;
  currentState: string;
  targetState: string;
  candidateAction: string;
  expectedCost: number;
  expectedSavings: number;
  expectedReliabilityImpact: number;
  expectedPerformanceImpact: number;
  riskLevel: string;
  confidence: number;
  blastRadius: string;
  rollbackAvailable: boolean;
  safetyDecision: string;
  policyVersion: number;
  correlationId?: string;
}

export class WorkerResourceOptimizationPlan {
  constructor(private db: Database.Database) {}

  create(input: ResourceOptimizationPlanInput): boolean {
    try {
      this.db.prepare(`
        INSERT INTO resource_optimization_plans (
          optimization_id, resource_id, current_state, target_state, candidate_action,
          expected_cost, expected_savings, expected_reliability_impact, expected_performance_impact,
          risk_level, confidence, blast_radius, rollback_available, safety_decision,
          status, policy_version, idempotency_key, evidence, correlation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)
      `).run(
        input.optimizationId,
        input.resourceId,
        input.currentState,
        input.targetState,
        input.candidateAction,
        input.expectedCost,
        input.expectedSavings,
        input.expectedReliabilityImpact,
        input.expectedPerformanceImpact,
        input.riskLevel,
        input.confidence,
        input.blastRadius,
        input.rollbackAvailable ? 1 : 0,
        input.safetyDecision,
        input.policyVersion,
        input.optimizationId,
        JSON.stringify({}),
        input.correlationId,
        Date.now()
      );
      return true;
    } catch {
      return false;
    }
  }

  get(optimizationId: string): any | undefined {
    return this.db.prepare("SELECT * FROM resource_optimization_plans WHERE optimization_id = ?").get(optimizationId);
  }

  updateStatus(optimizationId: string, status: string): void {
    this.db.prepare("UPDATE resource_optimization_plans SET status = ? WHERE optimization_id = ?").run(status, optimizationId);
  }
}
