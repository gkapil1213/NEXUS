export type ResilienceState = "RESILIENT" | "DEGRADED" | "AT_RISK" | "CRITICAL";

export interface ResilienceInput {
  unhealthyWorkerPercent: number;
  staleWorkerPercent: number;
  failureRate: number;
  hotspotCount: number;
  queueDepth: number;
}

export class WorkerResiliencePolicy {
  evaluate(input: ResilienceInput): ResilienceState {
    if (input.unhealthyWorkerPercent > 0.5 || input.failureRate > 0.4 || input.hotspotCount > 3) {
      return "CRITICAL";
    }
    if (input.unhealthyWorkerPercent > 0.3 || input.failureRate > 0.25 || input.staleWorkerPercent > 0.3) {
      return "AT_RISK";
    }
    if (input.unhealthyWorkerPercent > 0.1 || input.failureRate > 0.1 || input.queueDepth > 50) {
      return "DEGRADED";
    }
    return "RESILIENT";
  }
}
