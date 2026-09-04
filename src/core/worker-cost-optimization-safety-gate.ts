export type CostOptimizationSafetyDecision = "ALLOW" | "DENY" | "DEFER" | "OBSERVE_ONLY";

export class WorkerCostOptimizationSafetyGate {
  evaluate(input: {
    reliability: number;
    headroom: number;
    rollbackAvailable: boolean;
    confidence: number;
    activeIncidents: number;
    sloState: string;
    governanceAllowed: boolean;
  }): CostOptimizationSafetyDecision {
    if (!input.governanceAllowed) return "DENY";
    if (input.activeIncidents > 0 || input.sloState === "CRITICAL") return "DENY";
    if (!input.rollbackAvailable && input.confidence < 0.8) return "DEFER";
    if (input.reliability < 0.5 || input.headroom < 0) return "DENY";
    if (input.confidence < 0.5) return "OBSERVE_ONLY";
    return "ALLOW";
  }
}
