export type DeploymentGovernanceDecision = 'ALLOW' | 'DENY' | 'REVIEW';

export interface DeploymentGovernanceInput {
  releaseApproved: boolean;
  environmentPolicySatisfied: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approvalRequired: boolean;
  emergencyPolicy: boolean;
}

export function governDeployment(input: DeploymentGovernanceInput): DeploymentGovernanceDecision {
  if (!input.releaseApproved || !input.environmentPolicySatisfied) return 'DENY';
  if (input.riskLevel === 'CRITICAL' && !input.emergencyPolicy) return 'DENY';
  if (input.approvalRequired) return 'REVIEW';
  return 'ALLOW';
}
