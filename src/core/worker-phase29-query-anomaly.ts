export type QueryAnomalyType = 'LATENCY_SPIKE' | 'ERROR_SPIKE' | 'EXECUTION_SPIKE' | 'ROW_EXPLOSION' | 'RESOURCE_PRESSURE' | 'UNKNOWN';

export function detectQueryAnomaly(obs: { duration: number; errorCount: number; executionCount: number; rowsExamined: number }, baselines: { duration: number; errorCount: number; executionCount: number; rowsExamined: number }): QueryAnomalyType {
  if (obs.duration > baselines.duration * 2) return 'LATENCY_SPIKE';
  if (obs.errorCount > baselines.errorCount * 2) return 'ERROR_SPIKE';
  if (obs.executionCount > baselines.executionCount * 2) return 'EXECUTION_SPIKE';
  if (obs.rowsExamined > baselines.rowsExamined * 2) return 'ROW_EXPLOSION';
  return 'UNKNOWN';
}
