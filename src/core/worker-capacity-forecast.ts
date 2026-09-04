export type CapacityTrend = "STABLE" | "INCREASING" | "DECREASING" | "VOLATILE" | "UNKNOWN";

export class WorkerCapacityForecast {
  evaluate(history: number[], confidence: number): { trend: CapacityTrend; forecastDemand: number; confidence: number } {
    if (!Number.isFinite(confidence) || confidence < 0.5) return { trend: "UNKNOWN", forecastDemand: 0, confidence };
    const valid = history.filter((v) => Number.isFinite(v));
    if (valid.length < 3) return { trend: "UNKNOWN", forecastDemand: 0, confidence };

    const first = valid[0];
    const last = valid[valid.length - 1];
    const delta = last - first;

    const increasing = valid.every((v, i) => i === 0 || v >= valid[i - 1]);
    const decreasing = valid.every((v, i) => i === 0 || v <= valid[i - 1]);

    let trend: CapacityTrend = "STABLE";
    if (delta > 0 && increasing) trend = "INCREASING";
    else if (delta < 0 && decreasing) trend = "DECREASING";
    else if (delta !== 0) trend = "VOLATILE";

    const forecastDemand = last + delta / Math.max(1, valid.length - 1);
    return { trend, forecastDemand, confidence };
  }
}
