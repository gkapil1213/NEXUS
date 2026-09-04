export type ControlHealthState = "HEALTHY" | "DEGRADED" | "UNSTABLE" | "FROZEN" | "EMERGENCY";

export class WorkerControlHealth {
  evaluate(successRate: number, rollbackRate: number, driftState: string, oscillation: boolean): ControlHealthState {
    if (driftState === "CRITICAL" || rollbackRate > 0.5) return "EMERGENCY";
    if (oscillation || rollbackRate > 0.2) return "UNSTABLE";
    if (successRate < 0.5 || driftState === "DEGRADED") return "DEGRADED";
    return "HEALTHY";
  }
}
