export type DegradationRisk = "NORMAL" | "WATCH" | "ELEVATED" | "HIGH" | "CRITICAL" | "INSUFFICIENT_DATA";

export interface DegradationSignals {
  latencyMs?: number;
  failureRate?: number;
  heartbeatDelayMs?: number;
  resourceUtilization?: number;
  leaseAnomalyCount?: number;
}

export class WorkerDegradationPredictor {
  evaluate(workerId: string, signals: DegradationSignals, sampleCount: number): { risk: DegradationRisk; reasons: string[] } {
    if (sampleCount < 5) return { risk: "INSUFFICIENT_DATA", reasons: ["insufficient_samples"] };
    const reasons: string[] = [];
    if ((signals.failureRate ?? 0) > 0.2) reasons.push("increasing_failure_rate");
    if ((signals.heartbeatDelayMs ?? 0) > 60000) reasons.push("heartbeat_delay");
    if ((signals.resourceUtilization ?? 0) > 0.9) reasons.push("resource_saturation");
    if ((signals.leaseAnomalyCount ?? 0) > 1) reasons.push("lease_anomalies");

    if (reasons.length === 0) return { risk: "NORMAL", reasons: [] };
    if (reasons.length === 1) return { risk: "WATCH", reasons };
    if (reasons.length === 2) return { risk: "ELEVATED", reasons };
    if (reasons.length === 3) return { risk: "HIGH", reasons };
    return { risk: "CRITICAL", reasons };
  }
}
