export interface ExecutionMonitorInput {
  latencyMs: number;
  failureRate: number;
  partialCompletionRate: number;
  resourceUsage: number;
  strategyEffectiveness: number;
  portfolioHealth: number;
  driftDetected: boolean;
  degradationDetected: boolean;
  unexpectedBehavior: boolean;
}

export function evaluateExecutionMonitor(input: ExecutionMonitorInput): { healthy: boolean; reason: string } {
  if (input.unexpectedBehavior) return { healthy: false, reason: 'unexpected behavior' };
  if (input.failureRate > 0.2 || input.latencyMs > 5000) return { healthy: false, reason: 'high failure/latency' };
  if (input.resourceUsage > 0.9) return { healthy: false, reason: 'resource overuse' };
  if (input.driftDetected || input.degradationDetected) return { healthy: false, reason: 'drift/degradation' };
  return { healthy: true, reason: 'OK' };
}
