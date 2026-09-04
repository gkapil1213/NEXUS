import Database from "better-sqlite3";

export type RecoveryVerificationResult = "RECOVERED" | "PARTIALLY_RECOVERED" | "NOT_RECOVERED" | "REGRESSED" | "UNKNOWN";

export class WorkerRecoveryVerification {
  constructor(private db: Database.Database) {}

  verify(recoveryId: string, beforeSli: number, afterSli: number, direction: "increase" | "decrease", sufficientObservations: boolean): RecoveryVerificationResult {
    if (!sufficientObservations || !Number.isFinite(beforeSli) || !Number.isFinite(afterSli)) return "UNKNOWN";
    const delta = afterSli - beforeSli;
    const improved = direction === "increase" ? delta > 0 : delta < 0;
    let result: RecoveryVerificationResult;
    if (improved) result = "RECOVERED";
    else if (delta === 0) result = "PARTIALLY_RECOVERED";
    else result = "REGRESSED";
    this.persist(recoveryId, result);
    return result;
  }

  persist(recoveryId: string, result: RecoveryVerificationResult): void {
    this.db.prepare(`INSERT INTO recovery_verifications (verification_id, recovery_id, state, result, evidence, created_at) VALUES (?, ?, 'COMPLETED', ?, ?, ?)`).run(`ver_${recoveryId}_${Date.now()}`, recoveryId, result, JSON.stringify({}), Date.now());
  }
}
