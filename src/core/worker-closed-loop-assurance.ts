export class WorkerClosedLoopAssurance {
  evaluate(fleetReliability: number, changeImpact: string, outcomeSuccessRate: number, driftState: string, confidence: number): "ASSURED" | "DEGRADED_ASSURANCE" | "AT_RISK" | "UNSAFE" | "UNKNOWN" {
    if (confidence < 0.5 || driftState === "UNKNOWN") return "UNKNOWN";
    if (fleetReliability < 0.3 || driftState === "SIGNIFICANT_DRIFT" || outcomeSuccessRate < 0.3) return "UNSAFE";
    if (fleetReliability < 0.5 || changeImpact === "CRITICAL" || outcomeSuccessRate < 0.5) return "AT_RISK";
    return "ASSURED";
  }
}
