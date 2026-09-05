export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export function evaluateFleetCircuitBreaker(failureCount: number, threshold: number): CircuitState {
  return failureCount >= threshold ? 'OPEN' : 'CLOSED';
}
