export type CostRegressionType = "cost_increase" | "unexpected_cost_growth" | "optimization_failure" | "savings_decay" | "reliability_cost_tradeoff_regression" | "NONE";

export class WorkerCostRegression {
  detect(expectedCost: number, actualCost: number, expectedReliability: number, actualReliability: number): CostRegressionType {
    if (!Number.isFinite(expectedCost) || !Number.isFinite(actualCost) || !Number.isFinite(expectedReliability) || !Number.isFinite(actualReliability)) return "NONE";
    if (actualCost > expectedCost * 1.2) return "cost_increase";
    if (actualReliability < expectedReliability - 0.05) return "reliability_cost_tradeoff_regression";
    if (actualReliability < expectedReliability) return "savings_decay";
    return "NONE";
  }
}
