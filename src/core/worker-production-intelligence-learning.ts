export interface ProductionLearningRecord {
  tenantId: string;
  incidentId: string;
  hypothesisId: string;
  remediationId: string;
  outcome: string;
  failureClassification: string;
  confidence: number;
  evidence: string[];
  durationMs: number;
  createdAt: string;
  correlationId: string;
}

export function createProductionLearningRecord(
  input: Omit<ProductionLearningRecord, 'createdAt'>
): ProductionLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
