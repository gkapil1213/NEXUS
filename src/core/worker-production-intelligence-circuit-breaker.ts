export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface RemediationCircuitBreakerState {
  failureCount: number;
  threshold: number;
  lastFailure?: string;
  target?: string;
  state: CircuitState;
}

export function evaluateRemediationCircuitBreaker(failureCount: number, threshold: number): CircuitState {
  return failureCount >= threshold ? 'OPEN' : 'CLOSED';
}
