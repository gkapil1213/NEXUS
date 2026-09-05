export interface InfrastructureImpactInput {
  affectedResources: number;
  dependentResources: number;
  affectedWorkloads: number;
  availabilityImpact: number;
  costImpact: number;
  securityImpact: number;
  dataImpact: number;
}

export function analyzeInfrastructureImpact(input: InfrastructureImpactInput): { impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; explanation: string } {
  let score = 0;
  score += input.affectedResources > 2 ? 2 : 0;
  score += input.dependentResources > 3 ? 2 : 0;
  score += input.availabilityImpact * 2;
  score += input.securityImpact * 2;
  score += input.dataImpact;
  const impact = score >= 8 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { impact, explanation: `score ${score}` };
}
