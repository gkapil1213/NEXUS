export interface FailureMemoryRecord {
  tenantId: string;
  strategyId: string;
  environment: string;
  failurePattern: string;
  conditions: string[];
  affectedObjectives: string[];
  attemptedRemediation: string;
  result: string;
  recoveryTime: number;
  recurrenceCount: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  createdAt: string;
  correlationId: string;
}

export function createFailureMemoryRecord(
  input: Omit<FailureMemoryRecord, 'createdAt' | 'recurrenceCount'> & { recurrenceCount?: number }
): FailureMemoryRecord {
  return {
    ...input,
    recurrenceCount: input.recurrenceCount ?? 1,
    createdAt: new Date().toISOString(),
  };
}

export function shouldBlockEquivalentFailure(
  record: FailureMemoryRecord,
  environment: string,
  conditions: string[]
): boolean {
  if (record.recurrenceCount >= 2 && record.environment === environment) {
    const conditionMatch = record.conditions.every(c => conditions.includes(c));
    if (conditionMatch) return true;
  }
  return false;
}
