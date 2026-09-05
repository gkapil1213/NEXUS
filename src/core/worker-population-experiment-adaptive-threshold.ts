export interface AdaptiveThresholdInput {
  baseThreshold: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  championStatus: boolean;
  rolloutScope: 'SHADOW' | 'LIMITED' | 'EXPANDED' | 'FULL';
  historicalFailureCount: number;
  populationImportance: 'LOW' | 'MEDIUM' | 'HIGH';
}

export function calculateAdaptiveEvidenceThreshold(input: AdaptiveThresholdInput): number {
  let threshold = input.baseThreshold;
  if (input.riskLevel === 'CRITICAL' || input.riskLevel === 'UNKNOWN') threshold *= 1.5;
  else if (input.riskLevel === 'HIGH') threshold *= 1.2;
  if (input.championStatus) threshold *= 1.3;
  if (input.rolloutScope === 'FULL') threshold *= 1.2;
  if (input.historicalFailureCount > 3) threshold *= 1.2;
  if (input.populationImportance === 'HIGH') threshold *= 1.2;
  return Math.min(threshold, 1.0);
}
