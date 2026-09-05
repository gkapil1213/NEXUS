export type ExecutionHealth = 'HEALTHY' | 'WARNING' | 'DEVIATION' | 'DRIFT' | 'REGRESSION' | 'CRITICAL';

export interface MonitorInput {
  expectedOutcome: Record<string, number>;
  observedOutcome: Record<string, number>;
  errorRate: number;
  resourceUsage: number;
  budgetConsumption: number;
  policyViolation: boolean;
  driftDetected: boolean;
  unexpectedBehavior: boolean;
}

export function evaluateExecutionHealth(input: MonitorInput): ExecutionHealth {
  if (input.policyViolation || input.errorRate > 0.2 || input.budgetConsumption > 1) return 'CRITICAL';
  if (input.driftDetected) return 'DRIFT';
  if (input.unexpectedBehavior || input.errorRate > 0.1) return 'DEVIATION';
  const delta = averageDelta(input.expectedOutcome, input.observedOutcome);
  if (delta < -0.05) return 'REGRESSION';
  if (delta < -0.01) return 'WARNING';
  return 'HEALTHY';
}

function averageDelta(expected: Record<string, number>, observed: Record<string, number>): number {
  const keys = Object.keys(expected);
  let total = 0;
  let count = 0;
  for (const key of keys) {
    if (expected[key] === 0) continue;
    total += (observed[key] ?? 0 - expected[key]) / expected[key];
    count++;
  }
  return count > 0 ? total / count : 0;
}