export type ResourceOptimizationStrategy =
  | "scale_up"
  | "scale_down"
  | "right_size"
  | "hold"
  | "defer"
  | "observe"
  | "rebalance"
  | "reduce_idle_capacity"
  | "increase_headroom"
  | "rollback";

export class WorkerResourceOptimizationStrategy {
  select(costTradeoff: string, risk: string, reliability: number, headroom: number): ResourceOptimizationStrategy {
    if (risk === "critical" || reliability < 0.5 || headroom < 0) return "hold";
    if (costTradeoff === "cost_better_reliability_risky") return "defer";
    if (costTradeoff === "cost_better_reliability_safe" && headroom > 0.2) return "right_size";
    if (costTradeoff === "cost_worse_reliability_better") return "increase_headroom";
    if (risk === "high") return "observe";
    return "hold";
  }
}
