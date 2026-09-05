export interface ImpactAssessment {
  customerImpact: boolean;
  serviceImpact: number;
  infrastructureImpact: number;
  dependencyImpact: number;
  dataImpact: number;
  securityImpact: number;
  overall: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function assessImpact(input: { customerImpact: boolean; affectedServices: number; severity: string; securityImpact: boolean }): ImpactAssessment {
  let score = 0;
  if (input.customerImpact) score += 3;
  score += Math.min(input.affectedServices, 5);
  if (input.severity === 'P1') score += 3;
  else if (input.severity === 'P2') score += 2;
  if (input.securityImpact) score += 3;
  const overall = score >= 8 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { customerImpact: input.customerImpact, serviceImpact: input.affectedServices, infrastructureImpact: 0, dependencyImpact: 0, dataImpact: 0, securityImpact: input.securityImpact ? 1 : 0, overall };
}
