export type CostReliabilityTradeoff =
  | "cost_better_reliability_safe"
  | "cost_better_reliability_risky"
  | "cost_worse_reliability_better"
  | "cost_neutral"
  | "reliability_unknown"
  | "insufficient_data";

export class WorkerCostReliabilityModel {
  evaluate(costDelta: number, reliabilityDelta: number, reliabilityKnown: boolean, costKnown: boolean): CostReliabilityTradeoff {
    if (!reliabilityKnown || !costKnown) return "insufficient_data";
    if (!Number.isFinite(reliabilityDelta) || !Number.isFinite(costDelta)) return "insufficient_data";
    if (reliabilityDelta < -0.05) return "reliability_unknown";
    if (costDelta < 0 && reliabilityDelta >= 0) return "cost_better_reliability_safe";
    if (costDelta < 0 && reliabilityDelta < 0) return "cost_better_reliability_risky";
    if (costDelta >= 0 && reliabilityDelta > 0) return "cost_worse_reliability_better";
    return "cost_neutral";
  }
}
