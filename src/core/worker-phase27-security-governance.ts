export type SecurityGovernanceDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'ESCALATE';

export interface SecurityGovernanceInput {
  risk: string;
  action: string;
  asset: string;
  environment: string;
  blastRadius: number;
  authorized: boolean;
  confidence: number;
  reversibility: boolean;
}

export function evaluateSecurityGovernance(input: SecurityGovernanceInput): SecurityGovernanceDecision {
  if (!input.authorized) return 'DENY';
  if (input.risk === 'CRITICAL' || input.risk === 'UNKNOWN') return 'REQUIRE_APPROVAL';
  if (input.blastRadius > 5) return 'REQUIRE_APPROVAL';
  if (!input.reversibility && input.action.includes('delete')) return 'DENY';
  if (input.confidence < 0.5) return 'ESCALATE';
  return 'ALLOW';
}
