export type ContinuousVerificationState =
  | "HEALTHY"
  | "DEGRADED"
  | "REGRESSION"
  | "CRITICAL"
  | "INSUFFICIENT_DATA"
  | "UNKNOWN";

export interface VerificationSignals {
  availability?: number;
  latency?: number;
  errorRate?: number;
  sloState?: string;
  reliabilityScore?: number;
  telemetryFresh: boolean;
  sampleCount?: number;
}

export class WorkerContinuousVerification {
  evaluate(signals: VerificationSignals): ContinuousVerificationState {
    if (!signals.telemetryFresh) return "STALE" as ContinuousVerificationState;
    if ((signals.sampleCount ?? 0) < 5) return "INSUFFICIENT_DATA";
    if (signals.sloState === "CRITICAL" || (signals.errorRate !== undefined && signals.errorRate > 0.1)) return "CRITICAL";
    if (signals.sloState === "BREACHING" || (signals.errorRate !== undefined && signals.errorRate > 0.05)) return "REGRESSION";
    if ((signals.reliabilityScore !== undefined && signals.reliabilityScore < 0.5) || signals.sloState === "WARNING") return "DEGRADED";
    return "HEALTHY";
  }
}
