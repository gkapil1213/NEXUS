export type SafetyDecision = 'ALLOW' | 'DENY' | 'DEFER' | 'OBSERVE_ONLY';

export interface SafetyGateInput {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  staleTelemetry: boolean;
  stalePolicy: boolean;
  staleAuthorization: boolean;
  missingRollback: boolean;
  blastRadiusExcessive: boolean;
  activeCriticalIncident: boolean;
  productionFreeze: boolean;
  dependencyFailure: boolean;
  insufficientEvidence: boolean;
  conflictingPolicyState: boolean;
}

export function evaluatePolicyEvolutionSafety(input: SafetyGateInput): SafetyDecision {
  if (input.activeCriticalIncident || input.productionFreeze) return 'DENY';
  if (input.riskLevel === 'CRITICAL' || input.riskLevel === 'UNKNOWN') return 'DENY';
  if (input.staleTelemetry || input.stalePolicy || input.staleAuthorization) return 'DEFER';
  if (input.missingRollback || input.blastRadiusExcessive) return 'DENY';
  if (input.dependencyFailure) return 'DEFER';
  if (input.insufficientEvidence || input.conflictingPolicyState) return 'DEFER';
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'DEFER';
  if (input.riskLevel === 'HIGH') return 'OBSERVE_ONLY';
  return 'ALLOW';
}
