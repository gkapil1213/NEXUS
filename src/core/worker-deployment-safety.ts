export type DeploymentSafetyDecision = 'ALLOW' | 'DENY' | 'HOLD';

export interface DeploymentSafetyInput {
  targetValid: boolean;
  rollbackAvailable: boolean;
  targetHealthy: boolean;
  rolloutStrategyValid: boolean;
  conflictingDeployment: boolean;
  blastRadiusAcceptable: boolean;
  circuitBreakerOpen: boolean;
  evidenceSufficient: boolean;
  artifactValid: boolean;
  releaseValid: boolean;
  approvalGranted: boolean;
}

export function evaluateDeploymentSafety(input: DeploymentSafetyInput): DeploymentSafetyDecision {
  if (!input.targetValid || !input.rollbackAvailable || !input.artifactValid || !input.releaseValid) return 'DENY';
  if (!input.targetHealthy || !input.rolloutStrategyValid || input.conflictingDeployment || !input.blastRadiusAcceptable || input.circuitBreakerOpen || !input.approvalGranted) return 'DENY';
  if (!input.evidenceSufficient) return 'HOLD';
  return 'ALLOW';
}
