export type DriftState = "STABLE" | "WATCH" | "DEGRADED" | "CRITICAL";

export class WorkerLearningDrift {
  evaluate(failureRate: number, variance: number, successRate: number): DriftState {
    if (failureRate > 0.5 || variance > 0.7) return "CRITICAL";
    if (failureRate > 0.3 || variance > 0.5) return "DEGRADED";
    if (successRate < 0.5 || variance > 0.3) return "WATCH";
    return "STABLE";
  }
}
