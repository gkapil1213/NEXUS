export type CapacityState =
  | "UNDER_CAPACITY"
  | "HEALTHY"
  | "NEAR_SATURATION"
  | "SATURATED"
  | "OVER_CAPACITY"
  | "UNKNOWN";

export class WorkerCapacityIntelligence {
  evaluate(currentCapacity: number, utilizedCapacity: number, telemetryFresh: boolean): CapacityState {
    if (!telemetryFresh || !Number.isFinite(currentCapacity) || !Number.isFinite(utilizedCapacity) || currentCapacity < 0 || utilizedCapacity < 0) {
      return "UNKNOWN";
    }
    if (currentCapacity === 0) return utilizedCapacity === 0 ? "UNKNOWN" : "SATURATED";
    const utilization = utilizedCapacity / currentCapacity;
    if (utilization > 0.95) return "SATURATED";
    if (utilization > 0.85) return "NEAR_SATURATION";
    if (utilization > 0.7) return "HEALTHY";
    if (utilization < 0.4) return "OVER_CAPACITY";
    if (utilization < 0.6) return "UNDER_CAPACITY";
    return "HEALTHY";
  }
}
