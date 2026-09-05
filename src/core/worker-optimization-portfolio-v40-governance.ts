export type PortfolioGovernanceDecision = 'APPROVED' | 'DENIED' | 'REQUIRES_REVIEW';

export interface PortfolioGovernanceInput {
  actionType: string;
  risk: number;
  confidence: number;
  evidenceSufficient: boolean;
  budgetAvailable: boolean;
  affectedPopulations: number;
  policyAllows: boolean;
}

export function governPortfolioAction(input: PortfolioGovernanceInput): PortfolioGovernanceDecision {
  if (!input.policyAllows || !input.budgetAvailable || !input.evidenceSufficient) return 'DENIED';
  if (input.risk > 0.8) return 'DENIED';
  if (input.risk > 0.5 || input.confidence < 0.5 || input.affectedPopulations > 3) return 'REQUIRES_REVIEW';
  return 'APPROVED';
}
