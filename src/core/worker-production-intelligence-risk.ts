export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface ProductionRiskInput {
  severity: string;
  blastRadius: number;
  affectedServices: number;
  customerImpact: boolean;
  deploymentCorrelated: boolean;
  reversibility: boolean;
  remediationRisk: number;
  previousRemediationFailures: number;
  circuitBreakerOpen: boolean;
}

export function assessProductionRisk(input: ProductionRiskInput): RiskLevel {
  let score = 0;
  if (input.severity === 'CRITICAL') score += 3;
  else if (input.severity === 'DEGRADED') score += 1;
  score += input.blastRadius > 0.5 ? 2 : 0;
  score += input.affectedServices > 3 ? 2 : 0;
  score += input.customerImpact ? 2 : 0;
  score += input.deploymentCorrelated ? 1 : 0;
  score += input.reversibility ? 0 : 3;
  score += input.remediationRisk;
  score += input.previousRemediationFailures;
  score += input.circuitBreakerOpen ? 3 : 0;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  if (score >= 0) return 'LOW';
  return 'UNKNOWN';
}
