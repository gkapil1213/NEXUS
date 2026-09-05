export interface ExecutionMemoryRecord {
  tenantId: string;
  strategyId: string;
  strategyVersion: string;
  executionId: string;
  outcome: string;
  evidence: string[];
  failureReason?: string;
  successfulConditions?: string[];
  environmentalConditions: string[];
  adaptations: string[];
  rollbackInfo?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  recurrence: number;
  createdAt: string;
  correlationId: string;
}

export function createExecutionMemoryRecord(
  input: Omit<ExecutionMemoryRecord, 'createdAt' | 'recurrence'> & { recurrence?: number }
): ExecutionMemoryRecord {
  return {
    ...input,
    recurrence: input.recurrence ?? 1,
    createdAt: new Date().toISOString(),
  };
}