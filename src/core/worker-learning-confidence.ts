export class WorkerLearningConfidence {
  evaluate(sampleCount: number, consistency: number, predictionConfidence: number): "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT" {
    if (sampleCount < 5) return "INSUFFICIENT";
    if (predictionConfidence < 0.5) return "LOW";
    if (consistency > 0.8 && predictionConfidence > 0.8) return "HIGH";
    if (consistency > 0.5) return "MEDIUM";
    return "LOW";
  }
}
