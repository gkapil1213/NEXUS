export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerInput {
  repeatedDeploymentFailures: number;
  repeatedRollbacks: number;
  repeatedRemediations: number;
  repeatedConfigMutations: number;
  repeatedIncidentRecoveries: number;
  excessiveResourceChanges: number;
  thresholds: {
    maxDeploymentFailures: number;
    maxRollbacks: number;
    maxRemediations: number;
    maxConfigMutations: number;
    maxIncidentRecoveries: number;
    maxResourceChanges: number;
  };
}

export function evaluateCircuitBreaker(input: CircuitBreakerInput): CircuitState {
  if (
    input.repeatedDeploymentFailures >= input.thresholds.maxDeploymentFailures ||
    input.repeatedRollbacks >= input.thresholds.maxRollbacks ||
    input.repeatedRemediations >= input.thresholds.maxRemediations ||
    input.repeatedConfigMutations >= input.thresholds.maxConfigMutations ||
    input.repeatedIncidentRecoveries >= input.thresholds.maxIncidentRecoveries ||
    input.excessiveResourceChanges >= input.thresholds.maxResourceChanges
  ) {
    return 'OPEN';
  }
  return 'CLOSED';
}
