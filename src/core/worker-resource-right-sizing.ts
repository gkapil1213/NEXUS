export type RightSizingState = "over_provisioned" | "under_provisioned" | "appropriately_sized" | "unstable" | "unknown";

export class WorkerResourceRightSizing {
  evaluate(utilization: number, volatility: number, telemetryFresh: boolean): RightSizingState {
    if (!telemetryFresh || !Number.isFinite(utilization) || !Number.isFinite(volatility)) return "unknown";
    if (volatility > 0.4) return "unstable";
    if (utilization > 0.85) return "under_provisioned";
    if (utilization < 0.4) return "over_provisioned";
    return "appropriately_sized";
  }
}
