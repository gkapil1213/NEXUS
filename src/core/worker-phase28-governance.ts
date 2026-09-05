export type GovernanceDecision = 'ALLOW' | 'ALLOW_WITH_APPROVAL' | 'DENY' | 'BLOCKED' | 'UNCONFIGURED' | 'UNKNOWN';

export interface InfrastructureGovernanceInput {
  environment: string;
  resourceCriticality: string;
  operationType: string;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  businessImpact: number;
  securityRestriction: boolean;
  deploymentState: string;
  incidentState: string;
  freezeState: boolean;
  approvalRequired: boolean;
  providerCapable: boolean;
  rollbackAvailable: boolean;
}

export function governInfrastructureAction(input: InfrastructureGovernanceInput): GovernanceDecision {
  if (!input.providerCapable) return 'UNCONFIGURED';
  if (input.freezeState) return 'BLOCKED';
  if (input.incidentState === 'CRITICAL' && input.operationType !== 'ROLLBACK') return 'DENY';
  if (input.securityRestriction) return 'DENY';
  if (input.blastRadius === 'CRITICAL' && !input.rollbackAvailable) return 'DENY';
  if (input.approvalRequired) return 'ALLOW_WITH_APPROVAL';
  if (input.blastRadius === 'HIGH' || input.blastRadius === 'CRITICAL') return 'ALLOW_WITH_APPROVAL';
  return 'ALLOW';
}
