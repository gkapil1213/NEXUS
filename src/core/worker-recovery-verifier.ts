import Database from "better-sqlite3";

export type RecoveryResult = "RECOVERED" | "PARTIALLY_RECOVERED" | "NOT_RECOVERED" | "WORSENED" | "UNKNOWN";

export class WorkerRecoveryVerifier {
  constructor(private db: Database.Database) {}

  verify(healingId: string, beforeSli: number, afterSli: number, requiredDirection: "increase" | "decrease"): RecoveryResult {
    if (!Number.isFinite(beforeSli) || !Number.isFinite(afterSli)) return "UNKNOWN";
    const delta = afterSli - beforeSli;
    const improved = requiredDirection === "increase" ? delta > 0 : delta < 0;
    if (improved) return "RECOVERED";
    if (delta === 0) return "PARTIALLY_RECOVERED";
    return "WORSENED";
  }

  persist(verificationId: string, healingId: string, result: RecoveryResult): void {
    this.db.prepare(`
      INSERT INTO worker_recovery_verifications (
        verification_id, healing_id, state, result, created_at
      ) VALUES (?, ?, 'COMPLETED', ?, ?)
    `).run(verificationId, healingId, result, Date.now());
  }
}
