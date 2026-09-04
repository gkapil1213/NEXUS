import Database from "better-sqlite3";

export type ReliabilityState = "RELIABLE" | "DEGRADED" | "UNRELIABLE" | "UNKNOWN";

export interface ReliabilityEvidence {
  successCount: number;
  failureCount: number;
  recoveryCount: number;
  heartbeatFailures?: number;
  recentDisconnects?: number;
}

export class WorkerReliability {
  constructor(private db: Database.Database) {}

  evaluate(workerId: string, evidence: ReliabilityEvidence): ReliabilityState {
    if (evidence.successCount === 0 && evidence.failureCount === 0 && evidence.recoveryCount === 0) {
      return "UNKNOWN";
    }
    const total = evidence.successCount + evidence.failureCount;
    const failureRate = total === 0 ? 0 : evidence.failureCount / total;
    if (evidence.recoveryCount > 2 || failureRate > 0.5 || (evidence.heartbeatFailures ?? 0) > 3) {
      return "UNRELIABLE";
    }
    if (failureRate > 0.2 || (evidence.recentDisconnects ?? 0) > 1) {
      return "DEGRADED";
    }
    return "RELIABLE";
  }

  persist(workerId: string, state: ReliabilityState, evidence: ReliabilityEvidence): void {
    this.db.prepare(`
      INSERT INTO worker_reliability_assessments (assessment_id, worker_id, reliability_state, evidence, evaluated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `rel_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      workerId,
      state,
      JSON.stringify(evidence),
      Date.now()
    );
  }
}
