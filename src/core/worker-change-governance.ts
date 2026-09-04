export type GovernanceDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "HOLD";

export interface GovernanceInput {
  riskLevel: string;
  rollbackAvailable: boolean;
  verificationAvailable: boolean;
  capacityAvailable: boolean;
  incidents: number;
  confidence: number;
}

export class WorkerChangeGovernance {
  evaluate(input: GovernanceInput): GovernanceDecision {
    if (input.riskLevel === "CRITICAL" || input.incidents > 0) return "REQUIRE_APPROVAL";
    if (!input.rollbackAvailable || !input.verificationAvailable || !input.capacityAvailable) return "DENY";
    if (input.confidence < 0.5) return "HOLD";
    if (input.riskLevel === "HIGH") return "REQUIRE_APPROVAL";
    return "ALLOW";
  }
}
