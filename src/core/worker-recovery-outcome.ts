import Database from "better-sqlite3";

export type RecoveryOutcomeClassification = "SUCCESS" | "PARTIAL_SUCCESS" | "NO_EFFECT" | "REGRESSION" | "UNKNOWN";

export class WorkerRecoveryOutcome {
  constructor(private db: Database.Database) {}

  classify(beforeSli: number, afterSli: number, direction: "increase" | "decrease", rollbackOccurred: boolean): RecoveryOutcomeClassification {
    if (!Number.isFinite(beforeSli) || !Number.isFinite(afterSli)) return "UNKNOWN";
    if (rollbackOccurred) return "REGRESSION";
    const delta = afterSli - beforeSli;
    const improved = direction === "increase" ? delta > 0 : delta < 0;
    if (improved) return "SUCCESS";
    if (delta === 0) return "NO_EFFECT";
    return "REGRESSION";
  }

  persist(recoveryId: string, classification: RecoveryOutcomeClassification, effectiveness: number): void {
    this.db.prepare(`INSERT INTO recovery_outcomes (outcome_id, recovery_id, classification, effectiveness, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(`out_${recoveryId}_${Date.now()}`, recoveryId, classification, effectiveness, JSON.stringify({}), Date.now());
  }
}
