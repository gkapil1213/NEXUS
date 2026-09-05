export interface ExecutionLearningRecord {
  tenantId: string;
  portfolioId: string;
  executionId: string;
  outcome: string;
  evidence: string[];
  confidence: number;
  createdAt: string;
  correlationId: string;
}

export function createExecutionLearningRecord(
  input: Omit<ExecutionLearningRecord, 'createdAt'>
): ExecutionLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
