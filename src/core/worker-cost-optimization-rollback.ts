import Database from "better-sqlite3";

export type OptimizationRollbackDecision = "ROLLBACK_ALLOWED" | "ROLLBACK_BLOCKED" | "ROLLBACK_DEFERRED";

export class WorkerCostOptimizationRollback {
  constructor(private db: Database.Database) {}

  evaluate(rollbackAvailable: boolean, safetyDecision: string, currentState: string): OptimizationRollbackDecision {
    if (!rollbackAvailable || safetyDecision !== "ALLOW") return "ROLLBACK_BLOCKED";
    if (currentState === "CRITICAL") return "ROLLBACK_DEFERRED";
    return "ROLLBACK_ALLOWED";
  }

  request(rollbackId: string, optimizationId: string): boolean {
    try {
      this.db.prepare(`INSERT INTO resource_optimization_rollbacks (rollback_id, optimization_id, status, result, idempotency_key, evidence, created_at) VALUES (?, ?, 'PENDING', NULL, ?, ?, ?)`).run(rollbackId, optimizationId, rollbackId, JSON.stringify({}), Date.now());
      return true;
    } catch { return false; }
  }

  updateStatus(rollbackId: string, status: string): void {
    this.db.prepare("UPDATE resource_optimization_rollbacks SET status = ? WHERE rollback_id = ?").run(status, rollbackId);
  }
}
