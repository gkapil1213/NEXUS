export type PredictionConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export class WorkerPredictionConfidence {
  evaluate(sampleCount: number, freshnessMs: number, consistency: number): PredictionConfidence {
    if (sampleCount < 5) return "INSUFFICIENT";
    if (freshnessMs > 120000) return "LOW";
    if (consistency > 0.8) return "HIGH";
    if (consistency > 0.5) return "MEDIUM";
    return "LOW";
  }
}
