export interface CrossLineageLearningRecord {
  tenantId: string;
  sourceLineageIds: string[];
  reusableCharacteristics: string[];
  repeatedFailurePatterns: string[];
  commonRegressions: string[];
  complementaryStrategies: string[];
  transferableImprovements: string[];
  recommendation: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  createdAt: string;
  correlationId: string;
}

export function createCrossLineageLearningRecord(
  input: Omit<CrossLineageLearningRecord, 'createdAt' | 'recommendation'>
): CrossLineageLearningRecord {
  return {
    ...input,
    recommendation: input.transferableImprovements.join('; ') || 'none',
    createdAt: new Date().toISOString(),
  };
}
