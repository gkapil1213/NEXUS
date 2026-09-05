export type GovernanceDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'DEFER';

export interface RemediationGovernanceInput {
  authorized: boolean;
  environment: string;
  incidentSeverity: string;
  actionRisk: string;
  blastRadius: number;
  confidence: number;
  healthState: string;
  rollbackAvailable: boolean;
  circuitBreakerOpen: boolean;
  frozen: boolean;
  approvalRequired: boolean;
}

export function governRemediation(input: RemediationGovernanceInput): GovernanceDecision {
  if (!input.authorized || input.frozen || input.circuitBreakerOpen) return 'DENY';
  if (input.actionRisk === 'HIGH' && !input.rollbackAvailable) return 'DENY';
  if (input.healthState === 'UNKNOWN') return 'DEFER';
  if (input.approvalRequired) return 'REQUIRE_APPROVAL';
  if (input.blastRadius > 5 || input.actionRisk === 'CRITICAL') return 'REQUIRE_APPROVAL';
  return 'ALLOW';
}
