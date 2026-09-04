import Database from "better-sqlite3";

export class WorkerControlRollback {
  constructor(private db: Database.Database) {}

  requestRollback(rollback: {
    rollbackId: string;
    actionId: string;
    beforeState: string;
    actualState: string;
    reason: string;
    correlationId?: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO worker_control_rollbacks (
          rollback_id, action_id, before_state, actual_state, rollback_status,
          reason, correlation_id, created_at, idempotency_key
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
      `).run(
        rollback.rollbackId,
        rollback.actionId,
        rollback.beforeState,
        rollback.actualState,
        rollback.reason,
        rollback.correlationId,
        Date.now(),
        rollback.rollbackId
      );
      return true;
    } catch {
      return false; // duplicate rollback
    }
  }

  updateStatus(rollbackId: string, status: string): void {
    this.db.prepare("UPDATE worker_control_rollbacks SET rollback_status = ? WHERE rollback_id = ?").run(status, rollbackId);
  }

  get(rollbackId: string): any | undefined {
    return this.db.prepare("SELECT * FROM worker_control_rollbacks WHERE rollback_id = ?").get(rollbackId);
  }
}
