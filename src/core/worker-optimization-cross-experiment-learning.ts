export type LearningEvidenceType = 'OBSERVED' | 'CAUSALLY_SUPPORTED' | 'CORRELATED' | 'INSUFFICIENT_DATA' | 'CONFLICTED' | 'REGRESSED';

export interface CrossExperimentLearningRecord {
  tenantId: string;
  strategy: string;
  objectiveImpacts: Record<string, number>;
  evidenceType: LearningEvidenceType;
  experimentIds: string[];
  correlationId: string;
  timestamp: string;
}

export function createCrossExperimentLearningRecord(
  input: Omit<CrossExperimentLearningRecord, 'timestamp'>
): CrossExperimentLearningRecord {
  return {
    ...input,
    timestamp: new Date().toISOString(),
  };
}
