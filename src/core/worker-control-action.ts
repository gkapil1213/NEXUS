import Database from "better-sqlite3";

export type ControlActionType =
  | "SCALE_OUT"
  | "SCALE_IN"
  | "DRAIN_WORKER"
  | "RESUME_WORKER"
  | "REBALANCE_WORK"
  | "REQUEUE_JOB"
  | "PAUSE_SCHEDULING"
  | "RESUME_SCHEDULING"
  | "RECONCILE_CAPACITY"
  | "RECONCILE_LEASE"
  | "RECOVER_JOB";

export type ControlRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ControlActionStatus =
  | "PENDING"
  | "APPROVED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "PARTIAL"
  | "ROLLED_BACK"
  | "CANCELLED"
  | "BLOCKED";

export interface ControlAction {
  actionId: string;
  decisionId: string;
  actionType: ControlActionType;
  targetId?: string;
  status: ControlActionStatus;
  idempotencyKey: string;
  evidence?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export class ControlActionStore {
  constructor(private db: Database.Database) {}

  create(action: ControlAction): void {
    this.db.prepare(`
      INSERT INTO control_actions (action_id, decision_id, action_type, target_id, status, idempotency_key, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.actionId,
      action.decisionId,
      action.actionType,
      action.targetId,
      action.status,
      action.idempotencyKey,
      action.evidence ? JSON.stringify(action.evidence) : null,
      action.createdAt,
      action.updatedAt
    );
  }

  updateStatus(actionId: string, status: ControlActionStatus): void {
    this.db.prepare("UPDATE control_actions SET status = ?, updated_at = ? WHERE action_id = ?").run(status, Date.now(), actionId);
  }

  get(actionId: string): ControlAction | undefined {
    const row = this.db.prepare("SELECT * FROM control_actions WHERE action_id = ?").get(actionId);
    return row ? this.map(row) : undefined;
  }

  getByIdempotencyKey(key: string): ControlAction | undefined {
    const row = this.db.prepare("SELECT * FROM control_actions WHERE idempotency_key = ?").get(key);
    return row ? this.map(row) : undefined;
  }

  private map(row: any): ControlAction {
    return {
      actionId: row.action_id,
      decisionId: row.decision_id,
      actionType: row.action_type,
      targetId: row.target_id,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
