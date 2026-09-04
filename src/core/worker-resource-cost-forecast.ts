export type CostTrend = "stable" | "increasing" | "decreasing" | "volatile" | "insufficient_data" | "unknown";

export class WorkerResourceCostForecast {
  evaluate(history: number[], confidence: number): { trend: CostTrend; forecastCost: number; confidence: number } {
    if (!Number.isFinite(confidence) || confidence < 0.5) return { trend: "unknown", forecastCost: 0, confidence };
    const valid = history.filter((v) => Number.isFinite(v) && v >= 0);
    if (valid.length < 3) return { trend: "insufficient_data", forecastCost: 0, confidence };
    const first = valid[0];
    const last = valid[valid.length - 1];
    const delta = last - first;
    const increasing = valid.every((v, i) => i === 0 || v >= valid[i - 1]);
    const decreasing = valid.every((v, i) => i === 0 || v <= valid[i - 1]);
    let trend: CostTrend = "stable";
    if (delta > 0 && increasing) trend = "increasing";
    else if (delta < 0 && decreasing) trend = "decreasing";
    else if (delta !== 0) trend = "volatile";
    const forecastCost = last + delta / Math.max(1, valid.length - 1);
    return { trend, forecastCost, confidence };
  }
}
