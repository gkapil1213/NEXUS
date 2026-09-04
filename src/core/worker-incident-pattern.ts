export type IncidentPatternType =
  | "RECURRING"
  | "ESCALATING"
  | "BURST"
  | "PERIODIC"
  | "CORRELATED"
  | "CONTROL_REGRESSION"
  | "HEALING_REGRESSION"
  | "CAPACITY_RELATED"
  | "FAILURE_DOMAIN_RELATED"
  | "UNKNOWN";

export class WorkerIncidentPattern {
  detect(count: number, trend: "increasing" | "decreasing" | "stable", interval?: number): IncidentPatternType {
    if (interval !== undefined && interval > 0) return "PERIODIC";
    if (count >= 5) return "BURST";
    if (count >= 3 && trend === "increasing") return "ESCALATING";
    if (count >= 3 && trend === "stable") return "RECURRING";
    return "UNKNOWN";
  }
}
