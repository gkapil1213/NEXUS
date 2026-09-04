import Database from "better-sqlite3";

export type ControlDecisionStatus =
  | "PROPOSED"
  | "VALIDATING"
  | "APPROVED"
  | "DENIED"
  | "DEFERRED"
  | "AUTHORIZED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "PARTIAL"
  | "ROLLED_BACK"
  | "CANCELLED"
  | "EXPIRED"
  | "BLOCKED"
  | "STALE";

export type AutonomyLevel =
  | "OBSERVE_ONLY"
  | "RECOMMEND"
  | "AUTO_LOW_RISK"
  | "AUTO_MEDIUM_RISK"
  | "HUMAN_APPROVAL_REQUIRED"
  | "EMERGENCY_STOP";

export interface ControlDecision {
  decisionId: string;
  objectiveId?: string;
  actionType: string;
  targetId?: string;
  policyVersion?: number;
  correlationId?: string;
  status: ControlDecisionStatus;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  autonomyLevel: AutonomyLevel;
  reason?: string;
  evidence?: Record<string, any>;
  requestedAt: number;
  expiresAt?: number;
  idempotencyKey: string;
}

export class ControlDecisionStore {
  constructor(private db: Database.Database) {}

  create(decision: ControlDecision): void {
    this.db.prepare(`
      INSERT INTO control_decisions (
        decision_id, objective_id, action_type, target_id, policy_version,
        correlation_id, status, risk_level, autonomy_level, reason, evidence,
        requested_at, expires_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.decisionId,
      decision.objectiveId,
      decision.actionType,
      decision.targetId,
      decision.policyVersion,
      decision.correlationId,
      decision.status,
      decision.riskLevel,
      decision.autonomyLevel,
      decision.reason,
      decision.evidence ? JSON.stringify(decision.evidence) : null,
      decision.requestedAt,
      decision.expiresAt,
      decision.idempotencyKey
    );
  }

  updateStatus(decisionId: string, status: ControlDecisionStatus): void {
    this.db.prepare("UPDATE control_decisions SET status = ? WHERE decision_id = ?").run(status, decisionId);
  }

  get(decisionId: string): ControlDecision | undefined {
    const row = this.db.prepare("SELECT * FROM control_decisions WHERE decision_id = ?").get(decisionId);
    return row ? this.map(row) : undefined;
  }

  getByIdempotencyKey(key: string): ControlDecision | undefined {
    const row = this.db.prepare("SELECT * FROM control_decisions WHERE idempotency_key = ?").get(key);
    return row ? this.map(row) : undefined;
  }

  private map(row: any): ControlDecision {
    return {
      decisionId: row.decision_id,
      objectiveId: row.objective_id,
      actionType: row.action_type,
      targetId: row.target_id,
      policyVersion: row.policy_version,
      correlationId: row.correlation_id,
      status: row.status,
      riskLevel: row.risk_level,
      autonomyLevel: row.autonomy_level,
      reason: row.reason,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      idempotencyKey: row.idempotency_key,
    };
  }
}
