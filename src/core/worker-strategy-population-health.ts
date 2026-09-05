export type PopulationHealth = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'STAGNANT' | 'FRAGILE' | 'RECOVERY_REQUIRED';

export interface PopulationHealthInput {
  diversityScore: number;
  convergenceScore: number;
  stagnationScore: number;
  failureConcentration: number;
  regressionConcentration: number;
  resourcePressure: number;
  confidenceQuality: number; // 0-1
}

export function evaluatePopulationHealth(input: PopulationHealthInput): PopulationHealth {
  if (input.resourcePressure > 0.9 || input.regressionConcentration > 0.8) return 'RECOVERY_REQUIRED';
  if (input.stagnationScore > 0.7) return 'STAGNANT';
  if (input.failureConcentration > 0.7 || input.diversityScore < 0.3) return 'FRAGILE';
  if (input.convergenceScore > 0.7 && input.stagnationScore > 0.3) return 'DEGRADED';
  if (input.resourcePressure > 0.6 || input.regressionConcentration > 0.5 || input.confidenceQuality < 0.4) return 'WATCH';
  return 'HEALTHY';
}
