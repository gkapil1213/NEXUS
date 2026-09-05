export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export function evaluateAccessCircuitBreaker(failureCount: number, threshold: number): CircuitState {
  return failureCount >= threshold ? 'OPEN' : 'CLOSED';
}
