import Database from "better-sqlite3";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export interface RiskFactors {
  healthState?: string;
  trustState?: string;
  reliabilityState?: string;
  recentRecoveries?: number;
  heartbeatAgeMs?: number;
  credentialStatus?: string;
}

export class WorkerRisk {
  constructor(private db: Database.Database) {}

  evaluate(workerId: string, factors: RiskFactors): { level: RiskLevel; reasons: string[] } {
    const reasons: string[] = [];
    if (factors.trustState === "REVOKED" || factors.trustState === "QUARANTINED") {
      reasons.push(`trust_state_${factors.trustState}`);
      return { level: "CRITICAL", reasons };
    }
    if (factors.healthState === "UNHEALTHY" || factors.healthState === "STALE") {
      reasons.push(`health_state_${factors.healthState}`);
    }
    if (factors.reliabilityState === "UNRELIABLE") {
      reasons.push("unreliable_worker");
    }
    if ((factors.recentRecoveries ?? 0) > 3) {
      reasons.push("high_recovery_count");
    }
    if ((factors.heartbeatAgeMs ?? 0) > 120000) {
      reasons.push("stale_heartbeat");
    }
    if (factors.credentialStatus && factors.credentialStatus !== "ACTIVE") {
      reasons.push(`credential_${factors.credentialStatus}`);
    }
    if (reasons.length === 0) return { level: "LOW", reasons: [] };
    if (reasons.length === 1) return { level: "MEDIUM", reasons };
    if (reasons.length === 2) return { level: "HIGH", reasons };
    return { level: "CRITICAL", reasons };
  }

  persist(workerId: string, level: RiskLevel, factors: RiskFactors, reasons: string[]): void {
    this.db.prepare(`
      INSERT INTO worker_risk_assessments (assessment_id, worker_id, risk_level, factors, evidence, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `risk_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      workerId,
      level,
      JSON.stringify(factors),
      JSON.stringify(reasons),
      Date.now()
    );
  }
}
