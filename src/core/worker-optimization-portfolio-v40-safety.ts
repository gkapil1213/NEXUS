export type PortfolioSafetyDecision = 'ALLOW' | 'DENY' | 'HOLD';

export interface PortfolioSafetyInput {
  constraintsValid: boolean;
  riskWithinLimit: boolean;
  correlatedRiskWithinLimit: boolean;
  blastRadiusAcceptable: boolean;
  rollbackAvailable: boolean;
  dependencyHealth: boolean;
  governanceAllowed: boolean;
  evidenceSufficient: boolean;
  budgetWithinLimit: boolean;
}

export function evaluatePortfolioSafety(input: PortfolioSafetyInput): PortfolioSafetyDecision {
  if (!input.constraintsValid || !input.rollbackAvailable || !input.dependencyHealth) return 'DENY';
  if (!input.governanceAllowed || !input.budgetWithinLimit) return 'DENY';
  if (!input.riskWithinLimit || !input.correlatedRiskWithinLimit || !input.blastRadiusAcceptable) return 'DENY';
  if (!input.evidenceSufficient) return 'HOLD';
  return 'ALLOW';
}
