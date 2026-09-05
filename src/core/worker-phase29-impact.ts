export interface ImpactInput {
  affectedResources: number;
  affectedSchemas: number;
  affectedTables: number;
  customerImpact: boolean;
  availabilityImpact: number;
  consistencyImpact: number;
  rollbackDifficulty: number;
}

export function analyzeImpact(input: ImpactInput): { impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; explanation: string } {
  let score = 0;
  score += input.affectedResources * 1;
  score += input.affectedTables;
  score += input.customerImpact ? 2 : 0;
  score += input.availabilityImpact * 2;
  score += input.consistencyImpact * 2;
  score += input.rollbackDifficulty;
  const impact = score >= 8 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { impact, explanation: `score ${score}` };
}
