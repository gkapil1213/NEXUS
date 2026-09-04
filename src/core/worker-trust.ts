import Database from "better-sqlite3";

export type WorkerTrustState =
  | "UNKNOWN"
  | "ENROLLING"
  | "TRUSTED"
  | "DEGRADED"
  | "SUSPICIOUS"
  | "QUARANTINED"
  | "REVOKED"
  | "RECOVERY_PENDING";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface WorkerTrustRecord {
  workerId: string;
  trustState: WorkerTrustState;
  riskLevel: RiskLevel;
  reason?: string;
  updatedAt: number;
}

export class WorkerTrustStore {
  constructor(private db: Database.Database) {}

  getTrust(workerId: string): WorkerTrustRecord | undefined {
    const row = this.db.prepare("SELECT * FROM worker_trust WHERE worker_id = ?").get(workerId);
    return row ? this.mapTrust(row) : undefined;
  }

  setTrust(record: WorkerTrustRecord): void {
    this.db.prepare(`
      INSERT INTO worker_trust (worker_id, trust_state, risk_level, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        trust_state = excluded.trust_state,
        risk_level = excluded.risk_level,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(
      record.workerId,
      record.trustState,
      record.riskLevel,
      record.reason,
      record.updatedAt
    );
  }

  transitionWorker(workerId: string, newState: WorkerTrustState, riskLevel: RiskLevel = "LOW", reason?: string): void {
    this.setTrust({
      workerId,
      trustState: newState,
      riskLevel,
      reason,
      updatedAt: Date.now(),
    });
  }

  private mapTrust(row: any): WorkerTrustRecord {
    return {
      workerId: row.worker_id,
      trustState: row.trust_state,
      riskLevel: row.risk_level,
      reason: row.reason,
      updatedAt: row.updated_at,
    };
  }
}
