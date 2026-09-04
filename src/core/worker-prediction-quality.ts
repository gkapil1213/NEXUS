export type DataQualityState = "FRESH" | "DEGRADED" | "STALE" | "INVALID" | "INSUFFICIENT";

export class WorkerPredictionQuality {
  evaluate(obsTimestamp: number, now: number = Date.now(), sampleCount: number): DataQualityState {
    if (sampleCount < 5) return "INSUFFICIENT";
    const age = now - obsTimestamp;
    if (age < 30000) return "FRESH";
    if (age < 120000) return "DEGRADED";
    return "STALE";
  }
}
