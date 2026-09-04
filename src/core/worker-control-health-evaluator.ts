export type LoopHealthState = "HEALTHY" | "DEGRADED" | "UNSTABLE" | "FAILED";

export class WorkerControlHealthEvaluator {
  evaluate(successRate: number, harmRate: number, rollbackRate: number, oscillationRate: number): LoopHealthState {
    if (harmRate > 0.5 || rollbackRate > 0.5 || oscillationRate > 0.5) return "FAILED";
    if (harmRate > 0.2 || rollbackRate > 0.2 || oscillationRate > 0.2) return "UNSTABLE";
    if (successRate < 0.5) return "DEGRADED";
    return "HEALTHY";
  }
}
