export type GovernanceDecision = 'ALLOW' | 'REVIEW' | 'DENY';

export interface MetaGovernanceInput {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: number;
  largeScaleImpact: boolean;
  repeatedRollback: boolean;
  resourceExceeded: boolean;
  evidenceSufficient: boolean;
  approvalRequired: boolean;
}

export function governMetaExperiment(input: MetaGovernanceInput): GovernanceDecision {
  if (input.resourceExceeded || input.riskLevel === 'CRITICAL' || input.riskLevel === 'UNKNOWN') return 'DENY';
  if (input.approvalRequired || input.largeScaleImpact || input.repeatedRollback || !input.evidenceSufficient || input.confidence < 0.5) return 'REVIEW';
  return 'ALLOW';
}
