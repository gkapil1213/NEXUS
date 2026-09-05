export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface GovernanceRiskInput {
  assetCriticality: string;
  environmentCriticality: string;
  securitySeverity: string;
  blastRadius: string;
  policySeverity: string;
  complianceImpact: string;
  availabilityImpact: number;
  dataSensitivity: number;
  changeMagnitude: string;
  deploymentScope: string;
  rollbackDifficulty: number;
  unknownState: boolean;
}

export function assessGovernanceRisk(input: GovernanceRiskInput): RiskLevel {
  if (input.unknownState) return 'UNKNOWN';
  let score = 0;
  if (input.assetCriticality === 'CRITICAL') score += 3;
  if (input.environmentCriticality === 'CRITICAL') score += 3;
  if (input.securitySeverity === 'CRITICAL') score += 3;
  if (input.blastRadius === 'CRITICAL') score += 3;
  if (input.policySeverity === 'CRITICAL') score += 2;
  if (input.complianceImpact === 'CRITICAL') score += 2;
  score += input.availabilityImpact * 2;
  score += input.dataSensitivity * 2;
  score += input.rollbackDifficulty;
  if (input.changeMagnitude === 'HIGH') score += 2;
  if (input.deploymentScope === 'HIGH') score += 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
