export type PopulationSafetyDecision = 'ALLOW' | 'BLOCK';

export interface PopulationSafetyInput {
  populationHealth: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'STAGNANT' | 'FRAGILE' | 'RECOVERY_REQUIRED';
  diversityScore: number;
  simultaneousRollouts: number;
  maxSimultaneousRollouts: number;
  championConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  correlatedFailures: boolean;
  resourceExhaustion: boolean;
  rollbackUnavailable: boolean;
  governanceViolation: boolean;
  abnormalRegression: boolean;
}

export function evaluatePopulationSafety(input: PopulationSafetyInput): PopulationSafetyDecision {
  if (input.governanceViolation || input.resourceExhaustion || input.rollbackUnavailable) return 'BLOCK';
  if (input.abnormalRegression || input.correlatedFailures) return 'BLOCK';
  if (input.populationHealth === 'FRAGILE' || input.populationHealth === 'RECOVERY_REQUIRED') return 'BLOCK';
  if (input.diversityScore < 0.2) return 'BLOCK';
  if (input.simultaneousRollouts > input.maxSimultaneousRollouts) return 'BLOCK';
  if (input.championConfidence === 'LOW' || input.championConfidence === 'UNKNOWN') return 'BLOCK';
  return 'ALLOW';
}
