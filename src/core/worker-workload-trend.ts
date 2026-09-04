export type WorkloadTrendDirection = "INCREASING" | "DECREASING" | "STABLE" | "BURST" | "SPIKE" | "INSUFFICIENT_DATA";

export interface WorkloadTrendResult {
  direction: WorkloadTrendDirection;
  magnitude: number;
  sampleCount: number;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  reason: string;
}

export class WorkerWorkloadTrend {
  evaluate(current: number, previous: number, sampleCount: number): WorkloadTrendResult {
    if (sampleCount < 3) {
      return { direction: "INSUFFICIENT_DATA", magnitude: 0, sampleCount, confidence: "INSUFFICIENT", reason: "insufficient_samples" };
    }
    const delta = current - previous;
    const magnitude = Math.abs(delta);
    if (magnitude === 0) return { direction: "STABLE", magnitude, sampleCount, confidence: "HIGH", reason: "no_change" };
    if (delta > 20) return { direction: "SPIKE", magnitude: delta, sampleCount, confidence: "MEDIUM", reason: "sudden_increase" };
    if (delta > 0) return { direction: "INCREASING", magnitude: delta, sampleCount, confidence: "HIGH", reason: "positive_growth" };
    if (delta < -20) return { direction: "BURST", magnitude, sampleCount, confidence: "MEDIUM", reason: "sudden_drop" };
    return { direction: "DECREASING", magnitude, sampleCount, confidence: "HIGH", reason: "negative_growth" };
  }
}
