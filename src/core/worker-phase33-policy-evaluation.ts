export type PolicyDecision = 'ALLOW' | 'ALLOW_WITH_APPROVAL' | 'DENY' | 'FREEZE' | 'ESCALATE' | 'UNAVAILABLE';

export interface PolicyEvaluationInput {
  resourceType: string;
  environment: string;
  criticality: string;
  securityPolicy: string;
  costPolicy: string;
  compliancePolicy: string;
  productionProtection: boolean;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  if (input.productionProtection && input.environment === 'production') return 'ALLOW_WITH_APPROVAL';
  if (input.securityPolicy === 'DENY') return 'DENY';
  if (input.costPolicy === 'FREEZE') return 'FREEZE';
  if (input.compliancePolicy === 'DENY') return 'DENY';
  return 'ALLOW';
}
