export interface MetaLearningRecord {
  tenantId: string;
  methodId: string;
  metaExperimentId: string;
  outcome: string;
  evidence: string[];
  confidence: number;
  createdAt: string;
  correlationId: string;
}

export function createMetaLearningRecord(
  input: Omit<MetaLearningRecord, 'createdAt'>
): MetaLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
