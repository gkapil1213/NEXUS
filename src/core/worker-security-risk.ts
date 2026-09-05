export type SecurityRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface SecurityRiskInput {
  severity: string;
  confidence: number;
  assetCriticality: number;
  exposure: number;
  blastRadius: number;
  exploitability: number; // only if actually known; otherwise 0
  deploymentContext: boolean;
  runtimeImpact: number;
  remediationReversibility: boolean;
  evidenceQuality: number;
  repeatedFailures: number;
  activeIncidents: number;
}

export function assessSecurityRisk(input: SecurityRiskInput): SecurityRiskLevel {
  let score = 0;
  if (input.severity === 'CRITICAL') score += 3;
  else if (input.severity === 'HIGH') score += 2;
  else if (input.severity === 'MEDIUM') score += 1;
  score += input.assetCriticality * 2;
  score += input.exposure * 2;
  score += input.blastRadius * 2;
  score += input.exploitability * 2;
  score += input.runtimeImpact;
  if (!input.remediationReversibility) score += 2;
  score += (1 - input.evidenceQuality) * 2;
  score += input.repeatedFailures;
  score += input.activeIncidents;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  if (score >= 0) return 'LOW';
  return 'UNKNOWN';
}
