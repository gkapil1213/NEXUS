export type CanaryState =
  | "HEALTHY"
  | "INSUFFICIENT_SAMPLE"
  | "STALE"
  | "CONFLICTING"
  | "REGRESSION";

export class WorkerCanaryEvaluator {
  evaluate(baselineErrorRate: number, candidateErrorRate: number, sampleCount: number, telemetryFresh: boolean): CanaryState {
    if (!telemetryFresh || !Number.isFinite(baselineErrorRate) || !Number.isFinite(candidateErrorRate)) return "STALE";
    if (sampleCount < 5) return "INSUFFICIENT_SAMPLE";
    const delta = candidateErrorRate - baselineErrorRate;
    if (delta > 0.05) return "REGRESSION";
    if (delta > 0.02) return "CONFLICTING";
    return "HEALTHY";
  }
}
