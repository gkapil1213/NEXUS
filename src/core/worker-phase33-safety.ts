export interface SafetyInput {
  resourceProtection: boolean;
  environmentProtection: boolean;
  dependencyRisk: boolean;
  blastRadiusAcceptable: boolean;
  rollbackAvailable: boolean;
  providerAvailable: boolean;
  policyAllows: boolean;
  approvalValid: boolean;
  circuitBreakerAllows: boolean;
  freezeActive: boolean;
}

export function evaluateSafety(input: SafetyInput): { allowed: boolean; reason: string } {
  if (input.resourceProtection || input.environmentProtection) return { allowed: false, reason: 'protected resource/environment' };
  if (input.freezeActive) return { allowed: false, reason: 'freeze active' };
  if (!input.blastRadiusAcceptable) return { allowed: false, reason: 'blast radius too high' };
  if (!input.rollbackAvailable) return { allowed: false, reason: 'rollback unavailable' };
  if (!input.providerAvailable) return { allowed: false, reason: 'provider unavailable' };
  if (!input.policyAllows || !input.approvalValid) return { allowed: false, reason: 'policy/approval invalid' };
  if (!input.circuitBreakerAllows) return { allowed: false, reason: 'circuit breaker open' };
  return { allowed: true, reason: 'OK' };
}
