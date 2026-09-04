export type FailureRiskLevel = "NORMAL" | "WATCH" | "ELEVATED" | "HIGH" | "CRITICAL" | "INSUFFICIENT_DATA";

export interface FailureSignals {
  failureRate?: number;
  heartbeatFailureCount?: number;
  leaseAnomalyCount?: number;
  recentRecoveries?: number;
}

export class WorkerFailurePrediction {
  evaluate(workerId: string, signals: FailureSignals, sampleCount: number): { level: FailureRiskLevel; reasons: string[] } {
    if (sampleCount < 5) return { level: "INSUFFICIENT_DATA", reasons: ["insufficient_data"] };
    const reasons: string[] = [];
    if ((signals.failureRate ?? 0) > 0.5) reasons.push("high_failure_rate");
    if ((signals.heartbeatFailureCount ?? 0) > 3) reasons.push("heartbeat_failures");
    if ((signals.leaseAnomalyCount ?? 0) > 2) reasons.push("lease_anomalies");
    if ((signals.recentRecoveries ?? 0) > 2) reasons.push("recent_recoveries");
    if (reasons.length === 0) return { level: "NORMAL", reasons: [] };
    if (reasons.length === 1) return { level: "WATCH", reasons };
    if (reasons.length >= 3) return { level: "CRITICAL", reasons };
    // two reasons
    if ((signals.failureRate ?? 0) > 0.5 && (signals.heartbeatFailureCount ?? 0) > 3) {
      return { level: "HIGH", reasons };
    }
    return { level: "ELEVATED", reasons };
  }
}
