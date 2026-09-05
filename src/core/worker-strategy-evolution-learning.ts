export type EvolutionLearningConfidence = 'INSUFFICIENT_DATA' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | 'UNKNOWN';

export interface EvolutionLearningRecord {
  tenantId: string;
  strategyId: string;
  generationId: string;
  candidateId?: string;
  outcome: string;
  evidence: string[];
  failureReason?: string;
  successfulConditions?: string[];
  confidence: EvolutionLearningConfidence;
  createdAt: string;
  correlationId: string;
}

export function createEvolutionLearningRecord(
  input: Omit<EvolutionLearningRecord, 'createdAt'>
): EvolutionLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
