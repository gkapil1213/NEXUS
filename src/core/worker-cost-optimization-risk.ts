export type CostOptimizationRisk = "low" | "medium" | "high" | "critical" | "unknown";

export class WorkerCostOptimizationRisk {
  evaluate(reliability: number, headroom: number, volatility: number, rollbackAvailable: boolean, confidence: number): CostOptimizationRisk {
    if (!Number.isFinite(reliability) || !Number.isFinite(headroom) || !Number.isFinite(volatility) || confidence < 0.5) return "unknown";
    let score = 0;
    score += (1 - reliability) * 0.5;
    score += headroom < 0 ? 0.3 : 0;
    score += volatility * 0.2;
    if (!rollbackAvailable) score += 0.4;
    score = Math.min(1, score);
    if (score > 0.8) return "critical";
    if (score > 0.5) return "high";
    if (score > 0.15) return "medium";
    return "low";
  }
}
