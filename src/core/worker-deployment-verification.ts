export interface DeploymentVerificationInput {
  deploymentIdentityValid: boolean;
  artifactFingerprintValid: boolean;
  targetStateValid: boolean;
  runtimeHealth: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'UNAVAILABLE';
  readiness: boolean;
  smokeChecksPassed: boolean;
  criticalEndpointsHealthy: boolean;
  rolloutPolicySatisfied: boolean;
}

export function verifyDeployment(input: DeploymentVerificationInput): { verified: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.deploymentIdentityValid) reasons.push('identity invalid');
  if (!input.artifactFingerprintValid) reasons.push('artifact fingerprint invalid');
  if (!input.targetStateValid) reasons.push('target state invalid');
  if (input.runtimeHealth !== 'HEALTHY') reasons.push(`runtime health ${input.runtimeHealth}`);
  if (!input.readiness) reasons.push('not ready');
  if (!input.smokeChecksPassed) reasons.push('smoke checks failed');
  if (!input.criticalEndpointsHealthy) reasons.push('critical endpoints unhealthy');
  if (!input.rolloutPolicySatisfied) reasons.push('rollout policy violated');
  return { verified: reasons.length === 0, reasons };
}
