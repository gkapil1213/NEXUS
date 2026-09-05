export type GovernanceDecision = 'ALLOW' | 'DENY' | 'DEFER' | 'REQUIRE_HUMAN_APPROVAL' | 'OBSERVE_ONLY';

export interface PortfolioGovernanceInput {
  tenantId: string;
  portfolioRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  activeIncident: boolean;
  productionFreeze: boolean;
  insufficientEvidence: boolean;
  hardConstraintViolation: boolean;
  resourceOvercommit: boolean;
  dependencyFailure: boolean;
  tenantIsolationValid: boolean;
}

export function governPortfolio(input: PortfolioGovernanceInput): GovernanceDecision {
  if (!input.tenantIsolationValid) return 'DENY';
  if (input.productionFreeze || input.hardConstraintViolation) return 'DENY';
  if (input.activeIncident) return 'OBSERVE_ONLY';
  if (input.portfolioRisk === 'CRITICAL' || input.portfolioRisk === 'UNKNOWN') return 'REQUIRE_HUMAN_APPROVAL';
  if (input.insufficientEvidence || input.dependencyFailure || input.resourceOvercommit) return 'DEFER';
  return 'ALLOW';
}
