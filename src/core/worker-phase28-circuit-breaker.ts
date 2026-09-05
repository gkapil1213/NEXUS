export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export function evaluateInfrastructureCircuitBreaker(failureCount: number, threshold: number): CircuitState {
  return failureCount >= threshold ? 'OPEN' : 'CLOSED';
}
