export type ReleaseHealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "UNKNOWN";

export interface ReleaseHealthSignals {
  availability?: number;
  latency?: number;
  errorRate?: number;
  sloState?: string;
  errorBudgetState?: string;
  reliabilityScore?: number;
  telemetryFresh: boolean;
}

export class WorkerReleaseHealth {
  evaluate(signals: ReleaseHealthSignals): ReleaseHealthState {
    if (!signals.telemetryFresh) return "UNKNOWN";
    if (signals.sloState === "CRITICAL" || signals.errorBudgetState === "CRITICAL" || (signals.reliabilityScore !== undefined && signals.reliabilityScore < 0.3)) return "UNHEALTHY";
    if ((signals.errorRate !== undefined && signals.errorRate > 0.05) || signals.sloState === "BREACHING" || signals.errorBudgetState === "BREACHING") return "DEGRADED";
    return "HEALTHY";
  }
}
