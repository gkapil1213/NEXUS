export class WorkerDecisionSafetyGate {
  evaluate(input: {
    governance: string;
    risk: string;
    confidence: string;
    staleState: boolean;
    duplicateAction: boolean;
    cooldownActive: boolean;
    rollbackAvailable: boolean;
    reliability: number;
    headroom: number;
  }): "ALLOW" | "DENY" | "DEFER" | "OBSERVE_ONLY" {
    if (input.governance === "DENY") return "DENY";
    if (input.staleState || input.duplicateAction) return "DENY";
    if (input.risk === "CRITICAL" || input.risk === "UNKNOWN") return "DENY";
    if (input.cooldownActive) return "DEFER";
    if (!input.rollbackAvailable && input.risk === "HIGH") return "DENY";
    if (input.confidence === "LOW" || input.confidence === "UNKNOWN") return "OBSERVE_ONLY";
    if (input.reliability < 0.5 || input.headroom < 0) return "DENY";
    return "ALLOW";
  }
}
