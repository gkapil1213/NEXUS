export type GovernanceDecision = "ALLOW" | "DENY" | "DEFER" | "OBSERVE";

export interface GovernancePolicy {
  maxCost: number;
  minReliability: number;
  minHeadroom: number;
  rollbackRequired: boolean;
  minConfidence: number;
}

export class WorkerResourceGovernance {
  constructor(private policy: GovernancePolicy) {}

  evaluate(cost: number, reliability: number, headroom: number, rollbackAvailable: boolean, confidence: number): GovernanceDecision {
    if (reliability < this.policy.minReliability) return "DENY";
    if (headroom < this.policy.minHeadroom) return "DENY";
    if (this.policy.rollbackRequired && !rollbackAvailable) return "DENY";
    if (confidence < this.policy.minConfidence) return "DEFER";
    if (cost > this.policy.maxCost) return "OBSERVE";
    return "ALLOW";
  }
}
