export type GovernanceDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

export interface RecoveryGovernanceInput {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approved: boolean;
  emergency: boolean;
}

export function governRecovery(input: RecoveryGovernanceInput): GovernanceDecision {
  if (input.riskLevel === 'CRITICAL' && !input.emergency) return 'DENY';
  if (input.riskLevel === 'HIGH' && !input.approved) return 'REQUIRES_APPROVAL';
  if (!input.approved && !input.emergency) return 'REQUIRES_APPROVAL';
  return 'ALLOW';
}
