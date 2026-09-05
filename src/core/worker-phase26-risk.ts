export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskInput {
  incidentSeverity: string;
  blastRadius: number;
  confidence: number;
  healthState: string;
  sloState: string;
  deploymentCorrelated: boolean;
  dependencyUncertainty: number;
  providerAvailable: boolean;
  historicalFailure: boolean;
}

export function assessRisk(input: RiskInput): RiskLevel {
  let score = 0;
  if (input.incidentSeverity === 'P1') score += 3;
  else if (input.incidentSeverity === 'P2') score += 2;
  score += input.blastRadius > 3 ? 2 : 0;
  score += (1 - input.confidence) * 2;
  if (input.healthState === 'UNHEALTHY') score += 2;
  if (input.sloState === 'SLO_BREACHED') score += 2;
  if (input.deploymentCorrelated) score += 1;
  if (input.dependencyUncertainty > 0.5) score += 1;
  if (!input.providerAvailable) score += 2;
  if (input.historicalFailure) score += 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
