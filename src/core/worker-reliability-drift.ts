export type ReliabilityDriftState = "STABLE" | "DRIFTING" | "SIGNIFICANT_DRIFT" | "INSUFFICIENT_DATA";

export class WorkerReliabilityDrift {
  evaluate(sampleCount: number, successRateVariance: number): ReliabilityDriftState {
    if (sampleCount < 5) return "INSUFFICIENT_DATA";
    if (successRateVariance > 0.25) return "SIGNIFICANT_DRIFT";
    if (successRateVariance > 0.1) return "DRIFTING";
    return "STABLE";
  }
}
