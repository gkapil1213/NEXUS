import Database from "better-sqlite3";

export type HealingAction = "REBALANCE" | "REDUCE_ADMISSION" | "SCALE_OUT" | "SCALE_IN" | "QUARANTINE" | "RELEASE_RESERVATION" | "RECOVER_JOB" | "ROLLBACK" | "DEFER_OPTIMIZATION";

export class WorkerSelfHealing {
  constructor(private db: Database.Database) {}

  recommend(sloState: string, burnRate: number, workerHealth: string): HealingAction | "NO_ACTION" {
    if (sloState === "CRITICAL" || burnRate > 5) return "ROLLBACK";
    if (sloState === "BREACHING" || burnRate > 3) return "REDUCE_ADMISSION";
    if (workerHealth === "UNHEALTHY") return "QUARANTINE";
    if (burnRate > 1.5) return "REBALANCE";
    return "NO_ACTION";
  }

  initiate(healingId: string, action: HealingAction, target?: string, correlationId?: string): void {
    this.db.prepare(`
      INSERT INTO worker_self_healing_executions (
        healing_id, action, target, state, attempt, result, correlation_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'PENDING', 1, NULL, ?, ?, ?)
    `).run(healingId, action, target, correlationId, Date.now(), Date.now());
  }

  updateState(healingId: string, state: string, result?: string): void {
    this.db.prepare("UPDATE worker_self_healing_executions SET state = ?, result = ?, updated_at = ? WHERE healing_id = ?").run(state, result, Date.now(), healingId);
  }
}
