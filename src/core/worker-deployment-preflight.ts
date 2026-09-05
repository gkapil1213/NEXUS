export interface PreflightInput {
  releaseExists: boolean;
  releaseApproved: boolean;
  artifactExists: boolean;
  artifactIntegrityValid: boolean;
  artifactFingerprintValid: boolean;
  targetExists: boolean;
  targetAvailable: boolean;
  targetCapabilitiesMet: boolean;
  requiredCredentialsExist: boolean;
  deploymentAdapterAvailable: boolean;
  rolloutStrategyValid: boolean;
  rollbackCapabilityExists: boolean;
  healthChecksConfigured: boolean;
  governanceApproved: boolean;
  safetyApproved: boolean;
  environmentPolicySatisfied: boolean;
  deploymentLockAcquired: boolean;
  idempotencyCheckPassed: boolean;
  riskPolicySatisfied: boolean;
  timeoutPolicyValid: boolean;
}

export function runDeploymentPreflight(input: PreflightInput): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.releaseExists) reasons.push('release missing');
  if (!input.releaseApproved) reasons.push('release not approved');
  if (!input.artifactExists) reasons.push('artifact missing');
  if (!input.artifactIntegrityValid) reasons.push('artifact integrity invalid');
  if (!input.artifactFingerprintValid) reasons.push('artifact fingerprint invalid');
  if (!input.targetExists) reasons.push('target missing');
  if (!input.targetAvailable) reasons.push('target unavailable');
  if (!input.targetCapabilitiesMet) reasons.push('target capabilities not met');
  if (!input.requiredCredentialsExist) reasons.push('credentials missing');
  if (!input.deploymentAdapterAvailable) reasons.push('deployment adapter unavailable');
  if (!input.rolloutStrategyValid) reasons.push('rollout strategy invalid');
  if (!input.rollbackCapabilityExists) reasons.push('rollback capability missing');
  if (!input.healthChecksConfigured) reasons.push('health checks not configured');
  if (!input.governanceApproved) reasons.push('governance not approved');
  if (!input.safetyApproved) reasons.push('safety not approved');
  if (!input.environmentPolicySatisfied) reasons.push('environment policy not satisfied');
  if (!input.deploymentLockAcquired) reasons.push('deployment lock not acquired');
  if (!input.idempotencyCheckPassed) reasons.push('idempotency check failed');
  if (!input.riskPolicySatisfied) reasons.push('risk policy not satisfied');
  if (!input.timeoutPolicyValid) reasons.push('timeout policy invalid');
  return { passed: reasons.length === 0, reasons };
}
