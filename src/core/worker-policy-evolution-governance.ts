export type GovernanceDecision = 'ALLOW' | 'DENY' | 'DEFER';

export interface GovernanceInput {
  tenantId: string;
  policyId: string;
  policyVersion: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  productionFreeze: boolean;
  activeIncident: boolean;
  cooldownSatisfied: boolean;
  blastRadiusAcceptable: boolean;
  dependencyHealthy: boolean;
  staleDecision: boolean;
  staleTelemetry: boolean;
  tenantIsolationValid: boolean;
}

export function governPolicyEvolution(input: GovernanceInput): GovernanceDecision {
  if (!input.tenantIsolationValid) return 'DENY';
  if (input.productionFreeze || input.activeIncident) return 'DENY';
  if (!input.cooldownSatisfied || !input.blastRadiusAcceptable) return 'DENY';
  if (!input.dependencyHealthy) return 'DEFER';
  if (input.staleDecision || input.staleTelemetry) return 'DEFER';
  if (input.riskLevel === 'CRITICAL' || input.riskLevel === 'UNKNOWN') return 'DENY';
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'DEFER';
  if (input.riskLevel === 'HIGH') return 'DEFER'; // require further review
  return 'ALLOW';
}
