export type FailureClassification = 'RETRYABLE' | 'NON_RETRYABLE' | 'UNKNOWN' | 'PROVIDER_UNAVAILABLE';

export interface RecoveryInput {
  timeout: boolean;
  providerInterrupted: boolean;
  processRestarted: boolean;
  partialDeployment: boolean;
  healthDegraded: boolean;
  verificationFailed: boolean;
  rolloutStalled: boolean;
  dependencyOutage: boolean;
}

export function classifyFailure(input: RecoveryInput): FailureClassification {
  if (input.providerInterrupted || input.dependencyOutage) return 'PROVIDER_UNAVAILABLE';
  if (input.timeout || input.partialDeployment || input.processRestarted) return 'RETRYABLE';
  if (input.healthDegraded || input.verificationFailed || input.rolloutStalled) return 'NON_RETRYABLE';
  return 'UNKNOWN';
}
