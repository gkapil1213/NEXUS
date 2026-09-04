export type CrossDomainHealthState = "HEALTHY" | "DEGRADED" | "AT_RISK" | "CRITICAL" | "UNKNOWN";

export class WorkerCrossDomainHealth {
  evaluate(signals: { reliabilityScore?: number; sloState?: string; errorBudgetState?: string; workerHealth?: string; consensusHealth?: string; telemetryFresh: boolean }): CrossDomainHealthState {
    if (!signals.telemetryFresh) return "UNKNOWN";
    if (signals.sloState === "CRITICAL" || signals.errorBudgetState === "CRITICAL" || signals.consensusHealth === "CRITICAL") return "CRITICAL";
    if (signals.sloState === "BREACHING" || signals.workerHealth === "UNHEALTHY" || signals.consensusHealth === "DEGRADED") return "AT_RISK";
    if ((signals.reliabilityScore ?? 1) < 0.5 || signals.sloState === "WARNING") return "DEGRADED";
    return "HEALTHY";
  }
}
