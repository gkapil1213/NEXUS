export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SecurityCircuitBreakerState {
  failureCount: number;
  threshold: number;
  lastFailure?: string;
  target?: string;
  state: CircuitState;
}

export function evaluateSecurityCircuitBreaker(failureCount: number, threshold: number): CircuitState {
  return failureCount >= threshold ? 'OPEN' : 'CLOSED';
}
