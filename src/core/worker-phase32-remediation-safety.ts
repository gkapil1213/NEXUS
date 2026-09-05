export interface GovernanceRemediationSafetyInput {
  targetExists: boolean;
  targetProtected: boolean;
  operationAuthorized: boolean;
  rollbackExists: boolean;
  blastRadiusAcceptable: boolean;
  circuitBreakerAllows: boolean;
  governancePermits: boolean;
}

export function evaluateGovernanceRemediationSafety(input: GovernanceRemediationSafetyInput): { allowed: boolean; reason: string } {
  if (!input.targetExists) return { allowed: false, reason: 'target missing' };
  if (input.targetProtected) return { allowed: false, reason: 'protected target' };
  if (!input.operationAuthorized) return { allowed: false, reason: 'unauthorized' };
  if (!input.rollbackExists) return { allowed: false, reason: 'rollback missing' };
  if (!input.blastRadiusAcceptable) return { allowed: false, reason: 'blast radius too high' };
  if (!input.circuitBreakerAllows) return { allowed: false, reason: 'circuit breaker open' };
  if (!input.governancePermits) return { allowed: false, reason: 'governance denies' };
  return { allowed: true, reason: 'OK' };
}
