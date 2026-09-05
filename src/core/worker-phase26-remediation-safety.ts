export interface RemediationSafetyInput {
  authorizationMissing: boolean;
  evidenceMissing: boolean;
  healthUnknown: boolean;
  providerUnavailable: boolean;
  rollbackUnavailableForHighRisk: boolean;
  circuitBreakerOpen: boolean;
  productionFreeze: boolean;
  blastRadiusExceeded: boolean;
  actionUnrecognized: boolean;
  idempotencyNotGuaranteed: boolean;
}

export function evaluateRemediationSafety(input: RemediationSafetyInput): { allowed: boolean; reason: string } {
  if (input.authorizationMissing) return { allowed: false, reason: 'authorization missing' };
  if (input.evidenceMissing) return { allowed: false, reason: 'evidence missing' };
  if (input.healthUnknown) return { allowed: false, reason: 'health unknown' };
  if (input.providerUnavailable) return { allowed: false, reason: 'provider unavailable' };
  if (input.rollbackUnavailableForHighRisk) return { allowed: false, reason: 'rollback unavailable' };
  if (input.circuitBreakerOpen) return { allowed: false, reason: 'circuit breaker open' };
  if (input.productionFreeze) return { allowed: false, reason: 'production freeze' };
  if (input.blastRadiusExceeded) return { allowed: false, reason: 'blast radius exceeded' };
  if (input.actionUnrecognized) return { allowed: false, reason: 'action unrecognized' };
  if (input.idempotencyNotGuaranteed) return { allowed: false, reason: 'idempotency not guaranteed' };
  return { allowed: true, reason: 'OK' };
}
