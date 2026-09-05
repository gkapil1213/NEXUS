export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerInput {
  failureCount: number;
  threshold: number;
  lastFailureTime?: string;
  recoveryTimeoutMs: number;
}

export function evaluateCircuitBreaker(input: CircuitBreakerInput): CircuitState {
  if (input.failureCount >= input.threshold) return 'OPEN';
  return 'CLOSED';
}
