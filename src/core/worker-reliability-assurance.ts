export type AssuranceState = "ASSURED" | "DEGRADED_ASSURANCE" | "AT_RISK" | "UNSAFE_AUTONOMY" | "UNKNOWN";

export class WorkerReliabilityAssurance {
  evaluate(healthState: string, recoveryRegression: string, learningDrift: string, telemetryFresh: boolean, consensusValid: boolean): AssuranceState {
    if (!telemetryFresh || !consensusValid) return "UNKNOWN";
    if (recoveryRegression === "RECOVERY_LOOP" || recoveryRegression === "RECOVERY_FAILURE" || healthState === "CRITICAL") return "UNSAFE_AUTONOMY";
    if (healthState === "AT_RISK" || learningDrift === "SIGNIFICANT_DRIFT") return "AT_RISK";
    if (healthState === "DEGRADED" || learningDrift === "DRIFTING") return "DEGRADED_ASSURANCE";
    return "ASSURED";
  }
}
