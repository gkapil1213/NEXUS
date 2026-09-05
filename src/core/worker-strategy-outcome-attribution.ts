export type AttributionClassification = 'DIRECT' | 'PARTIAL' | 'INDIRECT' | 'CONFOUNDED' | 'UNKNOWN' | 'INSUFFICIENT';

export interface AttributionInput {
  concurrentStrategies: string[];
  overlappingExperiments: string[];
  infrastructureChanges: boolean;
  deploymentChanges: boolean;
  workloadChanges: boolean;
  externalConditions: boolean;
  baselineDrift: boolean;
  evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  temporalOrdering: boolean;
  causalConfidence: number; // 0-1
}

export function attributeOutcome(input: AttributionInput): AttributionClassification {
  if (!input.temporalOrdering || input.evidenceQuality === 'LOW') return 'INSUFFICIENT';
  if (input.concurrentStrategies.length > 0 || input.overlappingExperiments.length > 0 || input.infrastructureChanges || input.deploymentChanges || input.externalConditions) {
    return 'CONFOUNDED';
  }
  if (input.workloadChanges || input.baselineDrift) return 'PARTIAL';
  if (input.causalConfidence >= 0.7) return 'DIRECT';
  if (input.causalConfidence >= 0.4) return 'INDIRECT';
  return 'UNKNOWN';
}
