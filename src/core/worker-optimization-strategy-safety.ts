export type SafetyDecision = 'ALLOW' | 'DENY' | 'HOLD';

export interface SafetyInput {
  criticalReliabilityRegression: boolean;
  criticalAvailabilityRegression: boolean;
  excessiveErrorRisk: boolean;
  resourceExhaustion: boolean;
  blastRadiusExcessive: boolean;
  rollbackAvailable: boolean;
  insufficientEvidence: boolean;
  conflictingSafetyControls: boolean;
}

export function evaluateStrategySafety(input: SafetyInput): SafetyDecision {
  if (input.criticalReliabilityRegression || input.criticalAvailabilityRegression) return 'DENY';
  if (input.excessiveErrorRisk || input.resourceExhaustion || input.blastRadiusExcessive) return 'DENY';
  if (!input.rollbackAvailable || input.conflictingSafetyControls) return 'DENY';
  if (input.insufficientEvidence) return 'HOLD';
  return 'ALLOW';
}
