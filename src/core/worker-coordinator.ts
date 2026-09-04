import Database from "better-sqlite3";

export interface CoordinationPlan {
  planId: string;
  correlationId?: string;
  objective: string;
  policyVersion?: number;
  state: "PROPOSED" | "APPROVED" | "EXECUTING" | "COMPLETED" | "FAILED" | "BLOCKED";
  evidence?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string;
}

export class WorkerCoordinator {
  constructor(private db: Database.Database) {}

  createPlan(plan: CoordinationPlan): boolean {
    try {
      this.db.prepare(`
        INSERT INTO worker_coordination_plans (
          plan_id, correlation_id, objective, policy_version, state, evidence,
          created_at, updated_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.planId,
        plan.correlationId,
        plan.objective,
        plan.policyVersion,
        plan.state,
        plan.evidence ? JSON.stringify(plan.evidence) : null,
        plan.createdAt,
        plan.updatedAt,
        plan.idempotencyKey
      );
      return true;
    } catch {
      return false; // duplicate idempotency
    }
  }

  getPlan(planId: string): CoordinationPlan | undefined {
    const row = this.db.prepare("SELECT * FROM worker_coordination_plans WHERE plan_id = ?").get(planId);
    return row ? this.map(row) : undefined;
  }

  updateState(planId: string, state: CoordinationPlan["state"]): void {
    this.db.prepare("UPDATE worker_coordination_plans SET state = ?, updated_at = ? WHERE plan_id = ?").run(state, Date.now(), planId);
  }

  private map(row: any): CoordinationPlan {
    return {
      planId: row.plan_id,
      correlationId: row.correlation_id,
      objective: row.objective,
      policyVersion: row.policy_version,
      state: row.state,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      idempotencyKey: row.idempotency_key,
    };
  }
}
