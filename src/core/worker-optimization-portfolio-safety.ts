export type SafetyDecision = 'ALLOW' | 'DENY' | 'DEFER' | 'OBSERVE_ONLY';

export interface PortfolioSafetyInput {
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  activeCriticalIncident: boolean;
  productionFreeze: boolean;
  staleTelemetry: boolean;
  dependencyFailure: boolean;
  excessiveBlastRadius: boolean;
  insufficientEvidence: boolean;
  securityViolation: boolean;
}

export function evaluatePortfolioSafety(input: PortfolioSafetyInput): SafetyDecision {
  if (input.securityViolation || input.activeCriticalIncident || input.productionFreeze) return 'DENY';
  if (input.risk === 'CRITICAL' || input.risk === 'UNKNOWN') return 'DENY';
  if (input.staleTelemetry || input.insufficientEvidence || input.dependencyFailure) return 'DEFER';
  if (input.excessiveBlastRadius) return 'OBSERVE_ONLY';
  return 'ALLOW';
}
