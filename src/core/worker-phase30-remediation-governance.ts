export type GovernanceDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'FREEZE';

export interface GovernanceInput {
  serviceCriticality: string;
  operationRisk: string;
  environment: string;
  protectedWorkload: boolean;
  releaseFreeze: boolean;
  securityPosture: string;
  incidentSeverity: string;
  blastRadius: string;
}

export function governRuntimeAction(input: GovernanceInput): GovernanceDecision {
  if (input.releaseFreeze) return 'FREEZE';
  if (input.protectedWorkload) return 'DENY';
  if (input.incidentSeverity === 'CRITICAL' && input.operationRisk !== 'LOW') return 'DENY';
  if (input.blastRadius === 'CRITICAL' || input.blastRadius === 'HIGH') return 'REQUIRE_APPROVAL';
  return 'ALLOW';
}
