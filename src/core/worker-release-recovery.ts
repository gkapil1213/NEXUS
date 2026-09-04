import Database from "better-sqlite3";

export type RecoveryState = "ROLLING_BACK" | "RECOVERY_VERIFY" | "ROLLED_BACK" | "FAILED";

export class WorkerReleaseRecovery {
  constructor(private db: Database.Database) {}

  initiate(releaseId: string, rollbackAvailable: boolean, rollbackTargetValid: boolean): RecoveryState {
    if (!rollbackAvailable || !rollbackTargetValid) return "FAILED";
    this.db.prepare(`INSERT INTO release_recovery_verifications (verification_id, release_id, recovery_state, result, evidence, created_at) VALUES (?, ?, 'ROLLING_BACK', NULL, ?, ?)`).run(`rec_${releaseId}_${Date.now()}`, releaseId, JSON.stringify({}), Date.now());
    return "ROLLING_BACK";
  }

  verify(releaseId: string, postHealth: string, sloState: string): "RECOVERED" | "FAILED" {
    if (postHealth === "HEALTHY" && sloState !== "CRITICAL") return "RECOVERED";
    return "FAILED";
  }

  persistVerification(releaseId: string, result: string): void {
    this.db.prepare("UPDATE release_recovery_verifications SET recovery_state = 'COMPLETED', result = ? WHERE release_id = ?").run(result, releaseId);
  }
}
