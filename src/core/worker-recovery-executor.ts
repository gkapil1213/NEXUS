import Database from "better-sqlite3";

export class WorkerRecoveryExecutor {
  constructor(private db: Database.Database) {}

  execute(recoveryId: string, idempotencyKey: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO recovery_executions (execution_id, recovery_id, state, result, idempotency_key, evidence, created_at, updated_at)
        VALUES (?, ?, 'EXECUTING', NULL, ?, ?, ?, ?)
      `).run(`exec_${recoveryId}`, recoveryId, idempotencyKey, JSON.stringify({}), Date.now(), Date.now());
      this.db.prepare("UPDATE recovery_executions SET state = 'SUCCEEDED', result = 'executed', updated_at = ? WHERE execution_id = ?").run(Date.now(), `exec_${recoveryId}`);
      return true;
    } catch {
      return false; // duplicate execution
    }
  }
}
