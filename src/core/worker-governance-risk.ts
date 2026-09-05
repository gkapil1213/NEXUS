export type GovernanceRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface GovernanceRiskInput {
  action: string;
  target: string;
  environment: string;
  securitySeverity: string;
  blastRadius: number;
  reversibility: boolean;
  previousFailures: number;
}

export function classifyGovernanceRisk(input: GovernanceRiskInput): GovernanceRiskLevel {
  let score = 0;
  if (input.action.includes('deploy') || input.action.includes('delete') || input.action.includes('revoke')) score += 1;
  if (input.environment === 'production') score += 1;
  if (input.securitySeverity === 'CRITICAL' || input.securitySeverity === 'HIGH') score += 2;
  score += input.blastRadius > 0.5 ? 2 : 0;
  score += input.reversibility ? 0 : 2;
  score += input.previousFailures;
  if (score >= 5) return 'CRITICAL';
  if (score >= 3) return 'HIGH';
  if (score >= 1) return 'MEDIUM';
  return 'LOW';
}
