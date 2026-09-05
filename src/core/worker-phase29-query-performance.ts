export interface QueryObservation {
  observationId: string;
  resourceId: string;
  queryFingerprint: string;
  duration: number;
  executionCount: number;
  errorCount: number;
  rowsExamined: number;
  rowsReturned: number;
  timestamp: string;
}

export function createQueryObservation(input: Omit<QueryObservation, 'observationId' | 'timestamp'>): QueryObservation {
  return { observationId: `q-${Date.now()}`, ...input, timestamp: new Date().toISOString() };
}

export function detectSlowQuery(obs: QueryObservation, thresholdMs: number): boolean {
  return obs.duration > thresholdMs;
}
