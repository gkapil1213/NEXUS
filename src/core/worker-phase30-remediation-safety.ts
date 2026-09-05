export interface RemediationSafetyInput {
  targetExists: boolean;
  targetEligible: boolean;
  targetProtected: boolean;
  operationAuthorized: boolean;
  dependenciesKnown: boolean;
  rollbackExists: boolean;
  blastRadiusAcceptable: boolean;
  circuitBreakerAllows: boolean;
  governancePermits: boolean;
}

export function evaluateRemediationSafety(input: RemediationSafetyInput): { allowed: boolean; reason: string } {
  if (!input.targetExists) return { allowed: false, reason: 'target missing' };
  if (!input.targetEligible) return { allowed: false, reason: 'target ineligible' };
  if (input.targetProtected) return { allowed: false, reason: 'target protected' };
  if (!input.operationAuthorized) return { allowed: false, reason: 'unauthorized' };
  if (!input.dependenciesKnown) return { allowed: false, reason: 'dependencies unknown' };
  if (!input.rollbackExists) return { allowed: false, reason: 'rollback missing' };
  if (!input.blastRadiusAcceptable) return { allowed: false, reason: 'blast radius too high' };
  if (!input.circuitBreakerAllows) return { allowed: false, reason: 'circuit breaker open' };
  if (!input.governancePermits) return { allowed: false, reason: 'governance denies' };
  return { allowed: true, reason: 'OK' };
}
