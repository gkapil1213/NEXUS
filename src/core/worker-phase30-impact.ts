export interface ImpactInput {
  affectedServices: number;
  affectedApplications: number;
  affectedEnvironments: number;
  customerImpact: boolean;
  criticality: string;
  blastRadius: number;
}

export function analyzeImpact(input: ImpactInput): { impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; explanation: string } {
  let score = 0;
  score += input.affectedServices;
  score += input.affectedApplications;
  score += input.affectedEnvironments;
  score += input.customerImpact ? 3 : 0;
  if (input.criticality === 'CRITICAL') score += 3;
  else if (input.criticality === 'HIGH') score += 2;
  score += input.blastRadius;
  const impact = score >= 8 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { impact, explanation: `score ${score}` };
}
