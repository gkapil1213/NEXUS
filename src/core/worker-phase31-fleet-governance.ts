export type FleetGovernanceDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' | 'FREEZE';

export interface FleetGovernanceInput {
  environment: string;
  fleetCriticality: string;
  production: boolean;
  action: string;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  protectedResource: boolean;
  changePolicy: string;
  approvalRequired: boolean;
}

export function governFleetAction(input: FleetGovernanceInput): FleetGovernanceDecision {
  if (input.changePolicy === 'FREEZE') return 'FREEZE';
  if (input.protectedResource) return 'DENY';
  if (input.blastRadius === 'CRITICAL' && !input.approvalRequired) return 'REQUIRE_APPROVAL';
  if (input.risk === 'CRITICAL') return 'REQUIRE_APPROVAL';
  return 'ALLOW';
}
