export type LearningDriftState = "STABLE" | "MINOR_DRIFT" | "SIGNIFICANT_DRIFT" | "UNKNOWN";

export class WorkerLearningDriftDetector {
  evaluate(sampleCount: number, variance: number): LearningDriftState {
    if (sampleCount < 5) return "UNKNOWN";
    if (variance > 0.3) return "SIGNIFICANT_DRIFT";
    if (variance > 0.1) return "MINOR_DRIFT";
    return "STABLE";
  }
}
