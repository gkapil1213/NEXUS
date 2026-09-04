import Database from "better-sqlite3";

export class WorkerRecoveryPlan {
  constructor(private db: Database.Database) {}

  create(plan: {
    recoveryId: string;
    incidentId: string;
    correlationId?: string;
    strategy: string;
    riskLevel: string;
    blastRadius: string;
    confidence: number;
    idempotencyKey: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO recovery_plans (recovery_id, incident_id, correlation_id, strategy, risk_level, blast_radius, confidence, state, idempotency_key, evidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?)
      `).run(plan.recoveryId, plan.incidentId, plan.correlationId, plan.strategy, plan.riskLevel, plan.blastRadius, plan.confidence, plan.idempotencyKey, JSON.stringify({}), Date.now(), Date.now());
      return true;
    } catch {
      return false;
    }
  }

  get(recoveryId: string): any | undefined {
    return this.db.prepare("SELECT * FROM recovery_plans WHERE recovery_id = ?").get(recoveryId);
  }

  updateState(recoveryId: string, state: string): void {
    this.db.prepare("UPDATE recovery_plans SET state = ?, updated_at = ? WHERE recovery_id = ?").run(state, Date.now(), recoveryId);
  }
}
