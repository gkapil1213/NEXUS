export type PolicyDecision = 'ALLOW' | 'DENY' | 'REVIEW_REQUIRED' | 'UNKNOWN';

export interface SecurityPolicyInput {
  secretExposure: boolean;
  authenticationValid: boolean;
  authorizationValid: boolean;
  dependencyRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  deploymentSecurity: boolean;
  environmentExposure: boolean;
  configurationValid: boolean;
  artifactIntegrity: boolean;
  runtimeSecurity: boolean;
  remediationPermission: boolean;
}

export function evaluateSecurityPolicy(input: SecurityPolicyInput): PolicyDecision {
  if (input.secretExposure || !input.authenticationValid || !input.authorizationValid) return 'DENY';
  if (!input.configurationValid || !input.artifactIntegrity) return 'DENY';
  if (input.dependencyRisk === 'CRITICAL') return 'DENY';
  if (input.dependencyRisk === 'HIGH' || input.dependencyRisk === 'UNKNOWN') return 'REVIEW_REQUIRED';
  if (!input.deploymentSecurity || input.environmentExposure || !input.runtimeSecurity) return 'REVIEW_REQUIRED';
  if (!input.remediationPermission) return 'DENY';
  return 'ALLOW';
}
