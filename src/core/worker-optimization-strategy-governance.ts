export type GovernanceDecision = 'ALLOW' | 'DENY' | 'HOLD' | 'REVIEW';

export interface GovernanceInput {
  productionFreeze: boolean;
  maintenanceWindow: boolean;
  approvalRequired: boolean;
  policyRestriction: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  evidenceRequirementMet: boolean;
  autonomyLevel: 'FULL' | 'GOVERNED' | 'RESTRICTED';
}

export function governStrategy(input: GovernanceInput): GovernanceDecision {
  if (input.productionFreeze || input.policyRestriction) return 'DENY';
  if (input.riskLevel === 'CRITICAL' || input.riskLevel === 'UNKNOWN') return 'DENY';
  if (input.approvalRequired || !input.evidenceRequirementMet) return 'REVIEW';
  if (input.autonomyLevel === 'RESTRICTED' && input.riskLevel !== 'LOW') return 'REVIEW';
  if (input.maintenanceWindow && input.riskLevel !== 'LOW') return 'HOLD';
  return 'ALLOW';
}
